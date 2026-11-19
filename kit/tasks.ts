// Background work: jobs that run later or on a timer.
//
// Everything lives in the app's own database (the maple_tasks table), so it goes wherever the app
// goes. The app does nothing between requests, so something outside has to call POST /maple/tick
// to run what is due. Grove does that for the apps it runs. Anywhere else, any scheduler will do:
// cron with curl, Cloud Scheduler, EventBridge, a GitHub Action. See TICK below.
import type { Pool } from "pg";

export const TASKS_SCHEMA = `
create table if not exists maple_tasks (
  id bigserial primary key, name text not null, payload jsonb not null default '{}',
  run_at timestamptz not null, every_minutes integer, daily_at text,
  attempts integer not null default 0, last_error text, last_ran_at timestamptz,
  done_at timestamptz, cancelled_at timestamptz, created_at timestamptz not null default now());
create index if not exists maple_tasks_due on maple_tasks (run_at) where done_at is null and cancelled_at is null;
`;

/**
 * TICK: how jobs get run outside Grove. Set MAPLE_TICK_SECRET on the app, then have a scheduler
 * call this once a minute (less often is fine; jobs just run later):
 *
 *   curl -fsS -X POST https://your-app.example/maple/tick -H "Authorization: Bearer $MAPLE_TICK_SECRET"
 *
 * It runs what is due and answers { ran, failed, next } where next is when the following job is due.
 */
export const TICK_PATH = "/maple/tick";

/** A job gives up after this many failed tries. Each retry waits longer than the last. */
export const MAX_TRIES = 5;
const TICK_BUDGET_MS = 25_000;
const TICK_MAX = 25;

export interface Tasks {
  /** Runs the job called name once, after a delay. The job is one of the app's `jobs`. */
  later(name: string, payload: unknown, when: { inMinutes: number }): Promise<{ id: string; runsAt: string; note?: string }>;
  /** Runs the job called name again and again. Calling it again with the same name replaces the old timing. */
  every(name: string, how: { hours: number } | { dailyAt: string }): Promise<{ id: string; next: string; note?: string }>;
  /** Stops a job started with later or every. */
  cancel(id: string): Promise<{ id: string; cancelled: boolean }>;
}

/** The app's jobs: what to do when a named job comes due. Throwing means "try again later". */
export type Jobs<C = unknown> = Record<string, (payload: any, ctx: C) => Promise<void> | void>;

/** The next time a daily job should run: the coming HH:MM, in UTC. */
export function nextDaily(dailyAt: string, now = new Date()) {
  const [h, m] = dailyAt.split(":").map(Number);
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  if (at <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

/** When a repeating job runs next, after running now. */
export const nextRun = (t: { every_minutes?: number | null; daily_at?: string | null }, now = new Date()) =>
  t.daily_at ? nextDaily(t.daily_at, now) : t.every_minutes ? new Date(now.getTime() + t.every_minutes * 60_000) : null;

/** How long to wait before the next try of a job that just failed for the nth time. */
export const retryInMinutes = (attempts: number) => Math.min(5 * 2 ** Math.max(0, attempts - 1), 360);

export function createTasks(o: { pool: Pool; init: () => Promise<unknown>; names: () => string[]; wake?: (at: Date) => Promise<unknown>; trial?: boolean }): Tasks {
  const known = (name: string) => {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,59}$/.test(name)) throw new Error("A job's name is lowercase letters, digits, - and _, up to 60 characters.");
    if (!o.names().includes(name)) throw new Error(`This app has no job called ${name}. Its jobs are: ${o.names().join(", ") || "none yet"}.`);
  };
  const note = o.trial ? { note: "This is a trial copy, where jobs don't run by themselves. The maker can run them with the jobs tool, or they run once the change is live." } : {};
  const woken = async (at: Date | string) => void (await o.wake?.(new Date(at)).catch(() => undefined));
  return {
    async later(name, payload, when) {
      known(name);
      const mins = Number(when?.inMinutes);
      if (!(mins >= 0 && mins <= 60 * 24 * 366)) throw new Error("inMinutes must be a number of minutes, up to a year.");
      const body = JSON.stringify(payload ?? {});
      if (body.length > 20_000) throw new Error("A job's payload is too big. Keep the details in a table and pass an id.");
      await o.init();
      const { rows: [t] } = await o.pool.query("insert into maple_tasks (name, payload, run_at) values ($1, $2, now() + $3 * interval '1 minute') returning id, run_at", [name, body, mins]);
      await woken(t.run_at);
      return { id: String(t.id), runsAt: new Date(t.run_at).toISOString(), ...note };
    },
    async every(name, how) {
      known(name);
      const hours = "hours" in how ? Number(how.hours) : undefined;
      const dailyAt = "dailyAt" in how ? String(how.dailyAt) : undefined;
      // Whoever runs the app may set how often a repeating job can run (each run wakes the database).
      const least = Math.max(0.25, Number(process.env.MAPLE_MIN_JOB_HOURS) || 0);
      if (dailyAt === undefined && !(hours! >= least && hours! <= 24 * 31)) throw new Error(`Give hours (${least} or more${least > 0.25 ? " on this app's plan" : ""}) or dailyAt (a UTC time like "08:00").`);
      if (dailyAt !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyAt)) throw new Error('dailyAt must be a UTC time like "08:00".');
      const first = dailyAt ? nextDaily(dailyAt) : new Date(Date.now() + hours! * 3_600_000);
      await o.init();
      await o.pool.query("update maple_tasks set cancelled_at = now() where name = $1 and done_at is null and cancelled_at is null and (every_minutes is not null or daily_at is not null)", [name]);
      const { rows: [t] } = await o.pool.query("insert into maple_tasks (name, run_at, every_minutes, daily_at) values ($1, $2, $3, $4) returning id, run_at", [name, first, dailyAt ? null : Math.round(hours! * 60), dailyAt ?? null]);
      await woken(t.run_at);
      return { id: String(t.id), next: new Date(t.run_at).toISOString(), ...note };
    },
    async cancel(id) {
      await o.init();
      const { rowCount } = await o.pool.query("update maple_tasks set cancelled_at = now() where id = $1 and done_at is null and cancelled_at is null", [Number(id) || 0]);
      return { id: String(id), cancelled: Boolean(rowCount) };
    },
  };
}

/**
 * Runs the jobs that are due, a few at a time, and says when the next one is.
 * Safe to call from several places at once: each job is claimed before it runs, and claiming
 * it also books its next try, so a job that crashes the app is tried again rather than lost.
 */
export async function tick<C>(pool: Pool, jobs: Jobs<C>, ctx: C, now = () => new Date(), failed_?: (name: string, e: unknown) => unknown) {
  const started = now().getTime();
  let ran = 0, failed = 0;
  while (ran + failed < TICK_MAX && now().getTime() - started < TICK_BUDGET_MS) {
    const { rows: [t] } = await pool.query(
      `update maple_tasks set attempts = attempts + 1, last_ran_at = now(),
         run_at = now() + least(5 * power(2, attempts), 360) * interval '1 minute'
       where id = (select id from maple_tasks where done_at is null and cancelled_at is null and run_at <= now() and attempts < $1
                   order by run_at for update skip locked limit 1)
       returning id, name, payload, every_minutes, daily_at, attempts`,
      [MAX_TRIES],
    );
    if (!t) break;
    try {
      const job = jobs[t.name];
      if (!job) throw new Error(`This app has no job called ${t.name}.`);
      await job(t.payload, ctx);
      const next = nextRun(t, now());
      if (next) await pool.query("update maple_tasks set run_at = $2, attempts = 0, last_error = null where id = $1", [t.id, next]);
      else await pool.query("update maple_tasks set done_at = now(), last_error = null where id = $1", [t.id]);
      ran++;
    } catch (e) {
      failed++;
      const why = String((e as Error)?.message ?? e).slice(0, 1000);
      console.error(`job ${t.name} #${t.id} failed (try ${t.attempts}):`, why);
      await Promise.resolve(failed_?.(t.name, e)).catch(() => undefined);
      // A repeating job that keeps failing skips to its next usual time instead of stopping for good.
      const next = t.attempts >= MAX_TRIES ? nextRun(t, now()) : null;
      if (next) await pool.query("update maple_tasks set last_error = $2, run_at = $3, attempts = 0 where id = $1", [t.id, why, next]);
      else await pool.query("update maple_tasks set last_error = $2 where id = $1", [t.id, why]);
    }
  }
  const { rows: [{ next }] } = await pool.query("select min(run_at) as next from maple_tasks where done_at is null and cancelled_at is null and attempts < $1", [MAX_TRIES]);
  return { ran, failed, next: next ? new Date(next).toISOString() : null };
}

/** What is waiting, and what has given up, for the maker. */
export async function jobList(pool: Pool) {
  const { rows } = await pool.query(
    `select id, name, run_at, every_minutes, daily_at, attempts, last_error, last_ran_at, (attempts >= $1) as gave_up
     from maple_tasks where done_at is null and cancelled_at is null order by run_at limit 50`,
    [MAX_TRIES],
  );
  return rows;
}
