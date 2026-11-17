// Counting how much of a person's assistant allowance Grove uses, and stopping to ask before it gets large.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { HEAVY, carryOn, firstLimit, nextLimit, record, rounded, sizeOf, stopMessage, summary, today, tokens } from "../grove/src/meter.ts";

const answering = (...answers: any[]) => {
  const asked: { sql: string; args: any[] }[] = [];
  return { asked, query: async (sql: string, args: any[] = []) => (asked.push({ sql, args }), answers.shift() ?? { rows: [], rowCount: 0 }) } as any;
};

beforeEach(() => {
  delete process.env.USAGE_WARN_TOKENS;
});

test("tokens: about four characters each, rounded up", () => {
  assert.equal(tokens(0), 0);
  assert.equal(tokens(1), 1);
  assert.equal(tokens(4000), 1000);
  assert.equal(tokens(4001), 1001);
});

test("sizes and words a person can follow", () => {
  assert.equal(sizeOf(500), "small");
  assert.equal(sizeOf(9_999), "small");
  assert.equal(sizeOf(10_000), "medium");
  assert.equal(sizeOf(49_999), "medium");
  assert.equal(sizeOf(50_000), "large");
  assert.equal(rounded(400), "under a thousand");
  assert.equal(rounded(151_400), "about 151 thousand");
});

test("only the tools that move a lot of text can be stopped; shipping, status and paying never are", () => {
  for (const heavy of ["create_app", "read_files", "write_files", "update_kit"]) assert.ok(HEAVY.has(heavy), heavy);
  for (const light of ["ship_change", "rollback", "app_status", "change_status", "export_app", "delete_app", "plan", "upgrade", "usage", "accept_usage", "accept_terms"]) assert.ok(!HEAVY.has(light), light);
});

test("no warning below the day's limit, a warning at it", () => {
  assert.equal(stopMessage(149_999, 150_000), undefined);
  const stop = stopMessage(150_000, 150_000)!;
  assert.match(stop, /Stop and check with the person/);
  assert.match(stop, /about 150 thousand tokens/);
  assert.match(stop, /accept_usage/);
  assert.match(stop, /said yes themselves/);
});

test("the first limit is 150 thousand tokens, or whatever Grove is set to", () => {
  assert.equal(firstLimit(), 150_000);
  process.env.USAGE_WARN_TOKENS = "20000";
  assert.equal(firstLimit(), 20_000);
});

test("agreeing moves the next stop to twice as far, and always past what is already used", () => {
  assert.equal(nextLimit(150_000, 150_000), 300_000);
  assert.equal(nextLimit(160_000, 150_000), 300_000);
  assert.equal(nextLimit(310_000, 300_000), 600_000);
  assert.equal(nextLimit(700_000, 150_000), 1_200_000, "a big jump still lands past the usage");
  assert.equal(nextLimit(10, 0), 150_000, "agreeing early changes nothing");
});

test("today: adds up the day's traffic and uses the first limit until the person has agreed to more", async () => {
  assert.deepEqual(await today(answering({ rows: [{ chars: "400000", upto: "0" }] }), "a@b.c"), { used: 100_000, upto: 150_000 });
  assert.deepEqual(await today(answering({ rows: [{ chars: "800000", upto: "300000" }] }), "a@b.c"), { used: 200_000, upto: 300_000 });
  assert.deepEqual(await today(answering({ rows: [{ chars: "0", upto: "0" }] }), "new@b.c"), { used: 0, upto: 150_000 });
});

test("carrying on: records the new limit for today", async () => {
  const pool = answering({ rows: [{ chars: "640000", upto: "0" }] });
  assert.deepEqual(await carryOn(pool, "a@b.c"), { used: 160_000, next: 300_000 });
  assert.match(pool.asked[1].sql, /insert into usage_ok/);
  assert.deepEqual(pool.asked[1].args, ["a@b.c", 300_000]);
});

test("each call is counted against the person and the app", async () => {
  const pool = answering();
  await record(pool, "a@b.c", "club", 120, 4000);
  assert.match(pool.asked[0].sql, /on conflict \(email, app, day\) do update/);
  assert.deepEqual(pool.asked[0].args, ["a@b.c", "club", 120, 4000]);
});

test("summary: per app, with what a saved change has typically taken", async () => {
  const rows = [
    { app: "club", calls: 40, chars: "480000", chars_today: "40000", saves: 6 },
    { app: "", calls: 3, chars: "2000", chars_today: "0", saves: 0 },
  ];
  assert.deepEqual(await summary(answering({ rows }), "a@b.c"), [
    { app: "club", calls: 40, tokensToday: 10_000, tokensLast30Days: 120_000, typicalChange: { tokens: 20_000, size: "medium" } },
    { app: "(not about one app)", calls: 3, tokensToday: 0, tokensLast30Days: 500 },
  ]);
});
