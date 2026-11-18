// End to end through Grove: an app that is a website, sends a real email through Grove, and does
// background work that Grove's timer wakes it for. Then deletes it (KEEP=1 leaves it for a look).
// Run: npm run test:live:services   (needs MAPLE_TEST_TOKEN on Grove)
import assert from "node:assert/strict";

const GROVE = (process.env.GROVE_URL ?? process.env.PUBLIC_URL)!;
const slug = process.argv[2] ?? `e2e-svc-${Date.now().toString(36)}`;
const TO = process.env.E2E_EMAIL_TO ?? `hello@${new URL(GROVE).host}`;
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
const getJson = (url: string, init?: RequestInit) => fetch(url, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));

step("waiting for a Grove that knows about services");
await until("the services tool", () => call("services").then((s) => s.services.some((x: any) => x.service === "tasks" && x.status === "real"), () => false), Boolean, 4);

step(`create_app ${slug}`);
await call("accept_terms", { agree: true }).catch(() => undefined);
console.log(await call("create_app", { name: slug, title: "E2E Bakery", description: "A test: a bakery's order page with a reminder job.", users: [] }));
const live = await until("live", () => call("app_status", { app: slug }), (s) => s.status === "live");

step("write_files: a front page, an order form that emails and starts a job, and the job itself");
const [{ content: appTs }] = (await call("read_files", { app: slug, paths: ["src/app.ts"] })).files;
const changed = appTs
  .replace("export const schema = `\n`;", "export const schema = `\ncreate table if not exists orders (id serial primary key, what text not null, reminded_at timestamptz, created_at timestamptz not null default now());\n`;")
  .replace("export function routes(_app: Hono, _pool: Pool, _services: Services) {}", `export function routes(app: Hono, pool: Pool, services: Services) {
  app.post("/order", async (c) => {
    const { rows: [o] } = await pool.query("insert into orders (what) values ($1) returning id", ["a test loaf"]);
    const mail = await services.email.send({ to: c.req.query("to") ?? "", subject: "E2E Bakery: order received", text: "This is Grove's own end-to-end test. Order " + o.id + " came in." });
    const job = await services.tasks.later("remind", { orderId: o.id }, { inMinutes: 0 });
    const pay = await services.payments.checkout({ amount: 450, description: "A test loaf" });
    return c.json({ order: o.id, mail, job, pay });
  });
  app.get("/orders", async (c) => c.json((await pool.query("select id, reminded_at is not null as reminded from orders order by id")).rows));
}`)
  .replace("export const jobs: AppJobs = {};", `export const jobs: AppJobs = {
  remind: async ({ orderId }, { pool }) => {
    await pool.query("update orders set reminded_at = now() where id = $1 and reminded_at is null", [orderId]);
  },
};`)
  .replace(/export const home: [^\n]+= undefined;/, 'export const home = ({ title }: { title: string }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Fresh bread, ordered here.</p></body></html>`;');
for (const must of ["app.post(\"/order\"", "remind: async", "Fresh bread"]) assert.ok(changed.includes(must), `the template changed shape (${must}); update this test`);
console.log(await call("write_files", { app: slug, change: "bakery", message: "A website with orders, email and a reminder job", files: [{ path: "src/app.ts", content: changed }] }));
const ch = await until("preview", () => call("change_status", { app: slug, change: "bakery" }), (s) => s.status === "ready");

step("the trial copy: the public page is up, the stranger's email is held back, and jobs wait for the maker");
assert.match(await (await fetch(ch.preview)).text(), /Fresh bread/);
const trial = await until("the trial copy's order form", () => getJson(ch.preview + "/order?to=stranger@example.com", { method: "POST" }), (r) => r.status === 200, 3);
console.log(JSON.stringify(trial.body));
assert.deepEqual(trial.body.mail.sent, [], "a trial copy doesn't email people outside the app");
assert.deepEqual(trial.body.mail.held, ["stranger@example.com"]);
assert.match(trial.body.job.note, /trial copy/);
assert.equal(trial.body.pay.mock, true);

step("ship_change");
console.log(await call("ship_change", { app: slug, change: "bakery" }));
const shipped = await until("ship", () => call("app_status", { app: slug }), (s) => s.status === "live" && s.version !== live.version);
await until("the live site to show the new front page", () => fetch(shipped.address).then((r) => r.text()), (t) => /Fresh bread/.test(t), 4);

step("live: an order sends a real email and starts a job");
const order = await until("the live order form", () => getJson(shipped.address + "/order?to=" + encodeURIComponent(TO), { method: "POST" }), (r) => r.status === 200, 3);
console.log(JSON.stringify(order.body));
assert.deepEqual(order.body.mail.sent, [TO]);
assert.equal(order.body.job.note, undefined);
assert.equal((await fetch(order.body.pay.url)).status, 200, "the pretend payment page opens");

step("Grove's timer wakes the app and the job runs, with nobody asking");
const orders = await until("the reminder job", () => getJson(shipped.address + "/orders"), (r) => r.body?.some((o: any) => o.id === order.body.order && o.reminded), 5);
console.log(JSON.stringify(orders.body));
assert.equal((await fetch(shipped.address + "/maple/tick", { method: "POST" })).status, 401, "strangers can't run an app's jobs");

step("the maker can see what the app asked Grove for");
const used = await call("services", { app: slug });
console.log(used.recent.map((r: any) => `${r.service}.${r.action}${r.trial ? " (trial)" : ""}`).join(", "));
assert.ok(used.recent.some((r: any) => r.service === "email" && !r.trial && r.result.sent.length === 1));

if (process.env.KEEP) step(`done: ${slug} kept at ${shipped.address}`);
else {
  step("delete_app");
  console.log(await call("delete_app", { app: slug, confirm: slug }));
}
step("all good");
