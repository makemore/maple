// Showing that a website is yours before Grove puts a copy of it live. Any one of: a DNS record, a tag
// in the front page, a small file on the site, or a WordPress application password that can manage it.
import { resolveTxt } from "node:dns/promises";
import type { Pool } from "pg";
import { get } from "./fetcher.ts";

export const OWNER_SCHEMA = `
create table if not exists site_owners (email text not null, host text not null, how text not null, at timestamptz not null default now(), primary key (email, host));
create table if not exists site_imports (
  id bigserial primary key, app text not null, change text not null, source text not null, kind text not null, by_email text not null,
  status text not null default 'running', progress jsonb not null default '{}', result jsonb, error text,
  started_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists site_imports_app on site_imports (app, id);
alter table site_imports add column if not exists params jsonb not null default '{}';
alter table site_imports add column if not exists by_maker boolean not null default false;
alter table site_imports add column if not exists attempts int not null default 0;
create table if not exists uploads (
  id uuid primary key, app text not null, name text not null, type text not null, bytes integer not null, by_email text, at timestamptz not null default now());`;

export const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

/** The code a person puts on their site. The same person and site always get the same one. */
export const ownerCode = (email: string, host: string, sign: (what: string) => string) => `grove-verify=${sign(`owns:${email}:${bareHost(host)}`).slice(0, 32)}`;

export async function owns(pool: Pool, emails: string[], host: string) {
  const { rows } = await pool.query("select email, how from site_owners where email = any($1) and host = $2", [emails, bareHost(host)]);
  return rows[0] as { email: string; how: string } | undefined;
}

type Check = { how: string; ok: boolean; note?: string };

/** Tries each way of showing the site is theirs. The first that works is recorded. */
export async function checkOwner(pool: Pool, email: string, host: string, sign: (what: string) => string, wordpress?: { user: string; appPassword: string }, txt = resolveTxt): Promise<{ verified: boolean; how?: string; tried: Check[]; code: string }> {
  const h = bareHost(host), code = ownerCode(email, h, sign), tried: Check[] = [];
  const has = (s: string) => s.includes(code);
  for (const name of [h, `_grove.${h}`, `www.${h}`]) {
    const records = await txt(name).catch(() => [] as string[][]);
    if (records.some((r) => has(r.join("")))) {
      tried.push({ how: `DNS TXT record on ${name}`, ok: true });
      break;
    }
  }
  if (!tried.some((t) => t.ok)) tried.push({ how: "DNS TXT record", ok: false });
  const pages = [`https://${h}/`, `https://www.${h}/`];
  if (!tried.some((t) => t.ok))
    for (const u of pages) {
      const r = await get(u, { maxBytes: 3_000_000, timeoutMs: 12_000 }).catch(() => undefined);
      const tag = r?.text().match(/<meta[^>]+name=["']grove-verify["'][^>]*>/i)?.[0] ?? "";
      const value = tag.match(/content=["']([^"']+)["']/i)?.[1]?.trim() ?? "";
      if (value && (value === code || `grove-verify=${value}` === code)) {
        tried.push({ how: `tag on ${u}`, ok: true });
        break;
      }
    }
  if (!tried.some((t) => t.ok)) tried.push({ how: "tag in the front page", ok: false });
  if (!tried.some((t) => t.ok))
    for (const u of [`https://${h}/grove-verify.txt`, `https://${h}/.well-known/grove-verify.txt`, `https://www.${h}/grove-verify.txt`]) {
      const r = await get(u, { maxBytes: 10_000, timeoutMs: 10_000 }).catch(() => undefined);
      if (r?.status === 200 && has(r.text())) {
        tried.push({ how: `file at ${u}`, ok: true });
        break;
      }
    }
  if (!tried.some((t) => t.ok)) tried.push({ how: "file on the site", ok: false });
  if (wordpress && !tried.some((t) => t.ok)) {
    const auth = "Basic " + Buffer.from(`${wordpress.user}:${wordpress.appPassword.replace(/\s+/g, "")}`).toString("base64");
    let ok = false, note = "";
    for (const base of [`https://${h}`, `https://www.${h}`]) {
      const r = await get(`${base}/wp-json/wp/v2/users/me?context=edit&_fields=roles,capabilities`, { maxBytes: 200_000, headers: { authorization: auth } }).catch(() => undefined);
      if (!r) continue;
      if (r.status === 401 || r.status === 403) note = "WordPress didn't accept that name and application password.";
      if (r.status !== 200) continue;
      const me = JSON.parse(r.text());
      ok = Boolean(me.capabilities?.manage_options || me.capabilities?.edit_pages || (me.roles ?? []).some((x: string) => ["administrator", "editor"].includes(x)));
      if (!ok) note = "That WordPress account can't manage the site. Use an administrator or editor.";
      break;
    }
    tried.push({ how: "WordPress application password", ok, ...(note && { note }) });
  }
  const win = tried.find((t) => t.ok);
  if (win) await pool.query("insert into site_owners (email, host, how) values ($1, $2, $3) on conflict (email, host) do update set how = $3, at = now()", [email, h, win.how]);
  return { verified: Boolean(win), how: win?.how, tried, code };
}

/** Ways to show a site is yours, in words for the person, with their code. */
export const ownerHelp = (host: string, code: string) => ({
  code,
  waysToShowItsYours: [
    `Add a DNS TXT record on ${host} (or _grove.${host}) with the value ${code}. Your domain company's DNS settings do this; it can take a few minutes to show.`,
    `Put <meta name="grove-verify" content="${code.slice("grove-verify=".length)}"> in your site's head. WordPress: a header-code plugin. Squarespace: Settings, Advanced, Code injection. Wix: Settings, Custom code.`,
    `Put a file called grove-verify.txt at https://${host}/grove-verify.txt containing ${code}.`,
    "WordPress only: make an application password (Users, Profile, Application passwords) for an administrator or editor, and give the name and password to verify_site. Grove checks it once and doesn't keep it.",
  ],
  then: "Call verify_site again once one of these is in place. The code can come off the site afterwards.",
});
