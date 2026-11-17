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

step("waiting for the newest Grove to answer");
await until("Grove's newest tools", () => call("list_reports").then(() => true, () => false), Boolean, 4);

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

step("a free app carries the line about Grove, with a way to report it");
const front = await (await fetch(back.address)).text();
assert.match(front, /Made with <a href="[^"]+\/\?from=/);
assert.match(front, new RegExp(`/report\\?app=${slug}"`));
assert.equal((await fetch(`${GROVE}/report?app=${slug}`)).status, 200);

step("a report from the public reaches Grove's maker");
const sent = await fetch(`${GROVE}/report`, { method: "POST", body: new URLSearchParams({ app: `https://${slug}.grovehelper.com/x`, what: "E2E test report: please ignore." }) });
assert.equal(sent.status, 200);
const mine = (await call("list_reports")).reports.filter((r: any) => r.app === slug);
assert.equal(mine.length, 1);
assert.equal((await call("close_report", { id: Number(mine[0].id) })).closed, true);
assert.equal((await fetch(`${GROVE}/report`, { method: "POST", body: new URLSearchParams({ app: "no-such-app-here", what: "Nothing to see." }) })).status, 404);

step("code that asks for a password is saved, and filed for a person to look at");
await call("write_files", { app: slug, change: "odd-page", message: "A page with a password box", files: [{ path: "src/odd.ts", content: "export const odd = `<form><input type=\"password\" name=\"p\"></form>`;\n" }] });
const flagged = (await call("list_reports")).reports.filter((r: any) => r.app === slug);
assert.equal(flagged.length, 1);
assert.equal(flagged[0].reporter, "Grove check");
assert.match(flagged[0].what, /src\/odd\.ts has a password box/);

step("pause_app: the app goes offline, can't be changed, and can still be exported");
await call("pause_app", { app: slug, why: "E2E test of pausing." });
assert.equal((await call("app_status", { app: slug })).status, "paused");
await assert.rejects(call("write_files", { app: slug, change: "odd-page", message: "More", files: [{ path: "src/more.ts", content: "export {};\n" }] }), /paused by Grove: E2E test of pausing/);
await assert.rejects(call("ship_change", { app: slug, change: "odd-page" }), /paused by Grove/);
assert.ok((await call("export_app", { app: slug })).download);
await until("the paused page", () => fetch(back.address).then((r) => r.status), (status) => status === 503);
assert.match(await (await fetch(back.address)).text(), /This app is paused/);

step("resume_app: it comes back as it was");
await call("resume_app", { app: slug });
await until("the app again", () => call("app_status", { app: slug }), (s) => s.status === "live");
// The paused page and the app can both answer for a moment while Neon switches over.
await until("the app's own page", () => fetch(back.address).then((r) => r.status), (status) => status === 200);
await call("drop_change", { app: slug, change: "odd-page" });
await call("close_report", { id: Number(flagged[0].id) });

if (process.env.KEEP) step(`done: ${slug} kept at ${back.address}`);
else {
  step("delete_app");
  await assert.rejects(call("delete_app", { app: slug, confirm: "yes" }), /confirm/);
  console.log(await call("delete_app", { app: slug, confirm: slug }));
  step("done");
}
