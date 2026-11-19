// Private previews for outreach: Grove's maker picks a business whose website could move to Grove, Grove
// copies its public pages into a preview only someone with the link can see, and the maker writes to the
// business with the link. Nothing goes live: the preview says it isn't the live site, keeps out of search
// engines, runs no scripts, and deletes itself after PREVIEW_DAYS. The business can delete it (and stop
// hearing from Grove) in one click, or claim it: sign up, show the site is theirs, and import it properly.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { Preview } from "./importer.ts";

export const PROSPECTS_SCHEMA = `
create table if not exists prospects (
  id bigserial primary key, host text not null unique, business text not null, contact text, token text not null unique,
  status text not null default 'building', platform text, preview jsonb, error text, note text, by_email text not null,
  claimed_by text, created_at timestamptz not null default now(), emailed_at timestamptz,
  expires_at timestamptz not null default now() + interval '14 days', updated_at timestamptz not null default now());
create table if not exists prospect_optouts (what text primary key, at timestamptz not null default now());`;

export const PREVIEW_DAYS = 14;
/** At most this many previews a week, so outreach stays personal and small. */
export const PER_WEEK = () => Number(process.env.PROSPECTS_PER_WEEK ?? 25);
export const PREVIEW_LIMITS = { pages: 15, images: 0, imageBytes: 0, codeBudget: 3_000_000, seconds: 90 };

export const newToken = () => randomBytes(18).toString("base64url");

/** Whether the business (by its site, or the address we'd write to) asked not to hear from Grove. */
export async function optedOut(pool: Pool, host: string, contact?: string) {
  const { rows } = await pool.query("select what from prospect_optouts where what = any($1)", [[host.toLowerCase(), contact?.toLowerCase()].filter(Boolean)]);
  return rows.length > 0;
}

/** The preview is gone and the business won't be written to again. */
export async function optOut(pool: Pool, token: string) {
  const { rows: [p] } = await pool.query("update prospects set status = 'declined', preview = null, updated_at = now() where token = $1 returning host, contact", [token]);
  if (!p) return false;
  for (const what of [p.host, p.contact].filter(Boolean)) await pool.query("insert into prospect_optouts (what) values ($1) on conflict do nothing", [String(what).toLowerCase()]);
  return true;
}

/** Previews past their date are emptied. Run from the cron tick. */
export const expire = (pool: Pool) => pool.query("update prospects set status = 'expired', preview = null, updated_at = now() where expires_at < now() and status in ('building', 'ready', 'emailed', 'failed')");

/**
 * What the business is likely paying now, from the cheapest plans that platform sells (rounded down, so the
 * email never overstates it). Check these now and then: they're only used in words like "from about".
 */
export const PLATFORM_COST: Record<string, { from: number; what: string }> = {
  Squarespace: { from: 12, what: "Squarespace plans" },
  Wix: { from: 9, what: "Wix plans without ads" },
  Webflow: { from: 12, what: "Webflow site plans" },
  WordPress: { from: 5, what: "WordPress hosting" },
  GoDaddy: { from: 8, what: "GoDaddy's website builder" },
  Weebly: { from: 8, what: "Weebly plans" },
  Jimdo: { from: 8, what: "Jimdo plans" },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Pictures from anywhere, scripts from nowhere, embeds only from the usual video and map sites. */
const POLICY = "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; style-src 'self' 'unsafe-inline' https:; img-src * data:; font-src * data:; media-src *; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.google.com https://maps.google.com; frame-ancestors 'none'";
export const PREVIEW_HEADERS = { "content-security-policy": POLICY, "x-robots-tag": "noindex, nofollow, noarchive", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cache-control": "private, no-store" };

const banner = (p: { host: string; business: string; expires: Date }, base: string) =>
  `<div role="note" style="position:sticky;top:0;z-index:2147483647;padding:10px 16px;background:#fff4c2;color:#3b2f00;font:15px/1.45 system-ui,sans-serif;text-align:center;border-bottom:1px solid #e0cf7a">` +
  `A private preview of <strong>${esc(p.host)}</strong>, made by Grove for ${esc(p.business)}. It isn't live, nothing on your site has changed, and it deletes itself on ${p.expires.toISOString().slice(0, 10)}. ` +
  `<a href="${base}/claim" style="color:#1f5135;font-weight:700">Keep it</a> · <a href="${base}/no" style="color:#3b2f00">Delete it now</a></div>`;

/** One page of a preview, or undefined when there's no such page. */
export function previewPage(row: { host: string; business: string; expires_at: Date; preview: Preview }, base: string, path: string) {
  const key = (path.replace(/\/+$/, "") || "/").replace(/\.html?$/, "");
  const p = row.preview.pages.find((x) => x.path === key);
  if (!p) return;
  return `<!doctype html>
<html${p.lang ? ` lang="${esc(p.lang)}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>Preview: ${esc(p.title)}</title>
${p.styles.map((s) => `<link rel="stylesheet" href="${esc(s)}">`).join("\n")}
</head>
<body${p.bodyClass ? ` class="${esc(p.bodyClass)}"` : ""}>
${banner({ host: row.host, business: row.business, expires: row.expires_at }, base)}${p.body}
</body>
</html>`;
}

const plainPage = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>body{font:17px/1.55 system-ui,sans-serif;max-width:38rem;margin:3rem auto;padding:0 1rem;color:#1d2a22;background:#fbfaf6}h1{font-size:1.6rem}button{font:inherit;padding:.6rem 1.2rem;border-radius:.6rem;border:0;background:#1f5135;color:#fff;cursor:pointer}code{background:#eee;padding:.1rem .3rem;border-radius:.3rem}a{color:#1f5135}</style>
</head><body>${body}</body></html>`;

export const noPage = (host: string, base: string) =>
  plainPage("Delete this preview", `<h1>Delete the preview of ${esc(host)}?</h1><p>This deletes Grove's private preview of your site straight away, and Grove won't contact you about it again. Your own site isn't affected either way.</p><form method="post" action="${base}/no"><button>Delete it</button></form>`);
export const gonePage = () => plainPage("Deleted", `<h1>Deleted</h1><p>The preview is gone and Grove won't contact you about it again. Sorry to have bothered you.</p>`);

export const claimPage = (host: string, token: string, site: string, connect: string) =>
  plainPage(
    "Keep this site",
    `<h1>Keep ${esc(host)} on Grove</h1>
<p>Grove runs websites and small business tools that you change by asking your AI assistant, instead of logging in to a site builder. Your site can run on your own domain for free, with a small "Made with Grove" line at the bottom, or without it on the paid plan.</p>
<ol>
<li>Add Grove to your AI assistant (Claude, ChatGPT, Gemini, Grok or another) as a connector, with the address <code>${esc(connect)}</code>. (<a href="${esc(site)}/#connect">Step by step</a>.)</li>
<li>In a chat, say: <em>"Claim my Grove preview ${esc(token)}"</em>.</li>
<li>Grove asks you to show the site is yours (a line in your DNS or on your site), then copies it properly, pictures and all.</li>
</ol>
<p>Nothing changes on your current site until you point your domain at Grove, and you can take the code away whenever you like.</p>
<p><a href="${esc(site)}">More about Grove</a></p>`,
  );

/** The email Grove's maker sends, in plain words: who we are, what we made, what it'd cost, and how to say no. */
export function emailFor(p: { business: string; host: string; platform: string | null; expires_at: Date }, links: { preview: string; no: string }, from: { name: string; legal?: string; contact?: string }) {
  const cost = p.platform ? PLATFORM_COST[p.platform] : undefined;
  const now = cost ? `${p.host} is built with ${p.platform}, and ${cost.what} cost from about £${cost.from} a month.` : "Sites like yours usually cost something every month to keep running.";
  const subject = `A free copy of the ${p.business} website`;
  const body = `Hello,

I run Grove (makewithgrove.com), which hosts small business websites for free. ${now}

I made a private preview of your site running on Grove, so you can see it before deciding anything:
${links.preview}

Nothing has changed on your current site, and only someone with that link can see the preview. If you'd like to keep it, it can run on your own domain for free with a small "Made with Grove" line at the bottom, or £10 a month without it. Changes are made by asking an AI assistant such as Claude, rather than logging in to a site builder.

If it's not for you, there's no need to reply: the preview deletes itself on ${p.expires_at.toISOString().slice(0, 10)}. To delete it now and not hear from me again, use this link:
${links.no}

${from.name}
${[from.legal, from.contact].filter(Boolean).join(" · ") || "Grove, makewithgrove.com"}`;
  return { subject, body };
}
