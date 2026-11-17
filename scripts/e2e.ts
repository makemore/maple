// End to end through Grove, the way an assistant would use it: create an app, wait until it is live,
// change its code (a broken write is refused, a good one gets a preview), ship it, roll it back,
// download it, then delete it (KEEP=1 leaves it for a look).
// Run: node --env-file=.env.local scripts/e2e.ts [app-name]   (needs MAPLE_TEST_TOKEN on Grove)
import assert from "node:assert/strict";

const GROVE = (process.env.GROVE_URL ?? process.env.PUBLIC_URL)!;
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
const made = await call("create_app", { name: slug, title: "E2E Notes", description: "A test app that keeps short notes for a team.", users: [] });
console.log(made);

step("waiting for it to go live");
const live = await until("live", () => call("app_status", { app: slug }), (s) => s.status === "live");
console.log(live);
assert.equal((await fetch(live.address)).status, 200);
assert.equal((await fetch(live.connect, { method: "POST" })).status, 401, "the connector asks for sign-in");
const meta = await (await fetch(new URL("/.well-known/oauth-protected-resource/mcp", live.address))).json();
assert.equal(meta.resource, live.connect, "OAuth resource matches the connection address");

step("a new app has the newest kit and nothing to agree to that it hasn't");
assert.equal(live.kit, "up to date");
assert.equal((await call("update_kit", { app: slug })).kit, "up to date");
assert.equal((await call("accept_terms", { agree: true })).agreed, true);
for (const page of ["/terms", "/privacy"]) assert.equal((await fetch(GROVE + page)).status, 200, page);

step("write_files: broken code is refused with the problem");
const [{ content: appTs }] = (await call("read_files", { app: slug, paths: ["src/app.ts"] })).files;
await assert.rejects(call("write_files", { app: slug, change: "add-notes", message: "Broken", files: [{ path: "src/app.ts", content: appTs.replace("void z;", "const n: number = 'five'; void n; void z;") }] }), /src\/app\.ts\(\d+,\d+\).*not assignable/s);
await assert.rejects(call("write_files", { app: slug, change: "add-notes", message: "Bad import", files: [{ path: "src/x.ts", content: "import 'left-pad';\n" }, { path: "src/app.ts", content: "import './x.ts';\n" + appTs }] }), /left-pad/);

step("write_files: add a notes feature");
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
const ch = await until("preview", () => call("change_status", { app: slug, change: "add-notes" }), (s) => s.status === "ready");
console.log(ch);
assert.deepEqual(ch.filesChanged, ["changed src/app.ts"]);
assert.equal((await fetch(ch.preview)).status, 200, "preview serves");
assert.equal((await fetch(ch.previewConnect, { method: "POST" })).status, 401, "the preview's connector asks for sign-in");

step("protected files are refused");
await assert.rejects(call("write_files", { app: slug, change: "bad", message: "xxx", files: [{ path: "src/maple/kit.ts", content: "" }] }), /belongs to MAPLE/);

step("ship_change");
console.log(await call("ship_change", { app: slug, change: "add-notes" }));
const shipped = await until("ship", () => call("app_status", { app: slug }), (s) => s.status === "live");
assert.notEqual(shipped.version, live.version);
console.log(shipped);

step("rollback");
console.log(await call("rollback", { app: slug }));
const back = await until("rollback", () => call("app_status", { app: slug }), (s) => s.status === "live");
assert.notEqual(back.version, shipped.version);

step("export_app");
const out = await call("export_app", { app: slug, database: true });
const link = out.download.replace(new URL(out.download).origin, GROVE); // GROVE_URL may be another address for the same Grove
const zipped = await fetch(link);
assert.equal(zipped.status, 200);
assert.equal(new Uint8Array(await zipped.arrayBuffer())[0], 0x50, "a zip");
assert.match(out.database, /^postgres(ql)?:\/\//);
assert.equal((await fetch(link.replace(/sig=.{4}/, "sig=0000"))).status, 403, "a changed link is refused");

if (process.env.KEEP) step(`done: ${slug} kept at ${back.address}`);
else {
  step("delete_app");
  await assert.rejects(call("delete_app", { app: slug, confirm: "yes" }), /confirm/);
  console.log(await call("delete_app", { app: slug, confirm: slug }));
  step("done");
}
