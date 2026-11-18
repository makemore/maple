// What Grove does for apps: real email with its limits, and the pretend services' answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServices, SERVICE_LIST } from "../kit/services.ts";
import { SERVICES, ServiceError, appEmailsPerDay, checkEmail, footer, fromName, known, pretend, pretendCheckout, pretendPayPage, pretendStatus, whoGets } from "../grove/src/services.ts";

const answering = (...answers: any[]) => {
  const asked: { sql: string; args: any[] }[] = [];
  return { asked, query: async (sql: string, args: any[] = []) => (asked.push({ sql, args }), answers.shift() ?? { rows: [], rowCount: 0 }) } as any;
};
const SITE = "https://grove.example";

test("the list: only email is real, and the kit and Grove agree on what exists", () => {
  assert.deepEqual(SERVICES.filter((s) => s.real).map((s) => s.name), ["email"]);
  assert.deepEqual(SERVICES.map((s) => [s.name, s.real]), SERVICE_LIST.map((s) => [s.name, s.real]));
  assert.ok(known("email", "send") && known("payments", "status") && !known("email", "blast") && !known("fax", "send"));
});

test("email: addresses are checked, tidied and capped at ten", () => {
  assert.deepEqual(checkEmail({ to: " A@b.co ", subject: "Hi\nthere", text: "x" }), { to: ["a@b.co"], subject: "Hi there", text: "x", replyTo: undefined });
  assert.deepEqual(checkEmail({ to: ["a@b.co", "A@B.co"], subject: "s", text: "t" }).to, ["a@b.co"]);
  assert.throws(() => checkEmail({ to: "not an address", subject: "s", text: "t" }), ServiceError);
  assert.throws(() => checkEmail({ to: "a@b.co, c@d.co", subject: "s", text: "t" }), /email address/);
  assert.throws(() => checkEmail({ to: Array.from({ length: 11 }, (_, i) => `p${i}@b.co`), subject: "s", text: "t" }), /in bulk/);
  assert.throws(() => checkEmail({ to: "a@b.co", subject: "", text: "t" }), /subject is required/);
  assert.throws(() => checkEmail({ to: "a@b.co", subject: "s", text: "t", replyTo: "nope" }), /replyTo/);
});

test("email: a trial copy only writes to the app's own people", () => {
  assert.deepEqual(whoGets(["me@x.co", "customer@y.co"], ["Me@x.co"], true), { sent: ["me@x.co"], held: ["customer@y.co"] });
  assert.deepEqual(whoGets(["me@x.co", "customer@y.co"], ["me@x.co"], false), { sent: ["me@x.co", "customer@y.co"], held: [] });
});

test("email: the sender always says via Grove, the footer names the app and how to report it, and paying raises the limit", () => {
  assert.equal(fromName("PayPal <security@paypal.com>"), "PayPal securitypaypal.com via Grove");
  assert.equal(fromName('"><'), "An app via Grove");
  const f = footer({ title: "Roastery", slug: "roastery", url: "https://roastery.example" }, SITE);
  assert.match(f, /Sent by Roastery \(https:\/\/roastery\.example\), an app made with Grove/);
  assert.match(f, /grove\.example\/report\?app=roastery/);
  assert.equal(appEmailsPerDay(false), 50);
  assert.equal(appEmailsPerDay(true), 500);
});

test("pretend services: every answer says it is pretend and why", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  const calls: [string, string, any][] = [
    ["tasks", "later", { name: "remind", payload: {}, inMinutes: 30 }],
    ["tasks", "every", { name: "digest", dailyAt: "08:00" }],
    ["tasks", "cancel", { id: "x" }],
    ["files", "put", { name: "my photo.png", type: "image/png", base64: "aGVsbG8=" }],
    ["files", "remove", { id: "x" }],
    ["texts", "send", { to: "+44 7700 900123", text: "Hello" }],
    ["ai", "ask", { prompt: "Sort these" }],
    ["pdf", "make", { title: "Invoice 12", html: "<p>hi</p>" }],
  ];
  for (const [s, a, body] of calls) {
    const r: any = pretend(s, a, body, "id-1", SITE, now);
    assert.equal(r.mock, true, `${s}.${a}`);
    assert.match(r.note, /^Pretend: /, `${s}.${a}`);
  }
  assert.equal((pretend("tasks", "later", { name: "n", inMinutes: 30 }, "i", SITE, now) as any).runsAt, "2026-11-18T10:30:00.000Z");
  assert.equal((pretend("tasks", "every", { name: "n", dailyAt: "08:00" }, "i", SITE, now) as any).next, "2026-11-19T08:00:00.000Z");
  assert.equal((pretend("texts", "send", { to: "+44 7700 900123", text: "x" }, "i", SITE) as any).to, "+447700900123");
  assert.match((pretend("files", "put", { name: "my photo.png", type: "image/png", base64: "aGVsbG8=" }, "i", SITE) as any).url, /\/pretend\/file\/i\/my-photo\.png$/);
});

test("pretend services: bad input is refused in words", () => {
  assert.throws(() => pretend("texts", "send", { to: "phone", text: "x" }, "i", SITE), /phone number/);
  assert.throws(() => pretend("tasks", "later", { name: "n", inMinutes: -1 }, "i", SITE), /inMinutes/);
  assert.throws(() => pretend("tasks", "every", { name: "n", dailyAt: "8am" }, "i", SITE), /08:00/);
  assert.throws(() => pretend("ai", "ask", {}, "i", SITE), /prompt is required/);
});

test("pretend payments: checkout gives a Grove page, and status follows whether someone pressed pay", async () => {
  const pool = answering();
  const out = await pretendCheckout(pool, "roastery", { amount: 1250, description: "Two bags" }, "pay-1", SITE);
  assert.deepEqual({ id: out.id, url: out.url, status: out.status, mock: out.mock }, { id: "pay-1", url: `${SITE}/pretend/pay/pay-1`, status: "unpaid", mock: true });
  assert.deepEqual(pool.asked[0].args.slice(0, 5), ["pay-1", "roastery", 1250, "GBP", "Two bags"]);
  await assert.rejects(pretendCheckout(answering(), "a", { amount: 12.5, description: "x" }, "i", SITE), /whole number/);
  await assert.rejects(pretendCheckout(answering(), "a", { amount: 100, description: "x", returnTo: "http://x" }, "i", SITE), /https/);
  const paid = await pretendStatus(answering({ rows: [{ id: "pay-1", amount: 1250, currency: "GBP", reference: null, paid_at: new Date() }] }), "roastery", { id: "pay-1" });
  assert.equal(paid.status, "paid");
  assert.equal(paid.mock, true);
  await assert.rejects(pretendStatus(answering({ rows: [] }), "roastery", { id: "nope" }), /No payment/);
});

test("pretend payment page: says no money moves, never asks for a card, and escapes what the app wrote", () => {
  const page = pretendPayPage({ id: "pay-1", app_title: "<b>Shop</b>", amount: 1250, currency: "GBP", description: "<script>x</script>" });
  assert.match(page, /No money will move/);
  assert.match(page, /£12\.50/);
  assert.doesNotMatch(page, /<script>x|<b>Shop|type="(text|password|number)"/);
  assert.match(page, /Pretend it was paid/);
  assert.doesNotMatch(pretendPayPage({ id: "p", app_title: "Shop", amount: 100, currency: "GBP", description: "d", paid_at: new Date() }), /<form/);
});

test("an app run without Grove: email goes direct, and the rest say they need setting up", async () => {
  const sent: any[] = [];
  const s = createServices({ emailDirect: async (to, subject) => (sent.push([to, subject]), true) });
  assert.deepEqual(await s.email.send({ to: "a@b.co", subject: "Hi", text: "x" }), { sent: ["a@b.co"], held: [] });
  assert.deepEqual(sent, [[["a@b.co"], "Hi"]]);
  const pay = await s.payments.checkout({ amount: 100, description: "x" });
  assert.equal(pay.mock, true);
  assert.match(pay.note!, /isn't run by Grove/);
  await assert.rejects(createServices({}).email.send({ to: "a@b.co", subject: "Hi", text: "x" }), /isn't set up/);
});

test("an app run by Grove: calls go to Grove with the app's secret, and say when it is a trial copy", async () => {
  const real = globalThis.fetch;
  const seen: any[] = [];
  globalThis.fetch = (async (url: string, init: any) => (seen.push([url, init.headers.authorization, JSON.parse(init.body)]), new Response(JSON.stringify({ id: "t1", runsAt: "x", mock: true }), { status: 200 }))) as any;
  try {
    const s = createServices({ grove: SITE, secret: "shh", trial: true });
    await s.tasks.later("remind", { order: 4 }, { inMinutes: 5 });
    assert.deepEqual(seen[0], [`${SITE}/services/tasks/later`, "Bearer shh", { name: "remind", payload: { order: 4 }, inMinutes: 5, trial: true }]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "This app has sent all the emails it can today (50)." }), { status: 429 })) as any;
    await assert.rejects(s.email.send({ to: "a@b.co", subject: "s", text: "t" }), /all the emails it can today/);
  } finally {
    globalThis.fetch = real;
  }
});
