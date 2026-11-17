// Paying for Grove, through Stripe: a free plan with a few apps and one paid plan with more.
// Stripe hosts the payment page and the page for changing or cancelling; Grove only keeps who is
// on the paid plan, as Stripe reports it. With no Stripe settings, everyone is on the free plan.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

export const BILLING_SCHEMA = `
create table if not exists plans (
  email text primary key, customer text, subscription text, status text not null default 'none',
  updated_at timestamptz not null default now());`;

const FREE = () => Number(process.env.APPS_PER_PERSON ?? 5);
const PAID = () => Number(process.env.PAID_APPS_PER_PERSON ?? 25);
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
  const { rows: [p] } = await pool.query("select customer, status from plans where email = $1", [email]);
  const paid = p?.status === "active" || p?.status === "trialing";
  return { plan: paid ? "paid" : "free", apps: paid ? PAID() : FREE(), customer: p?.customer as string | undefined, status: (p?.status ?? "none") as string };
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

/** Records what Stripe says happened. Safe to receive twice or out of order: the subscription is read fresh each time. */
export async function onEvent(pool: Pool, event: any) {
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
}
