// What Grove does for the apps it runs, so their makers have nothing to set up. Email is real, and
// so is background work (the kit keeps the jobs; Grove only wakes the app when one is due).
// The rest are pretend for now: they take the input the real service will, keep a record, and
// answer in the real shape with `mock: true` and a note saying what did not happen.
import type { Pool } from "pg";
import { shell } from "./site.ts";
import { deleteObject, putObject, storageOn } from "./storage.ts";

export const SERVICES_SCHEMA = `
create table if not exists service_calls (
  id bigserial primary key, app text not null, service text not null, action text not null,
  body jsonb not null default '{}', result jsonb not null default '{}', mock boolean not null default true,
  trial boolean not null default false, at timestamptz not null default now());
create index if not exists service_calls_app on service_calls (app, at desc);
alter table apps add column if not exists wake_at timestamptz;
alter table apps add column if not exists origin text;
create table if not exists app_offers (app text primary key, to_email text not null, from_email text not null, at timestamptz not null default now());
create table if not exists files (
  id uuid primary key, app text not null, name text not null, type text not null, bytes integer not null,
  public boolean not null default false, trial boolean not null default false, created_at timestamptz not null default now());
create index if not exists files_app on files (app);
create table if not exists pretend_payments (
  id text primary key, app text not null, amount integer not null, currency text not null, description text not null,
  reference text, return_to text, paid_at timestamptz, created_at timestamptz not null default now());`;

/** What Grove offers apps, and whether each is real yet. Shown by the services tool and on the front page. */
export const SERVICES = [
  { name: "email", real: true, title: "Email", what: "Confirmations, reminders and notices, sent from the app.", use: "services.email.send({ to, subject, text })" },
  { name: "payments", real: false, title: "Payments", what: "Take a card payment on a Stripe page. Pretend until the business connects its own Stripe account (connect_payments); then the money goes straight to them, and Grove takes nothing.", use: "services.payments.checkout({ amount, description })" },
  { name: "tasks", real: true, title: "Background work", what: "Do something later, or every day, without anyone asking. Kept in the app's own database, so it works wherever the app runs.", use: "services.tasks.later(name, payload, { inMinutes }) with the work in jobs" },
  { name: "files", real: true, title: "Files and photos", what: "Keep uploads and get a web address for each: public, or a private link that runs out.", use: "services.files.put({ name, type, base64, public })" },
  { name: "texts", real: false, title: "Text messages", what: "Send a text to a phone.", use: "services.texts.send({ to, text })" },
  { name: "ai", real: false, title: "AI inside the app", what: "Sort, summarise or draft from what people typed.", use: "services.ai.ask({ prompt })" },
  { name: "pdf", real: false, title: "PDFs", what: "Invoices, certificates and anything to print.", use: "services.pdf.make({ title, html })" },
] as const;

const ACTIONS: Record<string, string[]> = {
  email: ["send"], payments: ["checkout", "status"], tasks: ["wake"], files: ["put", "remove", "link"], texts: ["send"], ai: ["ask"], pdf: ["make"],
};
export const known = (service: string, action: string) => Boolean(ACTIONS[service]?.includes(action));

export class ServiceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const str = (v: unknown, what: string, max: number) => {
  if (typeof v !== "string" || !v.trim()) throw new ServiceError(`${what} is required.`);
  if (v.length > max) throw new ServiceError(`${what} is too long (${max} characters at most).`);
  return v;
};
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const MAX_RECIPIENTS = 10;

/** Checks an email an app wants to send. Throws a ServiceError saying what is wrong. */
export function checkEmail(body: any) {
  const to = [...new Set([body?.to].flat().map((a) => (typeof a === "string" ? a.trim().toLowerCase() : "")))];
  if (!to.length || to.some((a) => a.length > 200 || !ADDRESS.test(a))) throw new ServiceError("to must be an email address, or a list of them.");
  if (to.length > MAX_RECIPIENTS) throw new ServiceError(`One email can go to ${MAX_RECIPIENTS} addresses at most. This isn't for sending in bulk.`);
  const subject = str(body.subject, "subject", 200).replace(/[\r\n]+/g, " ");
  const text = str(body.text, "text", 20_000);
  const replyTo = body.replyTo === undefined ? undefined : str(body.replyTo, "replyTo", 200).trim();
  if (replyTo && !ADDRESS.test(replyTo)) throw new ServiceError("replyTo must be an email address.");
  return { to, subject, text, replyTo };
}

/** On a trial copy only the app's own people are emailed, so trying a change never writes to real customers. */
export function whoGets(to: string[], people: string[], trial: boolean) {
  if (!trial) return { sent: to, held: [] as string[] };
  const own = new Set(people.map((p) => p.toLowerCase()));
  return { sent: to.filter((a) => own.has(a)), held: to.filter((a) => !own.has(a)) };
}

/** The sender's name people see. Never the bare app title, so an app can't pass itself off as someone else. */
export const fromName = (title: string) => `${String(title ?? "").replace(/[^\p{L}\p{N} .&'-]/gu, "").trim().slice(0, 60) || "An app"} via Grove`;

/** The line Grove adds under every email an app sends. */
export const footer = (a: { title: string; slug: string; url?: string }, site: string) =>
  `\n\n--\nSent by ${a.title}${a.url ? ` (${a.url})` : ""}, an app made with Grove.\nNot expecting this, or something wrong? ${site}/report?app=${a.slug}`;

const NOTES: Record<string, string> = {
  payments: "Pretend: no money moved. Payments through Grove aren't switched on yet. The page at url lets the person pretend to pay so the rest can be tried.",
  files: "Pretend: the file was not kept and the address won't open. File storage isn't switched on yet.",
  texts: "Pretend: no text message was sent. Text messages aren't switched on yet.",
  ai: "Pretend: no AI model was asked. This answer is a stand-in.",
  pdf: "Pretend: no PDF was made and the address won't open. PDFs aren't switched on yet.",
};

/** The answer a pretend service gives. Same shape as the real one will have, plus mock and a note. */
export function pretend(service: string, action: string, body: any, id: string, site: string, now = new Date()) {
  const base = { mock: true as const, note: NOTES[service] };
  const need = (v: unknown, what: string, max = 200) => str(v, what, max);
  switch (`${service}.${action}`) {
    case "files.put": {
      const name = need(body.name, "name").replace(/[^\w.-]+/g, "-");
      need(body.type, "type", 100);
      const bytes = Math.floor((need(body.base64, "base64", 8_000_000).length * 3) / 4);
      return { id, url: `${site}/pretend/file/${id}/${name}`, bytes, ...base };
    }
    case "files.link":
      return { id: need(body.id, "id"), url: `${site}/pretend/file/${body.id}`, ...base };
    case "files.remove":
      return { id: need(body.id, "id"), removed: true as const, ...base };
    case "texts.send": {
      const to = need(body.to, "to", 20).replace(/[\s()-]/g, "");
      if (!/^\+?\d{7,15}$/.test(to)) throw new ServiceError("to must be a phone number, like +447700900123.");
      need(body.text, "text", 600);
      return { id, to, ...base };
    }
    case "ai.ask":
      return { text: `(A pretend answer to: ${need(body.prompt, "prompt", 20_000).slice(0, 120)})`, ...base };
    case "pdf.make":
      need(body.html, "html", 500_000);
      return { id, url: `${site}/pretend/pdf/${id}/${need(body.title, "title").replace(/[^\w.-]+/g, "-")}.pdf`, ...base };
  }
  throw new ServiceError("Grove has no such service.", 404);
}

const money = (amount: number, currency: string) => {
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount / 100); } catch { return `${(amount / 100).toFixed(2)} ${currency}`; }
};

/** Starts a pretend payment and gives the page where someone can pretend to pay it. */
export async function pretendCheckout(pool: Pool, app: string, body: any, id: string, site: string) {
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100_000_00) throw new ServiceError("amount must be a whole number in the smallest unit (pence, cents), such as 1250 for 12.50.");
  const currency = body.currency === undefined ? "GBP" : String(body.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ServiceError("currency must be three letters, like GBP.");
  const description = str(body.description, "description", 200);
  const reference = body.reference === undefined ? null : str(body.reference, "reference", 200);
  const returnTo = body.returnTo === undefined ? null : str(body.returnTo, "returnTo", 500);
  if (returnTo && !/^https:\/\//.test(returnTo)) throw new ServiceError("returnTo must be an https address.");
  await pool.query("insert into pretend_payments (id, app, amount, currency, description, reference, return_to) values ($1, $2, $3, $4, $5, $6, $7)", [id, app, amount, currency, description, reference, returnTo]);
  return { id, url: `${site}/pretend/pay/${id}`, status: "unpaid" as const, mock: true as const, note: NOTES.payments };
}

export async function pretendStatus(pool: Pool, app: string, body: any) {
  const { rows: [p] } = await pool.query("select id, amount, currency, reference, paid_at from pretend_payments where id = $1 and app = $2", [str(body.id, "id", 200), app]);
  if (!p) throw new ServiceError("No payment with that id.", 404);
  return { id: p.id, status: p.paid_at ? ("paid" as const) : ("unpaid" as const), amount: p.amount, currency: p.currency, ...(p.reference && { reference: p.reference }), mock: true as const, note: NOTES.payments };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The page a pretend payment sends people to. It says loudly that it isn't real and never asks for card details. */
export const pretendPayPage = (p: { id: string; app_title: string; amount: number; currency: string; description: string; paid_at?: Date | null; return_to?: string | null }) =>
  shell(
    "Grove: pretend payment",
    `<h1>This is a pretend payment</h1>
<p><strong>No money will move.</strong> ${esc(p.app_title)} is trying out payments, which Grove hasn't switched on yet. Don't enter card details anywhere on the way here: this page never asks for them.</p>
<p>${esc(p.description)}: <strong>${esc(money(p.amount, p.currency))}</strong></p>
${
  p.paid_at
    ? `<p>Marked as paid (pretend).</p>${p.return_to ? `<p><a href="${esc(p.return_to)}">Go back to ${esc(p.app_title)}</a></p>` : ""}`
    : `<form method="post" action="/pretend/pay/${esc(p.id)}"><button class="btn">Pretend it was paid</button></form>`
}`,
  );

/** Sends one plain-text email through Postmark. False if it could not be sent. */
export async function sendMail(from: string, to: string, subject: string, text: string, replyTo?: string) {
  if (!process.env.POSTMARK_TOKEN) return false;
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": process.env.POSTMARK_TOKEN },
    body: JSON.stringify({ From: from, To: to, ...(replyTo && { ReplyTo: replyTo }), Subject: subject, TextBody: text, MessageStream: "outbound" }),
  }).catch((e: Error) => e);
  if (res instanceof Error || !res.ok) {
    console.error("app email failed:", res instanceof Error ? res.message : `${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}

/** How many emails an app may send in a day through the email service. */
export const appEmailsPerDay = (paid: boolean) => Number(process.env.APP_EMAILS_PER_DAY ?? 50) * (paid ? 10 : 1);

/** When an app next has a job due. Grove's timer wakes it then. Never pushes an earlier wake later. */
export async function wakeAt(pool: Pool, app: string, body: any) {
  const at = new Date(String(body?.at));
  if (Number.isNaN(at.getTime())) throw new ServiceError("at must be a time.");
  await pool.query("update apps set wake_at = least(coalesce(wake_at, 'infinity'), $2) where slug = $1", [app, at]);
  return { ok: true };
}

/** How many apps one tick of the timer wakes, and how long each gets to answer. */
export const WAKE_BATCH = 20, WAKE_TIMEOUT_MS = 40_000;

/**
 * Wakes the apps with a job due: calls each one's /maple/tick, and notes when it next wants waking.
 * An app that doesn't answer is tried again in five minutes.
 */
export async function wakeDue(pool: Pool, secretFor: (slug: string) => string, call: typeof fetch = fetch) {
  const { rows } = await pool.query(
    "update apps set wake_at = now() + interval '5 minutes' where slug in (select slug from apps where wake_at <= now() and paused_at is null and url is not null and status <> 'creating' order by wake_at limit $1 for update skip locked) returning slug, url",
    [WAKE_BATCH],
  );
  const results = await Promise.all(
    rows.map(async (a) => {
      try {
        const res = await call(`${a.url}/maple/tick`, { method: "POST", headers: { authorization: `Bearer ${secretFor(a.slug)}` }, signal: AbortSignal.timeout(WAKE_TIMEOUT_MS) });
        // An app made before background work existed has no such address: stop waking it.
        if (res.status === 404) return (await pool.query("update apps set wake_at = null where slug = $1", [a.slug]), { app: a.slug, ok: false });
        if (!res.ok) return { app: a.slug, ok: false };
        const out: any = await res.json();
        await pool.query("update apps set wake_at = $2 where slug = $1", [a.slug, out.next ?? null]);
        return { app: a.slug, ok: true, ran: out.ran, failed: out.failed };
      } catch {
        return { app: a.slug, ok: false };
      }
    }),
  );
  return results;
}

/** What kinds of file apps may keep. Nothing a browser would run: no web pages, scripts or SVG. */
export const FILE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
export const MAX_FILE_BYTES = 4_000_000;
/** How much one app may keep in all. */
export const appFileBytes = (paid: boolean) => (paid ? 2_000_000_000 : 100_000_000);
export const filesOn = storageOn;
export const fileKey = (app: string, id: string) => `${app}/${id}`;
export const fileName = (name: string) => name.replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 120) || "file";

/** Checks a file an app wants kept. Throws a ServiceError saying what is wrong. */
export function checkFile(body: any) {
  const name = fileName(str(body?.name, "name", 200));
  const type = str(body.type, "type", 100).toLowerCase().split(";")[0].trim();
  if (!FILE_TYPES.has(type)) throw new ServiceError("That kind of file can't be kept. Images (png, jpeg, gif, webp), PDFs, plain text, CSV, Word and Excel files can.");
  const base64 = str(body.base64, "base64", Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new ServiceError("base64 must be the file's contents in base64.");
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw new ServiceError("The file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new ServiceError(`The file is too big (${Math.floor(MAX_FILE_BYTES / 1_000_000)} MB at most).`);
  return { name, type, bytes, public: body.public === true };
}

/** A private file's link: good until `until`, and only for that file. */
export const fileLink = (site0: string, f: { id: string; name: string; public?: boolean }, sign: (what: string) => string, minutes = 60, now = Date.now()) => {
  // Apps' files can be served from a domain of their own (FILES_URL), so a bad file can never get Grove's own address blocked.
  const site = process.env.FILES_URL?.replace(/\/$/, "") || site0;
  if (f.public) return `${site}/files/${f.id}/${f.name}`;
  const until = Math.floor(now / 1000) + Math.round(Math.min(Math.max(minutes, 1), 60 * 24 * 7) * 60);
  return `${site}/files/${f.id}/${f.name}?until=${until}&sig=${sign(`file:${f.id}:${until}`).slice(0, 32)}`;
};
export const linkGood = (id: string, until: string | undefined, sig: string | undefined, sign: (what: string) => string, now = Date.now()) =>
  Boolean(until && sig && Number(until) * 1000 > now && sig === sign(`file:${id}:${until}`).slice(0, 32));

export async function keepFile(pool: Pool, app: string, body: any, id: string, o: { site: string; paid: boolean; trial: boolean; sign: (what: string) => string }) {
  const f = checkFile(body);
  const { rows: [{ used }] } = await pool.query("select coalesce(sum(bytes), 0)::bigint used from files where app = $1", [app]);
  if (Number(used) + f.bytes.length > appFileBytes(o.paid)) throw new ServiceError(`This app has no room left for files (${Math.round(appFileBytes(o.paid) / 1_000_000)} MB in all). Remove some first.`, 413);
  await putObject(fileKey(app, id), f.bytes, f.type);
  await pool.query("insert into files (id, app, name, type, bytes, public, trial) values ($1, $2, $3, $4, $5, $6, $7)", [id, app, f.name, f.type, f.bytes.length, f.public, o.trial]);
  return { id, url: fileLink(o.site, { id, name: f.name, public: f.public }, o.sign), bytes: f.bytes.length, public: f.public, ...(!f.public && { note: "This is a private link that works for an hour. services.files.link(id) gives a fresh one." }) };
}

export async function linkFile(pool: Pool, app: string, body: any, o: { site: string; sign: (what: string) => string }) {
  const { rows: [f] } = await pool.query("select id, name, public from files where id::text = $1 and app = $2", [str(body?.id, "id", 100), app]);
  if (!f) throw new ServiceError("No file with that id.", 404);
  return { id: f.id, url: fileLink(o.site, f, o.sign, Number(body.minutes) || 60) };
}

export async function removeFile(pool: Pool, app: string, body: any) {
  const { rows: [f] } = await pool.query("delete from files where id::text = $1 and app = $2 returning id", [str(body?.id, "id", 100), app]);
  if (f) await deleteObject(fileKey(app, f.id));
  return { id: String(body.id), removed: Boolean(f) };
}

/** Removes every file an app kept, when the app is deleted. */
export async function removeFilesOf(pool: Pool, app: string) {
  const { rows } = await pool.query("delete from files where app = $1 returning id", [app]);
  if (storageOn()) await Promise.allSettled(rows.map((f) => deleteObject(fileKey(app, f.id))));
  return rows.length;
}
