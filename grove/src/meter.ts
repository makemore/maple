// How much of a person's assistant allowance Grove is using. Grove sees only its own half of a chat: what
// the assistant sends to its tools and what comes back. The assistant's own thinking and replies, and the
// chat it re-reads on every turn, come on top, so these figures are a floor. They are still enough to tell
// a small job from a big one, and to stop and ask before a day's work gets large.
import type { Pool } from "pg";

export const METER_SCHEMA = `
create table if not exists usage (
  email text not null, app text not null default '', day date not null default current_date,
  calls int not null default 0, chars_in bigint not null default 0, chars_out bigint not null default 0,
  primary key (email, app, day));
create table if not exists usage_ok (email text not null, day date not null default current_date, upto bigint not null, primary key (email, day));`;

/** The tools that move a lot of text, and so are worth pausing before. Shipping, status and billing never are. */
export const HEAVY = new Set(["create_app", "read_files", "write_files", "update_kit"]);

/** Roughly four characters to a token, for English and code alike. */
export const tokens = (chars: number) => Math.ceil(chars / 4);

/** The first point in a day at which Grove stops and asks, in tokens of tool traffic. */
export const firstLimit = () => Number(process.env.USAGE_WARN_TOKENS ?? 150_000);

/** Each time the person agrees to carry on, the next stop is twice as far. */
export const nextLimit = (used: number, upto: number) => {
  let next = Math.max(upto, firstLimit());
  while (next <= used) next *= 2;
  return next;
};

export const sizeOf = (t: number) => (t < 10_000 ? "small" : t < 50_000 ? "medium" : "large");
export const rounded = (t: number) => (t < 1000 ? "under a thousand" : `about ${Math.round(t / 1000)} thousand`);

/** Counts one tool call. */
export const record = (pool: Pool, email: string, app: string, charsIn: number, charsOut: number) =>
  pool.query(
    "insert into usage (email, app, calls, chars_in, chars_out) values ($1, $2, 1, $3, $4) on conflict (email, app, day) do update set calls = usage.calls + 1, chars_in = usage.chars_in + $3, chars_out = usage.chars_out + $4",
    [email, app, charsIn, charsOut],
  );

/** Today's tool traffic for a person, in tokens, and how far they have agreed to go. */
export async function today(pool: Pool, email: string) {
  const { rows: [u] } = await pool.query(
    "select coalesce(sum(chars_in + chars_out), 0)::bigint chars, coalesce((select upto from usage_ok where email = $1 and day = current_date), 0)::bigint upto from usage where email = $1 and day = current_date",
    [email],
  );
  return { used: tokens(Number(u.chars)), upto: Math.max(Number(u.upto), firstLimit()) };
}

/** What to tell the assistant when today's work has reached the point the person agreed to, or nothing if it hasn't. */
export function stopMessage(used: number, upto: number) {
  if (used < upto) return;
  return `Stop and check with the person before doing more. Grove's tools alone have used ${rounded(used)} tokens of this person's assistant allowance today, and the true figure is several times that once the assistant's own thinking and the length of the chat are counted. On a Claude or ChatGPT subscription, a lot more of this can use up the day's allowance. Tell them that in plain words, suggest finishing what is in progress or starting a fresh chat (a long chat costs more per step), and ask whether they want to carry on. If they say yes, call accept_usage and then repeat this step. Don't call it unless they have said yes themselves.`;
}

/** Records that the person wants to carry on today, and returns the next point at which Grove will ask. */
export async function carryOn(pool: Pool, email: string) {
  const { used, upto } = await today(pool, email);
  const next = nextLimit(used, upto);
  await pool.query("insert into usage_ok (email, upto) values ($1, $2) on conflict (email, day) do update set upto = $2", [email, next]);
  return { used, next };
}

/** A person's usage by app: today, the last 30 days, and what one saved change has typically taken. */
export async function summary(pool: Pool, email: string) {
  const { rows } = await pool.query(
    `select u.app, sum(u.calls)::int calls, sum(u.chars_in + u.chars_out)::bigint chars,
            coalesce(sum(u.chars_in + u.chars_out) filter (where u.day = current_date), 0)::bigint chars_today,
            (select count(*)::int from versions v where v.app = u.app and v.author = $1 and v.created_at > now() - interval '30 days') saves
     from usage u where u.email = $1 and u.day > current_date - 30 group by u.app order by chars desc`,
    [email],
  );
  return rows.map((r) => {
    const t = tokens(Number(r.chars));
    return { app: r.app || "(not about one app)", calls: r.calls, tokensToday: tokens(Number(r.chars_today)), tokensLast30Days: t, ...(r.saves > 0 && { typicalChange: { tokens: Math.round(t / r.saves), size: sizeOf(t / r.saves) } }) };
  });
}
