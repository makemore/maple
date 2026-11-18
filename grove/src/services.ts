// What Grove does for the apps it runs, so their makers have nothing to set up. Email is real.
// The rest are pretend for now: they take the input the real service will, keep a record, and
// answer in the real shape with `mock: true` and a note saying what did not happen.
import type { Pool } from "pg";
import { shell } from "./site.ts";

export const SERVICES_SCHEMA = `
create table if not exists service_calls (
  id bigserial primary key, app text not null, service text not null, action text not null,
  body jsonb not null default '{}', result jsonb not null default '{}', mock boolean not null default true,
  trial boolean not null default false, at timestamptz not null default now());
create index if not exists service_calls_app on service_calls (app, at desc);
create table if not exists pretend_payments (
  id text primary key, app text not null, amount integer not null, currency text not null, description text not null,
  reference text, return_to text, paid_at timestamptz, created_at timestamptz not null default now());`;

/** What Grove offers apps, and whether each is real yet. Shown by the services tool and on the front page. */
export const SERVICES = [
  { name: "email", real: true, title: "Email", what: "Confirmations, reminders and notices, sent from the app.", use: "services.email.send({ to, subject, text })" },
  { name: "payments", real: false, title: "Payments", what: "Take a card payment on a page Grove hosts. No payment account to open.", use: "services.payments.checkout({ amount, description })" },
  { name: "tasks", real: false, title: "Background work", what: "Do something later, or every day, without anyone asking.", use: "services.tasks.later(name, payload, { inMinutes })" },
  { name: "files", real: false, title: "Files and photos", what: "Keep uploads and get a web address for each.", use: "services.files.put({ name, type, base64 })" },
  { name: "texts", real: false, title: "Text messages", what: "Send a text to a phone.", use: "services.texts.send({ to, text })" },
  { name: "ai", real: false, title: "AI inside the app", what: "Sort, summarise or draft from what people typed.", use: "services.ai.ask({ prompt })" },
  { name: "pdf", real: false, title: "PDFs", what: "Invoices, certificates and anything to print.", use: "services.pdf.make({ title, html })" },
] as const;

const ACTIONS: Record<string, string[]> = {
  email: ["send"], payments: ["checkout", "status"], tasks: ["later", "every", "cancel"], files: ["put", "remove"], texts: ["send"], ai: ["ask"], pdf: ["make"],
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
export const fromName = (title: string) => `${title.replace(/[^\p{L}\p{N} .&'-]/gu, "").trim().slice(0, 60) || "An app"} via Grove`;

/** The line Grove adds under every email an app sends. */
export const footer = (a: { title: string; slug: string; url?: string }, site: string) =>
  `\n\n--\nSent by ${a.title}${a.url ? ` (${a.url})` : ""}, an app made with Grove.\nNot expecting this, or something wrong? ${site}/report?app=${a.slug}`;

const NOTES: Record<string, string> = {
  payments: "Pretend: no money moved. Payments through Grove aren't switched on yet. The page at url lets the person pretend to pay so the rest can be tried.",
  tasks: "Pretend: this was written down but will not run. Background work isn't switched on yet.",
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
    case "tasks.later": {
      const mins = Number(body.inMinutes);
      if (!(mins >= 0 && mins <= 60 * 24 * 366)) throw new ServiceError("inMinutes must be a number of minutes, up to a year.");
      return { id, name: need(body.name, "name", 60), runsAt: new Date(now.getTime() + mins * 60_000).toISOString(), ...base };
    }
    case "tasks.every": {
      const hours = Number(body.hours);
      if (body.dailyAt === undefined && !(hours >= 1 && hours <= 24 * 31)) throw new ServiceError("Give hours (1 or more) or dailyAt (like \"08:00\").");
      if (body.dailyAt !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.dailyAt))) throw new ServiceError("dailyAt must be a time like \"08:00\".");
      const next = body.dailyAt !== undefined ? new Date(`${new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)}T${body.dailyAt}:00Z`) : new Date(now.getTime() + hours * 3_600_000);
      return { id, name: need(body.name, "name", 60), next: next.toISOString(), ...base };
    }
    case "tasks.cancel":
      return { id: need(body.id, "id"), cancelled: true as const, ...base };
    case "files.put": {
      const name = need(body.name, "name").replace(/[^\w.-]+/g, "-");
      need(body.type, "type", 100);
      const bytes = Math.floor((need(body.base64, "base64", 8_000_000).length * 3) / 4);
      return { id, url: `${site}/pretend/file/${id}/${name}`, bytes, ...base };
    }
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
