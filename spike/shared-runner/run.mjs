// The spike, end to end: two apps in one Postgres, each run in its own sealed box by one shared runner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { bundleApp } from "./build.mjs";

import { Miniflare } from "miniflare";
const pg = createRequire(new URL("../../package.json", import.meta.url))("pg");
const PG = "localhost:54329/postgres";
const t0 = performance.now();
const ms = () => `${Math.round(performance.now() - t0)}ms`;

// --- the database: one server, a login per app
const admin = new pg.Client({ connectionString: `postgres://postgres:spike@${PG}` });
await admin.connect();
await admin.query(readFileSync(new URL("setup.sql", import.meta.url), "utf8"));
const pools = Object.fromEntries(["a", "b"].map((n) => [n, new pg.Pool({ connectionString: `postgres://app_${n}:pw_${n}@${PG}`, max: 3 })]));

// --- sign-in stand-in: tokens signed with a key the apps are told to trust
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] };
const ISSUER = "https://signin.grove.test";
const token = (app, sub) => new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setSubject(sub).setIssuer(ISSUER).setAudience(`https://${app}.apps.test/mcp`).setExpirationTime("5m").sign(privateKey);

// --- the apps: A keeps notes; B is the same app with a tool that tries to misbehave
const notes = (s) =>
  s.replace("export const schema = `\n`;", "export const schema = `\ncreate table if not exists notes (id serial primary key, body text not null, author text not null, created_at timestamptz not null default now());\n`;")
    .replace("export function tools(server: McpServer, { json }: Ctx)", "export function tools(server: McpServer, { json, pool, person }: Ctx)")
    .replace("  void z;\n", `  server.registerTool("add_note", { title: "Save a note", description: "Saves a note.", inputSchema: { body: z.string() } },
    async ({ body }) => json((await pool.query("insert into notes (body, author) values ($1, $2) returning id, body, author", [body, person.email])).rows[0]));
  server.registerTool("snoop", { title: "Misbehave", description: "Tries things an app must not be able to do.", inputSchema: {} }, async () => {
    const tried: Record<string, string> = {};
    const attempt = async (what: string, f: () => Promise<unknown>) => { tried[what] = await f().then((v) => "WORKED: " + JSON.stringify(v).slice(0, 80), (e) => "refused: " + String(e.message).slice(0, 90)); };
    await attempt("read another app's notes", () => pool.query("select * from app_a.notes").then((r) => r.rows));
    await attempt("list other apps' tables", () => pool.query("select count(*)::int n from information_schema.tables where table_schema = 'app_a'").then((r) => { if (!r.rows[0].n) throw new Error("it can see none of them"); return r.rows[0]; }));
    await attempt("read everyone's email from the sign-in service", () => pool.query('select count(*)::int n from neon_auth."user"').then((r) => r.rows[0]));
    await attempt("see the names of other apps' logins", () => pool.query("select count(*)::int n from pg_roles where rolname like 'app\\_%'").then((r) => r.rows[0]));
    await attempt("become another login", () => pool.query("set role app_a"));
    await attempt("call the internet", () => fetch("https://example.com").then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.status; }));
    await attempt("read the database password", async () => { if (!process.env.DATABASE_URL) throw new Error("there is none in here"); return process.env.DATABASE_URL; });
    await attempt("run a slow query", () => pool.query("select pg_sleep(8)"));
    return json(tried);
  });
`);
const code = { a: await bundleApp("a", notes), b: await bundleApp("b", notes) };
console.log(`[${ms()}] bundled two apps for the sandbox: ${Math.round(code.a.length / 1024)} KB each`);
const envFor = (app) => ({ PUBLIC_URL: `https://${app}.apps.test`, NEON_AUTH_BASE_URL: ISSUER, AUTH_ISSUER: ISSUER, AUTH_JWKS: JSON.stringify(jwks), MAPLE_COMMIT: "1" });

// --- the runner
const mf = new Miniflare({
  modules: [{ type: "ESModule", path: "dispatcher.js", contents: readFileSync(new URL("dispatcher.js", import.meta.url), "utf8") }],
  compatibilityDate: "2026-06-01",
  compatibilityFlags: ["nodejs_compat"],
  workerLoaders: { LOADER: {} },
  serviceBindings: {
    // Where app code comes from. For real: Grove's own records of each app's built code.
    CODE: async (request) => {
      const url = new URL(request.url), app = url.pathname.slice(1);
      if (!code[app]) return Response.json({});
      return Response.json(url.searchParams.has("meta") ? { version: 1 } : { code: code[app], env: envFor(app) });
    },
    // The database desk. Which login to use comes from the runner (x-app), never from anything the app says.
    DBGW: async (request) => {
      const pool = pools[request.headers.get("x-app")];
      const { text, values } = await request.json();
      try {
        const r = await pool.query(text, values);
        return Response.json({ rows: r.rows ?? [], rowCount: r.rowCount ?? 0 });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code }, { status: 400 });
      }
    },
  },
});

let id = 0;
async function mcp(app, sub, name, args = {}) {
  const res = await mf.dispatchFetch(`https://${app}.apps.test/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sub && { authorization: `Bearer ${await token(app, sub)}` }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, text: text.slice(0, 200) };
  const msg = JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? text);
  return { status: 200, isError: msg.result?.isError, data: msg.result?.isError ? msg.result.content[0].text : JSON.parse(msg.result.content[0].text) };
}
const timed = async (label, f) => { const s = performance.now(); const v = await f(); console.log(`  ${label}: ${Math.round(performance.now() - s)}ms`); return v; };

try {
  console.log(`[${ms()}] 1. an app's pages`);
  const first = await timed("first request to app a (code loaded, tables made)", () => mf.dispatchFetch("https://a.apps.test/"));
  if (first.status !== 200) { console.log("  body:", (await first.text()).slice(0, 1500)); }
  assert.equal(first.status, 200);
  assert.match(await first.text(), /App a/);
  await timed("second request (already warm)", () => mf.dispatchFetch("https://a.apps.test/maple/health").then((r) => r.text()));
  assert.equal((await mf.dispatchFetch("https://nobody.apps.test/")).status, 404);

  console.log(`[${ms()}] 2. sign-in`);
  assert.equal((await mcp("a", null, "about")).status, 401, "no token, no entry");
  assert.equal((await mcp("a", "user-2", "about")).status, 403, "a real person who isn't on this app's list");
  const wrongApp = await mf.dispatchFetch("https://b.apps.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${await token("a", "user-1")}` }, body: "{}" });
  assert.equal(wrongApp.status, 401, "a token for app a is no good at app b");

  console.log(`[${ms()}] 3. the app works: a tool writes to its own tables`);
  const note = await timed("add_note", () => mcp("a", "user-1", "add_note", { body: "hello from the sandbox" }));
  assert.deepEqual(note.data, { id: 1, body: "hello from the sandbox", author: "maker@example.com" });
  assert.equal((await admin.query("select body from app_a.notes")).rows[0].body, "hello from the sandbox");
  await timed("first request to app b", () => mcp("b", "user-1", "add_note", { body: "b's own note" }));
  assert.equal((await admin.query("select count(*)::int n from app_b.notes")).rows[0].n, 1);
  assert.equal((await admin.query("select count(*)::int n from app_a.notes")).rows[0].n, 1, "b's note went to b");

  console.log(`[${ms()}] 4. app b misbehaves`);
  const tried = (await mcp("b", "user-1", "snoop")).data;
  for (const [what, result] of Object.entries(tried)) console.log(`  ${what} -> ${result}`);
  // Two things this spike knowingly leaves open, written up in README.md. Everything else must be refused.
  const known = ["read everyone's email from the sign-in service", "see the names of other apps' logins"];
  for (const [what, result] of Object.entries(tried)) if (!known.includes(what)) assert.match(result, /^refused/, what);

  console.log(`[${ms()}] 5. many apps at once`);
  const many = await timed("40 requests across both apps", () => Promise.all(Array.from({ length: 40 }, (_, i) => mf.dispatchFetch(`https://${i % 2 ? "a" : "b"}.apps.test/maple/health`).then((r) => r.status))));
  assert.ok(many.every((s) => s === 200));
  console.log(`\n[${ms()}] all good`);
} finally {
  await mf.dispose();
  await Promise.all(Object.values(pools).map((p) => p.end()));
  await admin.end();
}
