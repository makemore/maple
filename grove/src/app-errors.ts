// Errors in the apps Grove runs. The kit in each app sends what went wrong to Grove (POST
// /services/errors/report, with the app's own secret); Grove passes it on to one Sentry project for all
// apps, tagged with the app it came from. Apps never hold a Sentry key, and since Grove decides the tag
// from the secret, an app can't file errors under another app's name. Makers read their own app's
// errors back through the app_errors tool, which only ever asks Sentry about that one app.
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { report } from "./errors.ts";

/**
 * Grove's own note of each kind of error an app has had, so it knows the moment something new goes
 * wrong (Sentry keeps the detail). errors_seen_at is when the maker's assistant last read them.
 */
export const APP_ERRORS_SCHEMA = `
create table if not exists app_failures (
  app text not null, key text not null, copy text not null, what text not null, place text not null,
  version bigint, times integer not null default 1, first_at timestamptz not null default now(),
  last_at timestamptz not null default now(), primary key (app, key));
alter table apps add column if not exists errors_seen_at timestamptz;
alter table apps add column if not exists errors_emailed_at timestamptz;`;

const env = (name: string) => (typeof process !== "undefined" ? process.env[name] : undefined);

/** Whether Grove collects apps' errors (SENTRY_DSN_APPS), and whether makers can read them back (SENTRY_API_TOKEN as well). */
export const collectingErrors = () => Boolean(env("SENTRY_DSN_APPS"));
export const readingErrors = () => Boolean(env("SENTRY_DSN_APPS") && env("SENTRY_API_TOKEN"));

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** What an app sent, made safe to keep: plain strings, cut to size. */
export function failureFrom(body: any) {
  const message = text(body?.message, 2000).trim();
  if (!message) return undefined;
  return {
    type: text(body?.type, 100).replace(/[^\w.$ -]/g, "") || "Error",
    message,
    stack: text(body?.stack, 8000),
    where: text(body?.where, 200).trim() || "the app",
  };
}

/**
 * Passes one of an app's errors to Sentry. At most 20 a minute for each app, so one app stuck in a
 * loop of failures can't use up the rest. Never throws.
 */
export async function keepFailure(slug: string, failure: NonNullable<ReturnType<typeof failureFrom>>, o: { trial: boolean; version?: number | string | null; fetcher?: typeof fetch }) {
  const dsn = env("SENTRY_DSN_APPS");
  if (!dsn || !SLUG.test(slug)) return false;
  const e = new Error(failure.message);
  e.name = failure.type;
  e.stack = `${failure.type}: ${failure.message}\n${failure.stack.split("\n").filter((l) => /^\s*at /.test(l)).join("\n")}`;
  const copy = o.trial ? "preview" : "live";
  return report(e, { where: failure.where }, {
    dsn,
    server: slug,
    environment: copy,
    tags: { app: slug, copy, where: failure.where.slice(0, 200), ...(o.version != null && { version: String(o.version) }) },
    // Grouped per app and per copy, so the same mistake in two apps is two issues (no app sees another's
    // events), and an error on a preview doesn't make the live one look older than it is.
    fingerprint: ["{{ default }}", slug, copy],
    bucket: `app:${slug}`,
    perMinute: 20,
    fetcher: o.fetcher,
  });
}

/** The same mistake again, even with different numbers or ids in its message, is the same kind of error. */
export const failureKey = (copy: string, f: { type: string; message: string; where: string }) =>
  createHash("sha256").update([copy, f.type, f.where.replace(/\d+/g, "#"), f.message.replace(/\b[0-9a-f-]{8,}\b|\d+/gi, "#").slice(0, 300)].join("|")).digest("hex").slice(0, 32);

/** Notes an error. Says whether it is a kind this app hasn't had before. */
export async function noteFailure(pool: Pick<Pool, "query">, slug: string, f: NonNullable<ReturnType<typeof failureFrom>>, o: { trial: boolean; version?: number | string | null }) {
  const copy = o.trial ? "preview" : "live";
  const { rows: [r] } = await pool.query(
    `insert into app_failures (app, key, copy, what, place, version) values ($1, $2, $3, $4, $5, $6)
     on conflict (app, key) do update set times = app_failures.times + 1, last_at = now(), version = coalesce(excluded.version, app_failures.version)
     returning (xmax = 0) as fresh`,
    [slug, failureKey(copy, f), copy, `${f.type}: ${f.message}`.slice(0, 500), f.where, o.version ?? null],
  );
  return { fresh: Boolean(r?.fresh), copy };
}

/**
 * Whether to email the makers about a new error now: only for the live app, and at most once an hour
 * for each app, so a run of new errors is one email. Claims the hour when it says yes.
 */
export async function shouldEmail(pool: Pick<Pool, "query">, slug: string) {
  const { rowCount } = await pool.query(
    "update apps set errors_emailed_at = now() where slug = $1 and (errors_emailed_at is null or errors_emailed_at < now() - interval '1 hour')",
    [slug],
  );
  return Boolean(rowCount);
}

/** The email to an app's makers when something new goes wrong in the live app. */
export function failureEmail(a: { slug: string; title: string; url: string }, f: { type: string; message: string; where: string }, site: string) {
  const subject = `${a.title}: something new went wrong`;
  const text = [
    `Something went wrong in ${a.title} (${a.url}) that hasn't happened before.`,
    "",
    `What: ${f.type}: ${f.message.slice(0, 500)}`,
    `Where: ${f.where}`,
    "",
    "To fix it, open the assistant you use with Grove and say:",
    `"Look at the new error in ${a.title} with app_errors and fix it on a preview."`,
    "",
    "It will show you the fix on a preview before anything changes for the people using the app.",
    "",
    "Prompt for your coding agent:",
    "-----",
    `In Grove, call app_errors for the app ${a.slug} and read the newest live error (${f.type} in ${f.where}). Read the files it points at, find the cause, fix it with write_files on a new change, check the preview, and tell me what was wrong and what you changed. Don't ship until I say so.`,
    "-----",
    "",
    `Grove emails about the live app at most once an hour. ${site}`,
  ].join("\n");
  return { subject, text };
}

/** How many kinds of error each app has had on its live copy since its maker's assistant last looked. */
export async function newFailures(pool: Pick<Pool, "query">, slugs: string[]) {
  if (!slugs.length) return {} as Record<string, number>;
  const { rows } = await pool.query(
    `select f.app, count(*)::int n from app_failures f join apps a on a.slug = f.app
     where f.app = any($1) and f.copy = 'live' and f.last_at > coalesce(a.errors_seen_at, 'epoch') group by f.app`,
    [slugs],
  );
  return Object.fromEntries(rows.map((r: { app: string; n: number }) => [r.app, r.n])) as Record<string, number>;
}

export const sawFailures = (pool: Pick<Pool, "query">, slug: string) => pool.query("update apps set errors_seen_at = now() where slug = $1", [slug]);

type Issue = { id: string; title: string; culprit?: string; count: string; firstSeen: string; lastSeen: string; level: string; status: string };

/** The newest errors from one app, from Sentry: what went wrong, where, how often, and the code lines it came from. */
export async function failuresOf(slug: string, o: { days?: number; copy?: "live" | "preview"; seen?: Date | null; shipped?: Date | null; fetcher?: typeof fetch } = {}) {
  if (!readingErrors()) throw new Error("Grove isn't collecting apps' errors yet. Ask the Grove maker.");
  if (!SLUG.test(slug)) throw new Error("That isn't an app's name.");
  const base = (env("SENTRY_API_URL") ?? "https://de.sentry.io").replace(/\/$/, "");
  const org = env("SENTRY_ORG") ?? "grove-0i", project = env("SENTRY_APPS_PROJECT") ?? "grove-apps";
  const get = async (path: string) => {
    const res = await (o.fetcher ?? fetch)(`${base}/api/0/${path}`, { headers: { authorization: `Bearer ${env("SENTRY_API_TOKEN")}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Sentry answered ${res.status}. Try again in a minute.`);
    return res.json();
  };
  // Sentry's issue list only looks back 24 hours or 14 days; anything in between is narrowed here.
  const days = Math.min(Math.max(Math.round(o.days ?? 14), 1), 14);
  const query = `app:${slug} is:unresolved${o.copy ? ` environment:${o.copy}` : ""}`;
  const since = Date.now() - days * 86_400_000;
  const issues: Issue[] = (await get(`projects/${org}/${project}/issues/?query=${encodeURIComponent(query)}&statsPeriod=${days <= 1 ? "24h" : "14d"}&sort=date&limit=10`))
    .filter((i: Issue) => new Date(i.lastSeen).getTime() >= since);
  const out = [];
  for (const issue of issues.slice(0, 8)) {
    const ev = await get(`organizations/${org}/issues/${issue.id}/events/latest/`).catch(() => undefined);
    const tags: Record<string, string> = Object.fromEntries((ev?.tags ?? []).map((t: { key: string; value: string }) => [t.key, t.value]));
    // Belt and braces: issues are grouped per app, but never show an event that isn't this app's.
    if (ev && tags.app !== slug) continue;
    const exception = ev?.entries?.find((x: any) => x.type === "exception")?.data?.values?.[0];
    const frames: any[] = exception?.stacktrace?.frames ?? [];
    out.push({
      what: exception ? `${exception.type}: ${exception.value}` : issue.title,
      where: tags.where ?? issue.culprit ?? "",
      copy: tags.copy ?? ev?.environment ?? "",
      ...(tags.version && { version: tags.version }),
      times: Number(issue.count),
      first: issue.firstSeen,
      last: issue.lastSeen,
      // New to the assistant (since it last read them), and whether it began after the live version shipped.
      ...(o.seen !== undefined && { new: !o.seen || new Date(issue.lastSeen) > o.seen }),
      ...(o.shipped && { sinceLastShip: new Date(issue.firstSeen) > o.shipped }),
      // Innermost call first, as a stack trace reads.
      code: frames.slice(-8).reverse().map((f) => `${f.function ?? "?"} (${f.filename ?? "?"}${f.lineNo ? `:${f.lineNo}` : ""})`),
    });
  }
  return out;
}
