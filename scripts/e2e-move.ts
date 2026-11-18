// End to end through Grove: an app starts on the shared runner, gets some information, and is moved to a
// database of its own. Its address and information must be the same afterwards. Then it is deleted.
// Run: npm run test:live:move   (needs MAPLE_TEST_TOKEN on Grove)
import assert from "node:assert/strict";

const GROVE = (process.env.GROVE_URL ?? process.env.PUBLIC_URL)!;
const slug = process.argv[2] ?? `e2e-move-${Date.now().toString(36)}`;
let id = 0;
async function call(name: string, args: object = {}) {
  const res = await fetch(GROVE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${process.env.MAPLE_TEST_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const msg = JSON.parse((await res.text()).split("\n").find((l) => l.startsWith("data:"))!.slice(5));
  if (msg.result.isError) throw new Error(`${name}: ${msg.result.content[0].text}`);
  return JSON.parse(msg.result.content[0].text);
}
async function until<T>(what: string, f: () => Promise<T>, done: (v: T) => boolean, minutes = 8) {
  const end = Date.now() + minutes * 60_000;
  for (;;) {
    const v = await f().catch((e) => e as T);
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 600)}`);
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
const t0 = Date.now();
const step = (s: string) => console.log(`\n[${Math.round((Date.now() - t0) / 1000)}s] ${s}`);
const things = (base: string) => fetch(base + "/things").then(async (r) => ({ status: r.status, served: r.headers.get("x-served-by") ?? "", rows: r.ok ? ((await r.json()) as any[]) : [] }));

step("waiting for a Grove that can move apps");
await until("the tool", () => fetch(GROVE + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${process.env.MAPLE_TEST_TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/list" }) }).then((r) => r.text()), (t) => String(t).includes("move_to_own_database"), 4);

step(`create_app ${slug}`);
await call("accept_terms", { agree: true }).catch(() => undefined);
await call("create_app", { name: slug, title: "E2E Mover", description: "A test: an app that moves to a database of its own.", users: [] });
const live = await until("live", () => call("app_status", { app: slug }), (s: any) => s.status === "live");

step("add a table and some information, and ship it");
const [{ content: appTs }] = (await call("read_files", { app: slug, paths: ["src/app.ts"] })).files;
const changed = appTs
  .replace("export const schema = `\n`;", "export const schema = `\ncreate table if not exists things (id serial primary key, name text not null unique, made_at timestamptz not null default now());\n`;")
  .replace("export function routes(_app: Hono, _pool: Pool, _services: Services) {}", `export function routes(app: Hono, pool: Pool, _services: Services) {
  app.post("/thing", async (c) => c.json((await pool.query("insert into things (name) values ($1) returning id, name, made_at", [c.req.query("name") ?? "x"])).rows[0]));
  app.get("/things", async (c) => c.json((await pool.query("select id, name, made_at from things order by id")).rows, 200, { "x-served-by": process.env.DATABASE_URL ? "own database" : "shared runner" }));
}`);
assert.ok(changed.includes('app.post("/thing"'), "the template changed shape; update this test");
await call("write_files", { app: slug, change: "things", message: "Things", files: [{ path: "src/app.ts", content: changed }] });
await until("preview", () => call("change_status", { app: slug, change: "things" }), (s: any) => s.status === "ready");
await call("ship_change", { app: slug, change: "things" });
await until("the shipped version", () => things(live.address), (r: any) => r.status === 200, 4);
for (const name of ["first", "second", "third"]) assert.equal((await fetch(`${live.address}/thing?name=${name}`, { method: "POST" })).status, 200);
const before = await things(live.address);
console.log(before);
assert.equal(before.served, "shared runner");
assert.equal(before.rows.length, 3);

step("move_to_own_database");
await assert.rejects(call("move_to_own_database", { app: slug, confirm: "yes" }), /confirm/);
console.log(await call("move_to_own_database", { app: slug, confirm: slug }));

step("the same address answers from its new home, with the same information");
const after = await until("the new home", () => things(live.address), (r: any) => r.status === 200 && r.served === "own database", 8);
console.log(after);
assert.deepEqual(after.rows, before.rows, "nothing lost, nothing changed");
const fourth = await (await fetch(`${live.address}/thing?name=fourth`, { method: "POST" })).json();
assert.equal(fourth.id, 4, "numbering carries on where it left off");
await assert.rejects(call("move_to_own_database", { app: slug, confirm: slug }), /already has a database of its own/);

if (process.env.KEEP) step(`done: ${slug} kept at ${live.address}`);
else {
  step("delete_app");
  console.log(await call("delete_app", { app: slug, confirm: slug }));
}
step("all good");
