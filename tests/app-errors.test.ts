// Apps' errors: what an app sends is cut to size, filed under the app Grove says it is (never one the app
// names), grouped per app, and read back for one app only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { failureEmail, failureFrom, failureKey, failuresOf, keepFailure } from "../grove/src/app-errors.ts";

const DSN = "https://abc123@o1.ingest.de.sentry.io/42";

test("app errors: what an app sends is plain text, cut to size, and needs a message", () => {
  assert.equal(failureFrom({}), undefined);
  assert.equal(failureFrom({ message: "   " }), undefined);
  const f = failureFrom({ message: "x".repeat(5000), type: "TypeError<script>", stack: 1, where: "tool place_order" })!;
  assert.equal(f.message.length, 2000);
  assert.equal(f.type, "TypeErrorscript");
  assert.equal(f.stack, "");
  assert.equal(f.where, "tool place_order");
  assert.equal(failureFrom({ message: "boom" })!.where, "the app");
});

test("app errors: filed under the app Grove names, grouped per app, live or preview", async () => {
  process.env.SENTRY_DSN_APPS = DSN;
  const sent: any[] = [];
  const fetcher = (async (url: string, init: any) => (sent.push({ url, body: init.body }), new Response("{}"))) as any;
  const f = failureFrom({ message: "pool.connect is not a function", type: "TypeError", where: "tool place_order", stack: "TypeError: pool.connect is not a function\n    at place (index.js:10:5)\nnot a frame" })!;
  assert.equal(await keepFailure("dishdash", f, { trial: false, version: 12, fetcher }), true);
  assert.equal(await keepFailure("dishdash", f, { trial: true, fetcher }), true);
  assert.equal(await keepFailure("Not A Slug!", f, { trial: false, fetcher }), false);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, "https://o1.ingest.de.sentry.io/api/42/envelope/");
  const live = JSON.parse(sent[0].body.split("\n")[2]), preview = JSON.parse(sent[1].body.split("\n")[2]);
  assert.deepEqual(live.tags, { app: "dishdash", copy: "live", where: "tool place_order", version: "12" });
  assert.deepEqual(live.fingerprint, ["{{ default }}", "dishdash", "live"]);
  assert.deepEqual(preview.fingerprint, ["{{ default }}", "dishdash", "preview"]);
  assert.equal(live.environment, "live");
  assert.equal(preview.environment, "preview");
  assert.equal(preview.tags.version, undefined);
  assert.equal(live.exception.values[0].value, "pool.connect is not a function");
  assert.deepEqual(live.exception.values[0].stacktrace.frames.map((x: any) => x.function), ["place"]);
  delete process.env.SENTRY_DSN_APPS;
});

test("app errors: at most 20 a minute from one app, without crowding out another", async () => {
  process.env.SENTRY_DSN_APPS = DSN;
  const fetcher = (async () => new Response("{}")) as any;
  const f = failureFrom({ message: "loop" })!;
  let kept = 0;
  for (let i = 0; i < 25; i++) if (await keepFailure("loopy", f, { trial: false, fetcher })) kept++;
  assert.equal(kept, 20);
  assert.equal(await keepFailure("calm", f, { trial: false, fetcher }), true);
  delete process.env.SENTRY_DSN_APPS;
});

test("app errors: read back for one app only, newest code line first, skipping any event that isn't the app's", async () => {
  Object.assign(process.env, { SENTRY_DSN_APPS: DSN, SENTRY_API_TOKEN: "tok" });
  const asked: string[] = [];
  const answers: Record<string, unknown> = {
    issues: [
      { id: "1", title: "TypeError: pool.connect is not a function", count: "3", firstSeen: new Date(Date.now() - 7200_000).toISOString(), lastSeen: new Date(Date.now() - 3600_000).toISOString(), level: "error", status: "unresolved" },
      { id: "2", title: "Somebody else's", count: "1", firstSeen: "x", lastSeen: "x", level: "error", status: "unresolved" },
    ],
    "1": { environment: "live", tags: [{ key: "app", value: "dishdash" }, { key: "where", value: "tool place_order" }, { key: "copy", value: "live" }, { key: "version", value: "12" }],
      entries: [{ type: "exception", data: { values: [{ type: "TypeError", value: "pool.connect is not a function", stacktrace: { frames: [{ function: "outer", filename: "index.js", lineNo: 90 }, { function: "place", filename: "index.js", lineNo: 10 }] } }] } }] },
    "2": { tags: [{ key: "app", value: "other" }], entries: [] },
  };
  const fetcher = (async (url: string, init: any) => {
    asked.push(url);
    assert.equal(init.headers.authorization, "Bearer tok");
    const m = url.match(/issues\/(\d+)\/events\/latest/);
    return Response.json(m ? answers[m[1]] : answers.issues);
  }) as any;
  const errors = await failuresOf("dishdash", { days: 7, copy: "live", seen: new Date(Date.now() - 5400_000), shipped: new Date(Date.now() - 10_800_000), fetcher });
  assert.match(decodeURIComponent(asked[0]), /query=app:dishdash is:unresolved environment:live&statsPeriod=14d/);
  assert.equal(errors.length, 1);
  const { first, last, ...rest } = errors[0] as any;
  assert.ok(first && last);
  assert.deepEqual(rest, { what: "TypeError: pool.connect is not a function", where: "tool place_order", copy: "live", version: "12", times: 3, new: true, sinceLastShip: true, code: ["place (index.js:10)", "outer (index.js:90)"] });
  await assert.rejects(failuresOf("bad slug!", { fetcher }), /isn't an app's name/);
  delete process.env.SENTRY_DSN_APPS;
  delete process.env.SENTRY_API_TOKEN;
  await assert.rejects(failuresOf("dishdash", { fetcher }), /isn't collecting/);
});

test("app errors: the same mistake with different numbers is one kind; live and preview are kept apart", () => {
  const a = { type: "TypeError", where: "tool place_order", message: "order 1234 has no basket 9f8e7d6c-1111" };
  const b = { ...a, message: "order 77 has no basket 0a1b2c3d-2222" };
  assert.equal(failureKey("live", a), failureKey("live", b));
  assert.notEqual(failureKey("live", a), failureKey("preview", a));
  assert.notEqual(failureKey("live", a), failureKey("live", { ...a, where: "GET /menu" }));
});

test("app errors: the email to makers says what broke and what to ask their assistant, and never ships for them", () => {
  const { subject, text } = failureEmail({ slug: "dishdash", title: "DishDash", url: "https://dishdash.grovehelper.com" }, { type: "TypeError", message: "pool.connect is not a function", where: "tool place_order" }, "https://makewithgrove.com");
  assert.equal(subject, "DishDash: something new went wrong");
  assert.match(text, /What: TypeError: pool.connect is not a function\nWhere: tool place_order/);
  assert.match(text, /fix it on a preview/);
  assert.match(text, /Don't ship until I say so/);
});
