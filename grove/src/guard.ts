// Keeping Grove safe to open up: pausing apps, blocking people, limits on how much one person can
// build or send, reports from the public, and a first look at code for things that are usually scams.
import type { Pool } from "pg";
import type { Files } from "./build.ts";
import { shell } from "./site.ts";

export const GUARD_SCHEMA = `
alter table apps add column if not exists paused_at timestamptz;
alter table apps add column if not exists paused_why text;
create table if not exists blocked (email text primary key, why text not null, at timestamptz not null default now());
create table if not exists reports (
  id bigserial primary key, app text not null, what text not null, reporter text,
  created_at timestamptz not null default now(), closed_at timestamptz);
create table if not exists notified (app text not null, day date not null default current_date, n int not null default 0, primary key (app, day));`;

export const buildsPerHour = (paid: boolean) => Number((paid ? process.env.PAID_BUILDS_PER_HOUR : process.env.BUILDS_PER_HOUR) ?? (paid ? 120 : 30));
export const emailsPerDay = () => Number(process.env.APP_EMAILS_PER_DAY ?? 50);
const REPORTS_PER_DAY = 100;
/** Neon allows ten database branches per project on its free plan: the live one, and one per open change. */
export const MAX_OPEN_CHANGES = 6;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Throws if this person has saved too many versions in the last hour. */
export async function underBuildLimit(pool: Pool, email: string, paid: boolean) {
  const { rows: [{ n }] } = await pool.query("select count(*)::int n from versions where author = $1 and created_at > now() - interval '1 hour'", [email]);
  if (n >= buildsPerHour(paid)) throw new Error(`That's ${n} saved changes in the last hour, which is the limit${paid ? "" : " on the free plan"}. Try again a little later.`);
}

/** Counts one email for an app today. False once the app has used up the day. */
export async function mayNotify(pool: Pool, app: string) {
  const { rows: [{ n }] } = await pool.query("insert into notified (app) values ($1) on conflict (app, day) do update set n = notified.n + 1 returning n", [app]);
  return n < emailsPerDay();
}

export async function blockedWhy(pool: Pool, email: string) {
  const { rows: [b] } = await pool.query("select why from blocked where email = $1", [email]);
  return b?.why as string | undefined;
}

/** What a paused app shows instead of itself: Neon runs this in place of the app's own code. */
export const pausedArchive = (title: string, grove: string) => ({
  "index.mjs": `const page = ${JSON.stringify(
    shell(`${title}: paused`, `<h1>This app is paused</h1><p>${esc(title)} isn't available at the moment. If you use it, the person who made it can tell you more.</p><p><a href="${grove}">About Grove</a></p>`),
  )};
export default { fetch: () => new Response(page, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "3600" } }) };
`,
});

/** Things in an app's code that are worth a person looking at. Not proof of anything, so it never blocks a save. */
export function concerns(files: Files): string[] {
  const found = new Set<string>();
  const brands = /\b(paypal|apple id|icloud|microsoft|office ?365|outlook|google|gmail|facebook|instagram|amazon|netflix|hmrc|royal mail|dhl|binance|coinbase|metamask|barclays|hsbc|lloyds|natwest|santander|revolut|monzo)\b/i;
  for (const [path, text] of Object.entries(files)) {
    if (/^src\/maple\//.test(path) || !/\.(ts|js|html|json|md)$/.test(path)) continue;
    const asksPassword = /type\s*=\s*\\?["']password/i.test(text);
    if (asksPassword) found.add(`${path} has a password box. Apps sign people in with an emailed code and never need one.`);
    if (/\b(card ?number|cvv|cvc|security code|sort ?code|account ?number)\b/i.test(text) && /<input|<form/i.test(text)) found.add(`${path} has a form that asks for card or bank details.`);
    if (/\b(seed phrase|recovery phrase|private key)\b/i.test(text) && /<input|<textarea/i.test(text)) found.add(`${path} asks for a wallet recovery phrase or private key.`);
    if (asksPassword && brands.test(text)) found.add(`${path} has a password box next to the name of a well-known company (${text.match(brands)![0]}).`);
  }
  return [...found];
}

/** Records a report unless the same one is already open. True if it is new. */
export async function report(pool: Pool, app: string, what: string, reporter?: string) {
  const { rows: [{ n }] } = await pool.query("select count(*)::int n from reports where created_at > now() - interval '1 day' and reporter is distinct from 'Grove check'");
  if (reporter !== "Grove check" && n >= REPORTS_PER_DAY) return false;
  const { rowCount } = await pool.query(
    "insert into reports (app, what, reporter) select $1, $2, $3 where not exists (select 1 from reports where app = $1 and what = $2 and closed_at is null)",
    [app, what.slice(0, 2000), reporter?.slice(0, 200) ?? null],
  );
  return Boolean(rowCount);
}

export const reportPage = (app: string, said?: string) =>
  shell(
    "Grove: report an app",
    `<h1>Report an app</h1>
  ${said ? `<p class="draft" role="status">${esc(said)}</p>` : ""}
  <p>Tell us if an app made with Grove is being used to trick people, send spam, or do something harmful. A person reads every report.</p>
  <form method="post" action="/report">
    <div><label for="app">The app's address or name</label><input id="app" name="app" required maxlength="200" value="${esc(app)}"></div>
    <div><label for="what">What is wrong?</label><textarea id="what" name="what" rows="5" required maxlength="2000"></textarea></div>
    <div><label for="email">Your email <span>(if you want a reply)</span></label><input id="email" name="email" type="email" autocomplete="email" maxlength="200"></div>
    <div><button class="btn">Send report</button></div>
  </form>
  <p><a href="/">Back to Grove</a></p>`,
  );

/** The app name from whatever someone typed: a name, an address, or a link. */
export const appNamed = (typed: string) => typed.trim().toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/)[0].split(".")[0];
