// The stronger half of keeping Grove safe to open up: checks that stop things rather than flag them.
// New accounts start with limits that lift after a few days; app names can't borrow big brands;
// throwaway email addresses can't make apps; shipping is refused for the clearest signs of a scam,
// for links on Google's list of dangerous sites, and (when it's switched on) when an AI review of the
// public pages says they impersonate someone or collect credentials or payments.
import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import type { Files } from "./build.ts";
import { sensitiveHost } from "./importer.ts";

/** How long an account is new for, and what a new account may do. */
export const NEW_DAYS = () => Number(process.env.NEW_ACCOUNT_DAYS ?? 3);
export const NEW_APPS = () => Number(process.env.NEW_ACCOUNT_APPS ?? 3);
/** Emails a person's apps may send in a day, all of them together. */
export const personEmailsPerDay = (paid: boolean) => Number(process.env.PERSON_EMAILS_PER_DAY ?? 100) * (paid ? 10 : 1);

export const SAFETY_SCHEMA = `
alter table apps add column if not exists limited boolean not null default false;
create table if not exists reviews (id bigserial primary key, app text not null, version bigint, verdict text not null, why text, at timestamptz not null default now());`;

// --- Throwaway email addresses ---

const DISPOSABLE = new Set(`10minutemail.com 10minutemail.net 20minutemail.com 33mail.com anonaddy.me burnermail.io byom.de
discard.email dispostable.com dropmail.me emailondeck.com fakeinbox.com fakemail.net getairmail.com getnada.com guerrillamail.biz
guerrillamail.com guerrillamail.de guerrillamail.info guerrillamail.net guerrillamail.org guerrillamailblock.com harakirimail.com
inboxbear.com incognitomail.org jetable.org mailcatch.com maildrop.cc mailinator.com mailinator.net mailinator2.com mailnesia.com
mailnull.com mailpoof.com mailsac.com mailtemp.net mintemail.com moakt.com mohmal.com mytemp.email mytrashmail.com nada.email
emailfake.com tempmail.dev temp-mail.io temp-mail.org tempail.com tempinbox.com tempmail.com tempmail.net tempmailo.com tempr.email
throwawaymail.com tmail.ws tmailor.com tmpmail.net tmpmail.org trashmail.com trashmail.de trashmail.io trashmail.net wegwerfmail.de
yopmail.com yopmail.fr yopmail.net sharklasers.com grr.la spam4.me spamgourmet.com spambox.us mail.tm mail.gw linshiyouxiang.net
emailtemporanea.net crazymailing.com mailforspam.com minuteinbox.com luxusmail.org fexbox.org rover.info tempmailaddress.com
inboxkitten.com mvrht.net 1secmail.com 1secmail.net 1secmail.org esiix.com wwjmp.com xojxe.com yoggm.com kzccv.com qiott.com`.split(/\s+/));

/** True for an address at a service that hands out throwaway inboxes. */
export const disposable = (email: string) => {
  const domain = email.toLowerCase().split("@")[1] ?? "";
  return DISPOSABLE.has(domain) || [...DISPOSABLE].some((d) => domain.endsWith(`.${d}`));
};

// --- App names ---

const RISKY = /^(login|log|signin|sign|logon|secure|security|verify|verification|account|accounts|support|helpdesk|billing|wallet|refund|refunds|pay|payment|payments|bank|banking|recovery|unlock|update|confirm|official|service|services|customer|care|help|id|auth|password|claim|prize|gift|giveaway|crypto|airdrop)$/;

/**
 * Why an app's name or title can't be used: a big brand's name on its own, a brand next to words like
 * "login" or "refund", or a government, bank or health service look. Ordinary names that happen to
 * contain a brand's word ("apple-crumble-bakery") are fine.
 */
export function nameProblem(name: string, title: string) {
  for (const text of [name, title]) {
    const parts = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").filter(Boolean);
    if (!parts.length) continue;
    const brand = parts.find((p) => p.length > 2 && sensitiveHost(`${p}.com`)?.startsWith("a big company"));
    if (brand && (parts.length === 1 || parts.some((p) => RISKY.test(p)) || parts.every((p) => p === brand || p.length <= 3)))
      return `"${text}" uses the name of a well-known company (${brand}) in a way people use to trick others`;
    const joined = parts.join(".");
    if (/(^|\.)(gov|hmrc|nhs|irs|dvla|police)(\.|$)/.test(joined)) return `"${text}" looks like a government or health service name`;
    if (brand === undefined && parts.some((p) => p === "bank" || p === "banking") && parts.some((p) => RISKY.test(p) && p !== "bank" && p !== "banking")) return `"${text}" looks like a bank's sign-in page`;
  }
  return undefined;
}

// --- How much a person is trusted yet ---

export type Trust = { trusted: boolean; why: string; days: number };

/** New accounts are limited for their first days, unless they pay or have shown they run a website. */
export async function trustOf(pool: Pool, email: string, o: { paid: boolean; isMaker?: boolean }): Promise<Trust> {
  if (o.isMaker) return { trusted: true, why: "Grove's maker", days: 999 };
  const { rows: [r] } = await pool.query(
    `select coalesce(extract(epoch from now() - (select added_at from maple_people where email = $1)) / 86400, 0)::float days,
       exists (select 1 from site_owners where email = $1) owns,
       exists (select 1 from maple_people where email = $1 and role = 'maker') grove_maker,
       (select count(*) from reports r join apps a on a.slug = r.app where $1 = any(a.makers) and r.closed_at is null)::int reported`,
    [email],
  );
  const days = Number(r?.days ?? 0);
  if (r?.grove_maker) return { trusted: true, why: "Grove's maker", days };
  if (r?.reported) return { trusted: false, why: "there are open reports about this account's apps", days };
  if (o.paid) return { trusted: true, why: "on the paid plan", days };
  if (r?.owns) return { trusted: true, why: "has shown they run a website", days };
  if (days >= NEW_DAYS()) return { trusted: true, why: `account is ${Math.floor(days)} days old`, days };
  return { trusted: false, why: `account is new (limits lift after ${NEW_DAYS()} days, on the paid plan, or once you've shown you run a website with verify_site)`, days };
}

/** Emails every app this person makes has sent in the last day. */
export async function personEmailsToday(pool: Pool, email: string) {
  const { rows: [{ n }] } = await pool.query(
    "select coalesce(sum(jsonb_array_length(c.result->'sent')), 0)::int n from service_calls c join apps a on a.slug = c.app where c.service = 'email' and c.at > now() - interval '1 day' and a.makers[1] = $1",
    [email],
  );
  return n as number;
}

// --- Things that stop a ship ---

const skip = (path: string) => /^src\/maple\//.test(path) || !/\.(ts|js|html|json|md|txt|css)$/.test(path);

/** The clearest signs of a scam in an app's code. Unlike concerns(), these stop the change going live. */
export function blocking(files: Files): string[] {
  const found = new Set<string>();
  const brands = /\b(paypal|apple id|icloud|microsoft|office ?365|outlook|gmail|facebook|instagram|amazon|netflix|hmrc|royal mail|dhl|binance|coinbase|metamask|barclays|hsbc|lloyds|natwest|santander|revolut|monzo|chase|wells fargo|bank of america)\b/i;
  for (const [path, text] of Object.entries(files)) {
    if (skip(path)) continue;
    const password = /type\s*=\s*\\?["']password/i.test(text);
    if (password) found.add(`${path} has a password box. Apps sign people in with an emailed code, so a page asking for a password is how scams look.`);
    if (/\b(card ?number|cvv|cvc|card security code|sort ?code|account ?number|iban)\b/i.test(text) && /<input|<form/i.test(text)) found.add(`${path} has a form asking for card or bank details. Payments go through Grove's payment service, never a form in the app.`);
    if (/\b(seed phrase|recovery phrase|secret recovery|private key|mnemonic)\b/i.test(text) && /<input|<textarea/i.test(text)) found.add(`${path} asks for a wallet recovery phrase or private key.`);
    if (/\b(verify|confirm|unlock|suspended|restore)\b[^.]{0,60}\b(your )?(account|identity|login)\b/i.test(text) && brands.test(text) && /<input|<form/i.test(text)) found.add(`${path} asks people to verify an account with ${text.match(brands)![0]}.`);
  }
  return [...found];
}

/** Every outside web address in the app's code, for checking against lists of dangerous sites. */
export function outsideUrls(files: Files, own: string[] = []) {
  const urls = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    if (skip(path) || path === "package.json" || path === "package-lock.json") continue;
    for (const m of text.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/[^\s"'`<>\\)]*)?/gi)) {
      const u = m[0].replace(/[.,;]+$/, "");
      try {
        const host = new URL(u).hostname;
        if (!own.some((o) => host === o || host.endsWith(`.${o}`))) urls.add(u);
      } catch {}
    }
  }
  return [...urls].slice(0, 500);
}

/** Addresses Google Safe Browsing knows as malware, phishing or unwanted software. Nothing when no key is set. */
export async function dangerousUrls(urls: string[], key = process.env.SAFE_BROWSING_KEY, fetcher = fetch): Promise<string[]> {
  if (!key || !urls.length) return [];
  const res = await fetcher(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client: { clientId: "grove", clientVersion: "1.0" },
      threatInfo: { threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"], platformTypes: ["ANY_PLATFORM"], threatEntryTypes: ["URL"], threatEntries: urls.map((url) => ({ url })) },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Safe Browsing answered ${res.status}`);
  const out = (await res.json()) as { matches?: { threat: { url: string } }[] };
  return [...new Set((out.matches ?? []).map((m) => m.threat.url))];
}

// --- An AI review of what the public will see ---

/** The words and forms of an app's pages, as a reviewer would read them: HTML found anywhere in the code. */
export function publicText(files: Files, max = 60_000) {
  const parts: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (skip(path) || !/<(html|body|form|h1|h2|p|a|input|div)[\s>]/i.test(text)) continue;
    const words = text
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/\s(class|style|id|data-[\w-]+)="[^"]*"/gi, "")
      .replace(/\s+/g, " ");
    parts.push(`--- ${path} ---\n${words}`);
  }
  const all = parts.join("\n");
  return all.length > max ? all.slice(0, max) + "\n[cut short]" : all;
}

export type Review = { verdict: "ok" | "hold"; why: string };

const REVIEW_PROMPT = `You review small web apps made with Grove before they go live. Each app is made by one person for themselves,
a small business or a club. Hold an app only when its pages are clearly meant to deceive: pretending to be a bank, a government,
a delivery company or another well-known organisation the maker doesn't run; collecting passwords, card numbers, bank details,
wallet recovery phrases or identity documents; or pushing people to download or pay for something under false pretences.
Ordinary businesses, clubs, shops, portfolios, booking and sign-up forms, and pages that mention other companies are fine.
When unsure, say ok: a person also reads reports. Give a one-sentence reason a maker could understand.`;

/** Asks Claude whether the public pages look like a scam. Undefined when there's no API key or nothing to read. */
export async function aiReview(text: string, client?: Anthropic): Promise<Review | undefined> {
  if (!text.trim() || (!client && !process.env.ANTHROPIC_API_KEY)) return undefined;
  const ai = client ?? new Anthropic();
  const response = await ai.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: REVIEW_PROMPT,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { verdict: { type: "string", enum: ["ok", "hold"] }, why: { type: "string" } }, required: ["verdict", "why"], additionalProperties: false },
      },
    },
    messages: [{ role: "user", content: `The app's pages and forms:\n\n${text}` }],
  });
  if (response.stop_reason === "refusal") return { verdict: "hold", why: "The automatic review couldn't look at these pages, so a person will." };
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return undefined;
  const out = JSON.parse(block.text) as Review;
  return out.verdict === "hold" || out.verdict === "ok" ? out : undefined;
}

/** Reports from different people about one app in the last week. Enough of them pauses the app until someone looks. */
export const AUTO_PAUSE_REPORTS = () => Number(process.env.AUTO_PAUSE_REPORTS ?? 3);
export async function distinctReports(pool: Pool, app: string) {
  const { rows: [{ n }] } = await pool.query("select count(distinct case when reporter is null or reporter like 'someone who%' then id::text else lower(reporter) end)::int n from reports where app = $1 and closed_at is null and reporter is distinct from 'Grove check' and created_at > now() - interval '7 days'", [app]);
  return n as number;
}
