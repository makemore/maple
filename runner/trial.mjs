// Puts one trial app on the runner, and (locally) walks the whole way through it as an assistant would.
//   node --experimental-strip-types trial.mjs provision <name> <maker-email>   needs DATABASE_URL, RUNNER_SECRET, SIGNIN_URL, APPS_DOMAIN
//   node --experimental-strip-types trial.mjs local                            needs the Docker Postgres from the spikes
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { templateFiles } from "../scripts/bundle-template.ts";
import { bundleForRunner } from "./build.mjs";

const notes = (s) =>
  s.replace("export const schema = `\n`;", "export const schema = `\ncreate table if not exists notes (id serial primary key, body text not null, author text not null, created_at timestamptz not null default now());\n`;")
    .replace("export function tools(server: McpServer, { json }: Ctx)", "export function tools(server: McpServer, { json, pool, person }: Ctx)")
    .replace("  void z;\n", `  server.registerTool("add_note", { title: "Save a note", description: "Saves a short note. Confirm the wording first.", inputSchema: { body: z.string().min(1).max(2000) } },
    async ({ body }) => json((await pool.query("insert into notes (body, author) values ($1, $2) returning id, body, author, created_at", [body, person.email])).rows[0]));
  server.registerTool("list_notes", { title: "Notes", annotations: { readOnlyHint: true }, description: "The notes saved so far, newest first.", inputSchema: {} },
    async () => json((await pool.query("select id, body, author, created_at from notes order by id desc limit 50")).rows));
`);

async function provision(slug, maker, allowed = []) {
  const { putApp } = await import("./db.mjs");
  const signin = await import("./signin.mjs");
  const { admin, SCHEMA } = await import("./db.mjs");
  await admin.query(SCHEMA);
  await signin.ready();
  const files = templateFiles();
  const title = "Runner Trial";
  files["maple.json"] = JSON.stringify({ maple: "0.1", name: slug, title, description: "A trial app on Grove's shared runner: it keeps short notes.", maker: { name: "Chris", email: maker }, auth: { method: "email-code", allowed }, mcp: { audience: "everyone" }, loop: {}, database: {} });
  files["src/app.ts"] = notes(files["src/app.ts"]);
  const code = await bundleForRunner(files);
  const put = await putApp(slug, code, { MAPLE_COMMIT: String(Date.now()) });
  await signin.addApp(slug, `https://${slug}.${process.env.APPS_DOMAIN}/mcp`, title);
  console.log(`put ${slug} v${put.version} (${Math.round(code.length / 1024)} KB), sign-in knows https://${slug}.${process.env.APPS_DOMAIN}/mcp`);
  await admin.end();
}

async function local() {
  const env = { ...process.env, DATABASE_URL: "postgres://postgres:spike@localhost:54329/postgres", RUNNER_SECRET: randomBytes(32).toString("hex"), SIGNIN_URL: "https://signin.apps.test", APPS_DOMAIN: "apps.test", EDGE_SECRET: randomBytes(16).toString("hex"), PORT: "8791", POSTMARK_TOKEN: "", SANDBOX_URL: "http://localhost:8794", SANDBOX_TOKEN: randomBytes(32).toString("hex") };
  Object.assign(process.env, env);
  // A fresh start each time: the secret above is new, and old sign-in keys were locked with the old one.
  const pg = (await import("pg")).default;
  const wipe = new pg.Client({ connectionString: env.DATABASE_URL });
  await wipe.connect();
  await wipe.query("drop schema if exists signin cascade; drop schema if exists runner cascade");
  await wipe.end();
  await provision("trial", "maker@example.com");
  // The sandbox service gets none of the desk's secrets: only where the desk is and the token the desk calls it with.
  const boxes = spawn("node", [(process.env.RUNNER_ENTRY ?? "server.mjs").replace("server.mjs", "boxes.mjs")], { env: { PATH: process.env.PATH, PORT: "8794", DESK_URL: "http://localhost:8791", SANDBOX_TOKEN: env.SANDBOX_TOKEN }, stdio: ["ignore", "inherit", "inherit"] });
  const server = spawn("node", [process.env.RUNNER_ENTRY ?? "server.mjs"], { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  server.stdout.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 100 && !out.includes("listening"); i++) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 100; i++) { if (await fetch("http://localhost:8794/runner/health").then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }
    const jar = new Map();
    const at = async (host, path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("x-forwarded-host", host);
      if (!init.outside) headers.set("x-edge-secret", env.EDGE_SECRET);
      if (init.cookies && jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      if (init.json) { headers.set("content-type", "application/json"); headers.set("origin", env.SIGNIN_URL); init.body = JSON.stringify(init.json); }
      const res = await fetch(`http://localhost:${env.PORT}${path}`, { ...init, headers, redirect: "manual" });
      if (init.cookies) for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
      return res;
    };
    const APP = "trial.apps.test", SIGN = "signin.apps.test", RESOURCE = `https://${APP}/mcp`, REDIRECT = "https://assistant.example/callback";

    assert.equal((await at(APP, "/", { outside: true })).status, 404, "nothing answers except through the front door");
    const page = await at(APP, "/");
    assert.equal(page.status, 200, `the app's page: ${page.status} ${(await page.text()).slice(0, 300)}`);
    assert.equal((await at("nobody.apps.test", "/")).status, 404);
    const unauth = await at(APP, "/mcp", { method: "POST" });
    assert.equal(unauth.status, 401);
    // An assistant finds out where to sign in from the app, then reads the sign-in service's own description.
    const prm = await (await at(APP, "/.well-known/oauth-protected-resource/mcp")).json();
    assert.deepEqual([prm.resource, prm.authorization_servers[0]], [RESOURCE, "https://signin.apps.test/api/auth"]);
    const meta = await (await at(SIGN, "/.well-known/oauth-authorization-server/api/auth")).json();
    assert.equal(meta.issuer, "https://signin.apps.test/api/auth");
    for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "jwks_uri"]) assert.ok(meta[k]?.startsWith("https://signin.apps.test/"), k);
    console.log("discovery ok:", meta.authorization_endpoint, "| challenge methods:", meta.code_challenge_methods_supported);

    const client = await (await at(SIGN, "/api/auth/oauth2/register", { method: "POST", json: { client_name: "Test assistant", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } })).json();
    const verifier = randomBytes(32).toString("base64url");
    const ask = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, scope: "openid email offline_access", state: "s1", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: RESOURCE });
    const first = await at(SIGN, `/api/auth/oauth2/authorize?${ask}`, { cookies: true });
    // A browser going to this address gets a redirect; a script like this one gets the same address as data.
    const signInAt = new URL(first.headers.get("location") ?? (await first.json()).url, env.SIGNIN_URL);
    assert.equal(signInAt.pathname, "/sign-in");
    assert.match(await (await at(SIGN, signInAt.pathname + signInAt.search)).text(), /Send me a code/);
    assert.equal((await at(SIGN, "/api/auth/email-otp/send-verification-otp", { method: "POST", cookies: true, json: { email: "maker@example.com", type: "sign-in" } })).status, 200);
    for (let i = 0; i < 50 && !/sign-in code for/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    const otp = out.match(/sign-in code for maker@example\.com: (\d{6})/)[1];
    const signedIn = await (await at(SIGN, "/api/auth/sign-in/email-otp", { method: "POST", cookies: true, json: { email: "maker@example.com", otp, oauth_query: signInAt.search.slice(1) } })).json();
    const consentAt = new URL(signedIn.url, env.SIGNIN_URL);
    assert.match(await (await at(SIGN, consentAt.pathname + consentAt.search)).text(), /wants to use <strong>Runner Trial<\/strong>/);
    const agreed = await (await at(SIGN, "/api/auth/oauth2/consent", { method: "POST", cookies: true, json: { accept: true, oauth_query: consentAt.search.slice(1) } })).json();
    const code = new URL(agreed.url).searchParams.get("code");
    const tokens = await (await at(SIGN, "/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: RESOURCE }) })).json();
    assert.ok(tokens.access_token, JSON.stringify(tokens));
    console.log("signed in and got a token for the app");

    let id = 0;
    const tool = async (name, args = {}) => {
      const res = await at(APP, "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
      const text = await res.text();
      assert.equal(res.status, 200, text.slice(0, 300));
      return JSON.parse(JSON.parse(text.split("\n").find((l) => l.startsWith("data:")).slice(5)).result.content[0].text);
    };
    const saved = await tool("add_note", { body: "the first note on the shared runner" });
    assert.equal(saved.author, "maker@example.com");
    assert.equal((await tool("list_notes"))[0].body, "the first note on the shared runner");
    console.log("the app's tools work with that token:", JSON.stringify(saved).slice(0, 120));
    console.log("\nall good");
  } finally {
    server.kill("SIGTERM");
    boxes.kill("SIGTERM");
  }
}

// The same walk-through against the deployed runner, through the public addresses. The person signing in is
// Postmark's test address, which accepts mail and throws it away; the code is read back from Postmark's own
// record of what was sent. Needs POSTMARK_TOKEN, and that address on the app's list of people.
async function live(slug, domain) {
  const TESTER = "test@blackhole.postmarkapp.com";
  const APP = `https://${slug}.${domain}`, SIGN = `https://signin.${domain}`, RESOURCE = `${APP}/mcp`, REDIRECT = "https://assistant.example/callback";
  const jar = new Map();
  const go = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookies && jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.json) { headers.set("content-type", "application/json"); headers.set("origin", SIGN); init.body = JSON.stringify(init.json); }
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (init.cookies) for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  };
  const t0 = performance.now(), step = (s) => console.log(`[${Math.round(performance.now() - t0)}ms] ${s}`);
  const page = await go(APP + "/");
  assert.equal(page.status, 200);
  step(`the app's page answers, served by ${page.headers.get("server")}`);
  const unauth = await go(RESOURCE, { method: "POST" });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  const prm = await (await go(APP + "/.well-known/oauth-protected-resource/mcp")).json();
  assert.deepEqual([prm.resource, prm.authorization_servers[0]], [RESOURCE, `${SIGN}/api/auth`]);
  const meta = await (await go(`${SIGN}/.well-known/oauth-authorization-server/api/auth`)).json();
  assert.equal(meta.issuer, `${SIGN}/api/auth`);
  step("an assistant can find where to sign in");
  const client = await (await go(meta.registration_endpoint, { method: "POST", json: { client_name: "Grove's own test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } })).json();
  assert.ok(client.client_id, JSON.stringify(client));
  const verifier = randomBytes(32).toString("base64url");
  const ask = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, scope: "openid email offline_access", state: "s1", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: RESOURCE });
  const first = await go(`${meta.authorization_endpoint}?${ask}`, { cookies: true, headers: { "sec-fetch-mode": "navigate", accept: "text/html" } });
  step(`authorize answered ${first.status}`);
  const signInAt = new URL(first.headers.get("location") ?? (await first.json()).url, SIGN);
  assert.equal(signInAt.pathname, "/sign-in");
  assert.match(await (await go(signInAt.href)).text(), /Send me a code/);
  step("registered, and sent to the sign-in page");
  const since = Date.now();
  assert.equal((await go(`${SIGN}/api/auth/email-otp/send-verification-otp`, { method: "POST", cookies: true, json: { email: TESTER, type: "sign-in" } })).status, 200);
  let otp;
  for (let i = 0; i < 30 && !otp; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const m = await (await fetch(`https://api.postmarkapp.com/messages/outbound?count=5&offset=0&recipient=${encodeURIComponent(TESTER)}`, { headers: { Accept: "application/json", "X-Postmark-Server-Token": process.env.POSTMARK_TOKEN } })).json();
    otp = (m.Messages ?? []).find((x) => new Date(x.ReceivedAt).getTime() > since - 5000 && /^\d{6} is your Grove sign-in code/.test(x.Subject))?.Subject.slice(0, 6);
  }
  assert.ok(otp, "the sign-in email went out through Postmark");
  step("the sign-in code was emailed");
  const signedIn = await (await go(`${SIGN}/api/auth/sign-in/email-otp`, { method: "POST", cookies: true, json: { email: TESTER, otp, oauth_query: signInAt.search.slice(1) } })).json();
  const consentAt = new URL(signedIn.url, SIGN);
  assert.match(await (await go(consentAt.href)).text(), /wants to use <strong>Runner Trial<\/strong>/);
  const agreed = await (await go(`${SIGN}/api/auth/oauth2/consent`, { method: "POST", cookies: true, json: { accept: true, oauth_query: consentAt.search.slice(1) } })).json();
  const tokens = await (await go(meta.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(agreed.url).searchParams.get("code"), redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: RESOURCE }) })).json();
  assert.ok(tokens.access_token, JSON.stringify(tokens));
  step("signed in, consented, and got a token for the app");
  let id = 0;
  const tool = async (name, args = {}) => {
    const s = performance.now();
    const res = await go(RESOURCE, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 300));
    console.log(`    ${name}: ${Math.round(performance.now() - s)}ms`);
    return JSON.parse(JSON.parse(text.split("\n").find((l) => l.startsWith("data:")).slice(5)).result.content[0].text);
  };
  const saved = await tool("add_note", { body: `a note saved through the deployed runner at ${new Date().toISOString()}` });
  assert.equal(saved.author, TESTER);
  assert.equal((await tool("list_notes"))[0].id, saved.id);
  step("the app's tools work with that token, and the note is in the app's own tables");
  console.log("\nall good");
}

const [mode, slug, maker, ...rest] = process.argv.slice(2);
if (mode === "provision") await provision(slug, maker, rest);
else if (mode === "live") await live(slug, maker);
else if (mode === "local") await local();
else console.log("usage: trial.mjs provision <name> <maker-email> | local");
process.exit(process.exitCode ?? 0);
