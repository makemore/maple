// End to end through Grove, the way an assistant would use it: create an app, wait until it is live,
// change its code on a change branch, wait for the preview, ship it, then roll it back.
// Run: node --env-file=.env.local scripts/e2e.ts [app-name]   (needs MAPLE_TEST_TOKEN on Grove)
import assert from "node:assert/strict";

const GROVE = process.env.GROVE_URL!;
const slug = process.argv[2] ?? `e2e-${Date.now().toString(36)}`;
let id = 0;

async function call(name: string, args: object = {}) {
  const res = await fetch(GROVE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${process.env.MAPLE_TEST_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const msg = JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
  const r = msg.result;
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
}

async function until<T>(what: string, f: () => Promise<T>, done: (v: T) => boolean, minutes = 6) {
  const end = Date.now() + minutes * 60_000;
  for (;;) {
    const v = await f();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 2000)}`);
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

const t0 = Date.now();
const step = (s: string) => console.log(`\n[${Math.round((Date.now() - t0) / 1000)}s] ${s}`);

step(`create_app ${slug}`);
console.log(await call("create_app", { name: slug, title: "E2E Notes", description: "A test app that keeps short notes for a team.", users: [] }));

step("waiting for it to go live");
const live = await until("live", () => call("app_status", { app: slug }), (s) => s.status !== "deploying");
assert.equal(live.status, "live", JSON.stringify(live));
console.log(live);
const home = await fetch(live.address);
assert.equal(home.status, 200);
assert.equal((await fetch(live.connect, { method: "POST" })).status, 401, "the connector asks for sign-in");
const meta = await (await fetch(new URL("/.well-known/oauth-protected-resource/mcp", live.address))).json();
assert.equal(meta.resource, live.connect, "OAuth resource matches the connection address");

step("write_files: add a notes feature");
const [{ content: appTs }] = (await call("read_files", { app: slug, paths: ["src/app.ts"] })).files;
assert.ok(appTs.includes("registerTool"));
const changed = appTs
  .replace("export const schema = `\n`;", "export const schema = `\ncreate table if not exists notes (id serial primary key, body text not null, author text not null, created_at timestamptz not null default now());\n`;")
  .replace("  void z;\n", `  server.registerTool(
    "add_note",
    { title: "Save a note", description: "Saves a short note. Confirm the wording first.", inputSchema: { body: z.string().min(1).max(2000) } },
    async ({ body }) => json((await pool.query("insert into notes (body, author) values ($1, $2) returning *", [body, person.email])).rows[0]),
  );
`)
  .replace("export function tools(server: McpServer, { json }: Ctx)", "export function tools(server: McpServer, { json, pool, person }: Ctx)");
assert.notEqual(changed, appTs, "the template changed shape; update this test");
console.log(await call("write_files", { app: slug, change: "add-notes", message: "Add notes", files: [{ path: "src/app.ts", content: changed }] }));

step("waiting for the preview");
const ch = await until("preview", () => call("change_status", { app: slug, change: "add-notes" }), (s) => s.status !== "checking");
assert.equal(ch.status, "ready", JSON.stringify(ch));
console.log(ch);
assert.equal((await fetch(ch.preview)).status, 200, "preview serves");

step("protected files are refused");
await assert.rejects(call("write_files", { app: slug, change: "bad", message: "x", files: [{ path: "src/maple/kit.ts", content: "" }] }), /belongs to MAPLE/);

step("ship_change");
console.log(await call("ship_change", { app: slug, change: "add-notes" }));
const shipped = await until("ship", () => call("app_status", { app: slug }), (s) => s.status !== "deploying" && s.version !== live.version);
assert.equal(shipped.status, "live", JSON.stringify(shipped));
console.log(shipped);

step("rollback");
console.log(await call("rollback", { app: slug }));
const back = await until("rollback", () => call("app_status", { app: slug }), (s) => s.status !== "deploying" && s.version !== shipped.version);
assert.equal(back.status, "live", JSON.stringify(back));

step(`done: ${slug} at ${back.address}`);
