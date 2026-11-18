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
  email text primary key, apps integer not null, why text, updated_at timestamptz not null default now());
alter table plans add column if not exists per_site boolean not null default false;`;

/** How many apps the free plan allows, how many it can reach by asking (none more unless set), and how many the paid plan allows. */
export const FREE = () => Number(process.env.APPS_PER_PERSON ?? 5);
export const FREE_MAX = () => Math.max(FREE(), Number(process.env.FREE_APPS_MAX ?? 0));
export const PAID = () => Number(process.env.PAID_APPS_PER_PERSON ?? 10);

/**
 * What the paid plan costs, in round numbers in each currency a buyer is likely to have: a base price that
 * includes PAID() sites, then a little for each site after that. Monthly, or yearly for two months less.
 * The first currency is the default, charged to anyone whose own currency isn't listed; Stripe's payment
 * page picks the buyer's currency from where they are. A Stripe price can't be edited, so changing these
 * means new lookup keys.
 */
export type Interval = "month" | "year";
export const PLAN_AMOUNTS: Record<Interval, { lookup: string; base: Record<string, number>; extra: Record<string, number> }> = {
  month: { lookup: "grove-plus-month-10-then-1", base: { usd: 1000, gbp: 1000, eur: 1000, cad: 1400, aud: 1500 }, extra: { usd: 100, gbp: 100, eur: 100, cad: 150, aud: 150 } },
  year: { lookup: "grove-plus-year-10-then-1", base: { usd: 10000, gbp: 10000, eur: 10000, cad: 14000, aud: 15000 }, extra: { usd: 1000, gbp: 1000, eur: 1000, cad: 1500, aud: 1500 } },
};
/** The old flat price (10 apps, monthly). Subscriptions on it still count as paid, for 10 apps. */
export const OLD_LOOKUP_KEY = "grove-plus-monthly-10";
const PER_SITE = new Set(Object.values(PLAN_AMOUNTS).map((p) => p.lookup));
/** The most sites one paid account can have: a ceiling against mistakes and misuse, raised on request. */
export const PAID_MAX = () => Number(process.env.PAID_APPS_MAX ?? 200);
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

/**
 * The person's plan and how many apps it allows. Paid counts while Stripe says the subscription is good.
 * On the per-site price the paid plan grows with them (up to PAID_MAX), each site after PAID() adding a little.
 */
export async function planFor(pool: Pool, email: string) {
  const { rows: [p] } = await pool.query("select p.customer, p.status, p.per_site, a.apps as allowed from (select $1::text as email) e left join plans p on p.email = e.email left join allowances a on a.email = e.email", [email]);
  const paid = p?.status === "active" || p?.status === "trialing";
  const free = Math.min(FREE_MAX(), Math.max(FREE(), Number(p?.allowed ?? 0)));
  return { plan: paid ? "paid" : "free", apps: paid ? Math.max(p?.per_site ? PAID_MAX() : PAID(), free) : free, customer: p?.customer as string | undefined, status: (p?.status ?? "none") as string, ...(paid && p?.per_site && { included: PAID() }) };
}

const money = (currency: string, amount: number) =>
  new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100).replace(/^(CA|A|US)\$/, (m) => ({ CA$: "C$", A$: "A$", US$: "$" })[m] ?? m);

/** The paid plan's prices as people read them, in each currency: base and per extra site, monthly and yearly. */
export function planPrices() {
  const shown = (i: Interval) => Object.fromEntries(Object.entries(PLAN_AMOUNTS[i].base).map(([c, a]) => [c, { base: `${money(c, a)} a ${i}`, extra: `${money(c, PLAN_AMOUNTS[i].extra[c])} a ${i}` }]));
  return { included: PAID(), month: shown("month"), year: shown("year") };
}

/**
 * The paid plan's Stripe price for an interval, made on first use on the same product as STRIPE_PRICE_ID:
 * graduated, so the first PAID() sites cost the base price between them and each one after adds the extra.
 * Found again by its lookup key, so it is made once, whichever copy of Grove gets there first.
 */
const made: Partial<Record<Interval, Promise<string>>> = {};
export function thePrice(interval: Interval = "month") {
  const plan = PLAN_AMOUNTS[interval];
  made[interval] ??= (async () => {
    const found = await stripe("GET", `/prices?lookup_keys[]=${plan.lookup}&active=true`);
    if (found.data?.[0]) return found.data[0].id as string;
    const old = await stripe("GET", `/prices/${process.env.STRIPE_PRICE_ID}`);
    const [first, ...rest] = Object.keys(plan.base);
    const tiers = (prefix: string, c: string) => ({
      [`${prefix}[0][up_to]`]: String(PAID()),
      [`${prefix}[0][flat_amount]`]: String(plan.base[c]),
      [`${prefix}[0][unit_amount]`]: "0",
      [`${prefix}[1][up_to]`]: "inf",
      [`${prefix}[1][unit_amount]`]: String(plan.extra[c]),
    });
    const p = await stripe("POST", "/prices", {
      product: typeof old.product === "string" ? old.product : old.product.id,
      currency: first,
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      "recurring[interval]": interval,
      lookup_key: plan.lookup,
      nickname: `Grove Plus (${interval}ly)`,
      ...tiers("tiers", first),
      ...Object.assign({}, ...rest.map((c) => tiers(`currency_options[${c}][tiers]`, c))),
    });
    return p.id as string;
  })();
  made[interval]!.catch(() => delete made[interval]);
  return made[interval]!;
}

/** What one more site beyond the included ones adds, in the default currency. */
export function extraText() {
  const p = planPrices(), [c] = Object.keys(p.month);
  return `${p.month[c].extra} (or ${p.year[c].extra} on yearly billing)`;
}

/** What the paid plan costs in its default currency, in words. */
export function priceText() {
  const p = planPrices(), [c] = Object.keys(p.month);
  return `${p.month[c].base} (or ${p.year[c].base}) for up to ${p.included} sites, then ${p.month[c].extra} (${p.year[c].extra}) for each one after that`;
}

/** A Stripe payment page for the paid plan. Returns its address. */
export async function checkout(email: string, site: string, customer?: string, interval: Interval = "month", sites = 1): Promise<string> {
  // A customer Stripe no longer has (deleted there, or from a test account) must not block paying: start fresh.
  if (customer && !(await stripe("GET", `/customers/${customer}`).then((c) => !c.deleted, () => false))) customer = undefined;
  const s = await stripe("POST", "/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": await thePrice(interval),
    "line_items[0][quantity]": String(Math.max(1, sites)),
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
  // Some other product on the same Stripe account. Subscriptions from before the price changed still count.
  const ours = (sub.items?.data ?? []).filter((i: any) => i.price?.id === process.env.STRIPE_PRICE_ID || i.price?.lookup_key === OLD_LOOKUP_KEY || PER_SITE.has(i.price?.lookup_key));
  if (!ours.length) return;
  const perSite = ours.some((i: any) => PER_SITE.has(i.price?.lookup_key));
  const email = String(sub.metadata?.email ?? o.client_reference_id ?? "").toLowerCase();
  if (!email) return;
  await pool.query(
    "insert into plans (email, customer, subscription, status, per_site) values ($1, $2, $3, $4, $5) on conflict (email) do update set customer = $2, subscription = $3, status = $4, per_site = $5, updated_at = now()",
    [email, sub.customer, sub.id, sub.status, perSite],
  );
  return email;
}

/**
 * Keeps a per-site subscription's quantity at the number of apps the person makes, so each site after the
 * included ones is charged (Stripe prorates the change). Old flat subscriptions and free plans are left alone.
 * Returns the new quantity, or undefined when nothing applies.
 */
export async function matchSites(pool: Pool, email: string): Promise<number | undefined> {
  if (!billingOn()) return;
  const { rows: [p] } = await pool.query("select subscription, status, per_site from plans where email = $1", [email]);
  if (!p?.per_site || !p.subscription || !["active", "trialing", "past_due"].includes(p.status)) return;
  const { rows: [{ n }] } = await pool.query("select count(*)::int n from apps where $1 = any(makers)", [email]);
  const sub = await stripe("GET", `/subscriptions/${p.subscription}`);
  const item = (sub.items?.data ?? []).find((i: any) => PER_SITE.has(i.price?.lookup_key));
  const want = Math.max(1, n);
  if (item && item.quantity !== want) await stripe("POST", `/subscription_items/${item.id}`, { quantity: String(want), proration_behavior: "create_prorations" });
  return want;
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
