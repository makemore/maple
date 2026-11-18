// Background work: timing, retries, and waking apps when a job is due.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TRIES, createTasks, nextDaily, nextRun, retryInMinutes, tick } from "../kit/tasks.ts";
import { wakeAt, wakeDue } from "../grove/src/services.ts";

const answering = (...answers: any[]) => {
  const asked: { sql: string; args: any[] }[] = [];
  return { asked, query: async (sql: string, args: any[] = []) => (asked.push({ sql, args }), answers.shift() ?? { rows: [], rowCount: 0 }) } as any;
};

test("timing: a daily job runs at the next such time in UTC, and a repeating one after its gap", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  assert.equal(nextDaily("08:00", now).toISOString(), "2026-11-19T08:00:00.000Z");
  assert.equal(nextDaily("10:30", now).toISOString(), "2026-11-18T10:30:00.000Z");
  assert.equal(nextRun({ every_minutes: 90 }, now)!.toISOString(), "2026-11-18T11:30:00.000Z");
  assert.equal(nextRun({ daily_at: "08:00" }, now)!.toISOString(), "2026-11-19T08:00:00.000Z");
  assert.equal(nextRun({}, now), null);
  assert.deepEqual([1, 2, 3, 4, 9].map(retryInMinutes), [5, 10, 20, 40, 360]);
});

test("starting a job: it must be one the app has, it is saved, and whoever wakes the app is told when", async () => {
  const pool = answering({ rows: [{ id: 7, run_at: new Date("2026-11-18T10:30:00Z") }] });
  const woken: Date[] = [];
  const tasks = createTasks({ pool, init: async () => {}, names: () => ["remind"], wake: async (at) => void woken.push(at) });
  assert.deepEqual(await tasks.later("remind", { order: 4 }, { inMinutes: 30 }), { id: "7", runsAt: "2026-11-18T10:30:00.000Z" });
  assert.deepEqual(pool.asked[0].args, ["remind", '{"order":4}', 30]);
  assert.equal(woken[0].toISOString(), "2026-11-18T10:30:00.000Z");
  await assert.rejects(tasks.later("nope", {}, { inMinutes: 1 }), /no job called nope. Its jobs are: remind/);
  await assert.rejects(tasks.later("remind", {}, { inMinutes: -5 }), /inMinutes/);
  await assert.rejects(tasks.every("remind", { dailyAt: "8am" }), /08:00/);
});

test("a repeating job started again replaces the old timing, and a trial copy says jobs won't run by themselves", async () => {
  const pool = answering({ rowCount: 1 }, { rows: [{ id: 9, run_at: new Date("2026-11-19T08:00:00Z") }] });
  const out = await createTasks({ pool, init: async () => {}, names: () => ["digest"], trial: true }).every("digest", { dailyAt: "08:00" });
  assert.match(pool.asked[0].sql, /set cancelled_at = now\(\) where name = \$1/);
  assert.equal(out.id, "9");
  assert.match(out.note!, /trial copy/);
});

test("tick: runs what is due, marks one-off jobs done, books repeating ones again, and says when the next is", async () => {
  const ran: any[] = [];
  const pool = answering(
    { rows: [{ id: 1, name: "remind", payload: { order: 4 }, attempts: 1 }] }, {},
    { rows: [{ id: 2, name: "digest", payload: {}, daily_at: "08:00", attempts: 1 }] }, {},
    { rows: [] },
    { rows: [{ next: new Date("2026-11-19T08:00:00Z") }] },
  );
  const out = await tick(pool, { remind: async (p, ctx) => void ran.push([p, ctx]), digest: async () => void ran.push("digest") }, "ctx", () => new Date("2026-11-18T10:00:00Z"));
  assert.deepEqual(ran, [[{ order: 4 }, "ctx"], "digest"]);
  assert.deepEqual(out, { ran: 2, failed: 0, next: "2026-11-19T08:00:00.000Z" });
  assert.match(pool.asked[0].sql, /for update skip locked/);
  assert.match(pool.asked[1].sql, /set done_at = now\(\)/);
  assert.match(pool.asked[3].sql, /set run_at = \$2, attempts = 0/);
  assert.equal(pool.asked[3].args[1].toISOString(), "2026-11-19T08:00:00.000Z");
});

test("tick: a job that throws is kept for another try with the reason, and an unknown job counts as failed", async () => {
  const pool = answering({ rows: [{ id: 1, name: "remind", payload: {}, attempts: 2 }] }, {}, { rows: [{ id: 2, name: "gone", payload: {}, attempts: 1 }] }, {}, { rows: [] }, { rows: [{ next: null }] });
  const realError = console.error;
  console.error = () => {};
  try {
    const out = await tick(pool, { remind: async () => { throw new Error("mail server down"); } }, null);
    assert.deepEqual(out, { ran: 0, failed: 2, next: null });
    assert.deepEqual(pool.asked[1].args, [1, "mail server down"]);
    assert.match(pool.asked[3].args[1], /no job called gone/);
  } finally {
    console.error = realError;
  }
  assert.equal(MAX_TRIES, 5);
});

test("Grove: an app's wake time only ever moves earlier, and a bad time is refused", async () => {
  const pool = answering();
  await wakeAt(pool, "roastery", { at: "2026-11-18T10:30:00Z" });
  assert.match(pool.asked[0].sql, /least\(coalesce\(wake_at, 'infinity'\), \$2\)/);
  await assert.rejects(wakeAt(answering(), "roastery", { at: "soon" }), /must be a time/);
});

test("Grove: the timer calls each due app with its own secret, notes the next time, and leaves a silent app for a retry", async () => {
  const pool = answering({ rows: [{ slug: "a", url: "https://a.example" }, { slug: "b", url: "https://b.example" }, { slug: "old", url: "https://old.example" }] });
  const calls: any[] = [];
  const call = (async (url: string, init: any) => {
    calls.push([url, init.headers.authorization]);
    if (url.includes("b.example")) throw new Error("timeout");
    if (url.includes("old.example")) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify({ ran: 1, failed: 0, next: "2026-11-19T08:00:00.000Z" }));
  }) as any;
  const out = await wakeDue(pool, (slug) => `secret-${slug}`, call);
  assert.deepEqual(calls.sort(), [["https://a.example/maple/tick", "Bearer secret-a"], ["https://b.example/maple/tick", "Bearer secret-b"], ["https://old.example/maple/tick", "Bearer secret-old"]]);
  assert.deepEqual(out, [{ app: "a", ok: true, ran: 1, failed: 0 }, { app: "b", ok: false }, { app: "old", ok: false }]);
  assert.match(pool.asked[0].sql, /wake_at = now\(\) \+ interval '5 minutes'/);
  const later = pool.asked.slice(1).map((q: any) => q.args);
  assert.ok(later.some((a: any) => a[0] === "a" && a[1] === "2026-11-19T08:00:00.000Z"));
  assert.ok(later.some((a: any) => a.length === 1 && a[0] === "old"));
});

test("housekeeping: runs at most once an hour, keeps what is live or in an open change, and the last ten shipped", async () => {
  const { due, prune, KEEP_SHIPPED } = await import("../grove/src/upkeep.ts");
  assert.equal(await due(answering({ rowCount: 1 }), "prune"), true);
  assert.equal(await due(answering({ rowCount: 0 }), "prune"), false);
  const pool = answering({ rowCount: 3 }, { rowCount: 2 }, { rowCount: 0 }, { rowCount: 1 });
  assert.deepEqual(await prune(pool), { versions: 3, serviceCalls: 2, pretendPayments: 0, offers: 1 });
  const sql = pool.asked[0].sql;
  assert.match(sql, /a\.live = v\.id/);
  assert.match(sql, /c\.version = v\.id or c\.base = v\.id/);
  assert.match(sql, /shipped_at is null and v\.created_at < now\(\) - interval '2 days'/);
  assert.deepEqual(pool.asked[0].args, [KEEP_SHIPPED]);
  assert.equal(KEEP_SHIPPED, 10);
});
