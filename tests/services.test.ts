// What Grove does for apps: real email with its limits, and the pretend services' answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServices, SERVICE_LIST } from "../kit/services.ts";
import { FILE_TYPES, MAX_FILE_BYTES, appFileBytes, checkFile, fileLink, keepFile, linkGood } from "../grove/src/services.ts";
import { signed } from "../grove/src/storage.ts";
import { SERVICES, ServiceError, appEmailsPerDay, checkEmail, footer, fromName, known, pretend, pretendCheckout, pretendPayPage, pretendStatus, whoGets } from "../grove/src/services.ts";

const answering = (...answers: any[]) => {
  const asked: { sql: string; args: any[] }[] = [];
  return { asked, query: async (sql: string, args: any[] = []) => (asked.push({ sql, args }), answers.shift() ?? { rows: [], rowCount: 0 }) } as any;
};
const SITE = "https://grove.example";

test("the list: email, background work and files are real, and the kit and Grove agree on what exists", () => {
  assert.deepEqual(SERVICES.filter((s) => s.real).map((s) => s.name), ["email", "tasks", "files"]);
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
  assert.equal((pretend("texts", "send", { to: "+44 7700 900123", text: "x" }, "i", SITE) as any).to, "+447700900123");
  assert.match((pretend("files", "put", { name: "my photo.png", type: "image/png", base64: "aGVsbG8=" }, "i", SITE) as any).url, /\/pretend\/file\/i\/my-photo\.png$/);
});

test("pretend services: bad input is refused in words", () => {
  assert.throws(() => pretend("texts", "send", { to: "phone", text: "x" }, "i", SITE), /phone number/);
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
    await s.texts.send({ to: "+447700900123", text: "Hi" });
    assert.deepEqual(seen[0], [`${SITE}/services/texts/send`, "Bearer shh", { to: "+447700900123", text: "Hi", trial: true }]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "This app has sent all the emails it can today (50)." }), { status: 429 })) as any;
    await assert.rejects(s.email.send({ to: "a@b.co", subject: "s", text: "t" }), /all the emails it can today/);
  } finally {
    globalThis.fetch = real;
  }
});

test("files: only safe kinds, a tidy name, a size limit, and nothing a browser would run", () => {
  const f = checkFile({ name: "../My Photo (1).PNG", type: "image/png; charset=x", base64: "aGVsbG8=", public: true });
  assert.deepEqual({ name: f.name, type: f.type, bytes: f.bytes.length, public: f.public }, { name: "My-Photo-1-.PNG", type: "image/png", bytes: 5, public: true });
  for (const type of ["text/html", "image/svg+xml", "application/javascript"]) assert.throws(() => checkFile({ name: "x", type, base64: "aGVsbG8=" }), /can't be kept/, type);
  assert.ok(FILE_TYPES.has("application/pdf"));
  assert.throws(() => checkFile({ name: "x.png", type: "image/png", base64: "not base64!" }), /base64/);
  assert.throws(() => checkFile({ name: "x.png", type: "image/png", base64: Buffer.alloc(MAX_FILE_BYTES + 1).toString("base64") }), /too (big|long)/);
  assert.equal(appFileBytes(false), 100_000_000);
});

test("files: a public file has a plain address; a private one a link that runs out and can't be altered", () => {
  const sign = (what: string) => `sig-of-${what}`.padEnd(40, "x");
  const now = Date.UTC(2026, 10, 18, 10);
  assert.equal(fileLink(SITE, { id: "f1", name: "a.png", public: true }, sign), `${SITE}/files/f1/a.png`);
  const link = new URL(fileLink(SITE, { id: "f1", name: "a.pdf" }, sign, 60, now));
  const until = link.searchParams.get("until")!, sig = link.searchParams.get("sig")!;
  assert.equal(Number(until), now / 1000 + 3600);
  assert.equal(linkGood("f1", until, sig, sign, now), true);
  assert.equal(linkGood("f1", until, sig, sign, now + 3_600_001), false, "run out");
  assert.equal(linkGood("f2", until, sig, sign, now), false, "another file");
  assert.equal(linkGood("f1", String(Number(until) + 999), sig, sign, now), false, "a changed time");
  assert.equal(linkGood("f1", undefined, undefined, sign, now), false);
});

test("files: an app can't keep more than its plan allows", async () => {
  const pool = answering({ rows: [{ used: "99999999" }] });
  await assert.rejects(keepFile(pool, "shop", { name: "a.png", type: "image/png", base64: "aGVsbG8=" }, "id", { site: SITE, paid: false, trial: false, sign: () => "s" }), /no room left/);
});

test("storage: requests are signed the S3 way, with the body's hash and the date in the scope", () => {
  const env = { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-east-2" } as any;
  const h = signed("PUT", new URL("https://s3.example/files/shop/abc"), new TextEncoder().encode("hello"), { "content-type": "text/plain" }, new Date("2026-11-18T10:00:00Z"), env);
  assert.equal(h["x-amz-date"], "20261118T100000Z");
  assert.equal(h["x-amz-content-sha256"], "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20261118\/us-east-2\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal((h as any).host, undefined);
  const again = signed("PUT", new URL("https://s3.example/files/shop/abc"), new TextEncoder().encode("hello!"), { "content-type": "text/plain" }, new Date("2026-11-18T10:00:00Z"), env);
  assert.notEqual(again.authorization, h.authorization);
});

test("ai: real through the gateway when its model is enabled, with a capped answer and the app's name", async () => {
  const { aiReady, aiForget, realAsk, checkAsk } = await import("../grove/src/services.ts");
  process.env.NEON_AI_GATEWAY_BASE_URL = "https://gw.example";
  process.env.NEON_AI_GATEWAY_TOKEN = "nt_test";
  try {
    aiForget();
    const locked: typeof fetch = async () => new Response(JSON.stringify({ data: [{ id: "claude-haiku-5-5", enabled: false }] }));
    assert.equal(await aiReady(locked), false, "no credits: stays pretend");
    aiForget();
    assert.equal(await aiReady(async () => new Response(JSON.stringify({ data: [{ id: "claude-haiku-5-5", enabled: true }] }))), true);
    let sent: any;
    const answer = await realAsk(checkAsk({ prompt: "Sort these", instructions: "One word" }), { paid: false, app: "Chris's Helper" }, async (_u, init) => {
      sent = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: " Done " }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    });
    assert.equal(answer.text, "Done");
    assert.deepEqual(answer.usage, { input: 12, output: 3, model: "claude-haiku-5-5" });
    assert.equal(sent.max_tokens, 800);
    assert.match(sent.messages[0].content, /Chris's Helper[\s\S]*One word/);
    assert.throws(() => checkAsk({ prompt: "" }), /prompt is required/);
  } finally {
    delete process.env.NEON_AI_GATEWAY_BASE_URL;
    delete process.env.NEON_AI_GATEWAY_TOKEN;
    aiForget();
  }
});
