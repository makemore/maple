// Plans: a generous free plan (more apps on request, without paying) and one paid plan with higher
// limits and no line about Grove on the apps. Payment is through Stripe.
// Stripe hosts the payment page and the page for changing or cancelling; Grove only keeps who is
// on the paid plan, as Stripe reports it. With no Stripe settings, everyone is on the free plan.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

export const BILLING_SCHEMA = `
create table if not exists plans (
  email text primary key, customer text, subscription text, status text not null default 'none',
  updated_at timestamptz not null default now());
create table if not exists allowances (
  email text primary key, apps integer not null, why text, updated_at timestamptz not null default now());`;

/** How many apps the free plan starts with, how many it can reach by asking, and how many the paid plan allows. */
export const FREE = () => Number(process.env.APPS_PER_PERSON ?? 25);
export const FREE_MAX = () => Math.max(FREE(), Number(process.env.FREE_APPS_MAX ?? 100));
export const PAID = () => Number(process.env.PAID_APPS_PER_PERSON ?? 250);
/** How many more apps one request adds. */
export const MORE_STEP = 25;
export const billingOn = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);

async function stripe<T = any>(method: string, path: string, params?: Record<string, string>): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(params && { "content-type": "application/x-www-form-urlencoded" }) },
    body: params && new URLSearchParams(params),
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`Stripe: ${body?.error?.message ?? res.status}`);
  return body;
}

/** The person's plan and how many apps it allows. Paid counts while Stripe says the subscription is good. */
export async function planFor(pool: Pool, email: string) {
  const { rows: [p] } = await pool.query("select p.customer, p.status, a.apps as allowed from (select $1::text as email) e left join plans p on p.email = e.email left join allowances a on a.email = e.email", [email]);
  const paid = p?.status === "active" || p?.status === "trialing";
  const free = Math.min(FREE_MAX(), Math.max(FREE(), Number(p?.allowed ?? 0)));
  return { plan: paid ? "paid" : "free", apps: paid ? Math.max(PAID(), free) : free, customer: p?.customer as string | undefined, status: (p?.status ?? "none") as string };
}

/** What the paid plan costs, as Stripe has it, e.g. "$15.00 a month". */
export async function priceText() {
  const p = await stripe("GET", `/prices/${process.env.STRIPE_PRICE_ID}`);
  const amount = new Intl.NumberFormat("en", { style: "currency", currency: p.currency }).format(p.unit_amount / 100);
  return `${amount} a ${p.recurring?.interval ?? "month"}`;
}

/** A Stripe payment page for the paid plan. Returns its address. */
export async function checkout(email: string, site: string, customer?: string): Promise<string> {
  // A customer Stripe no longer has (deleted there, or from a test account) must not block paying: start fresh.
  if (customer && !(await stripe("GET", `/customers/${customer}`).then((c) => !c.deleted, () => false))) customer = undefined;
  const s = await stripe("POST", "/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": process.env.STRIPE_PRICE_ID!,
    "line_items[0][quantity]": "1",
    ...(customer ? { customer } : { customer_email: email }),
    client_reference_id: email,
    "subscription_data[metadata][email]": email,
    allow_promotion_codes: "true",
    success_url: `${site}/account?paid=1`,
    cancel_url: `${site}/account`,
  });
  return s.url as string;
}

/** Stripe's page for changing the card, seeing invoices or cancelling. */
export async function portal(customer: string, site: string) {
  const s = await stripe("POST", "/billing_portal/sessions", { customer, return_url: `${site}/account` });
  return s.url as string;
}

/** Checks that a webhook call really came from Stripe (signature over the exact body, at most five minutes old). */
export function verified(body: string, header: string | undefined, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  if (!secret || !header) return false;
  const parts = header.split(",").map((p) => p.split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  return parts.some(([k, v]) => k === "v1" && v.length === want.length && timingSafeEqual(Buffer.from(v), want));
}

/** Records what Stripe says happened, and returns whose plan it was about. Safe to receive twice or out of order: the subscription is read fresh each time. */
export async function onEvent(pool: Pool, event: any): Promise<string | undefined> {
  const o = event?.data?.object;
  if (!o) return;
  let subscription: string | undefined;
  if (event.type === "checkout.session.completed" && o.mode === "subscription") subscription = o.subscription;
  else if (typeof event.type === "string" && event.type.startsWith("customer.subscription.")) subscription = o.id;
  if (!subscription) return;
  const sub = await stripe("GET", `/subscriptions/${subscription}`);
  if (sub.items?.data?.every((i: any) => i.price?.id !== process.env.STRIPE_PRICE_ID)) return; // some other product on the same Stripe account
  const email = String(sub.metadata?.email ?? o.client_reference_id ?? "").toLowerCase();
  if (!email) return;
  await pool.query(
    "insert into plans (email, customer, subscription, status) values ($1, $2, $3, $4) on conflict (email) do update set customer = $2, subscription = $3, status = $4, updated_at = now()",
    [email, sub.customer, sub.id, sub.status],
  );
  return email;
}

/**
 * More apps on the free plan, for the asking: a step at a time, up to the free ceiling. The person has to be
 * close to what they have, and say what the apps are for, so the room goes to people who are using it.
 */
export async function askForMore(pool: Pool, email: string, why: string, made: number) {
  const plan = await planFor(pool, email);
  if (plan.plan === "paid") return { apps: plan.apps, granted: false, note: `The paid plan already allows ${plan.apps} apps.` };
  if (plan.apps >= FREE_MAX()) return { apps: plan.apps, granted: false, note: `${FREE_MAX()} is the most the free plan goes to. The paid plan allows ${PAID()}.` };
  if (made < plan.apps - 5) return { apps: plan.apps, granted: false, note: `There is still room for ${plan.apps - made} more. Ask again when it is nearly used.` };
  const apps = Math.min(FREE_MAX(), plan.apps + MORE_STEP);
  await pool.query("insert into allowances (email, apps, why) values ($1, $2, $3) on conflict (email) do update set apps = $2, why = $3, updated_at = now()", [email, apps, why.slice(0, 1000)]);
  return { apps, granted: true, note: `Now up to ${apps} apps, still free.` };
}
