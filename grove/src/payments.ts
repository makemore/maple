// Real card payments for apps, through Stripe Connect. Each app's business connects a Stripe account of
// its own (Accounts v2: the full Stripe Dashboard, Stripe's own pricing, Stripe covering negative balances).
// A payment is a direct charge on that account: the money goes straight to the business, Stripe takes its
// usual fees from them, and Grove takes nothing. Apps without a connected account, and trial copies,
// keep the pretend payments, so nothing changes until a maker connects Stripe.
import Stripe from "stripe";
import type { Pool } from "pg";

export const PAYMENTS_SCHEMA = `
create table if not exists app_payments (
  app text primary key, account text not null, ready boolean not null default false, status text, by_email text,
  checked_at timestamptz, created_at timestamptz not null default now());
create table if not exists real_payments (
  id text primary key, app text not null, account text not null, amount integer not null, currency text not null,
  description text not null, reference text, status text not null default 'unpaid', paid_at timestamptz,
  created_at timestamptz not null default now());
create index if not exists real_payments_app on real_payments (app, created_at);`;

/** Real payments need Grove's Stripe key, and Connect switched on in Grove's Stripe account. */
export const paymentsOn = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CONNECT !== "off");

let client: Stripe | undefined;
export const stripe = () => (client ??= new Stripe(process.env.STRIPE_SECRET_KEY!));
/** For tests: a stand-in for Stripe. */
export const useStripe = (c: unknown) => void (client = c as Stripe);

export class PaymentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The app's connected account, if it has one. */
export async function accountFor(pool: Pool, app: string) {
  const { rows: [r] } = await pool.query("select * from app_payments where app = $1", [app]);
  return r as { app: string; account: string; ready: boolean; status: string | null; checked_at: Date | null } | undefined;
}

/** Whether Stripe says the account can take card payments yet, and what it still needs if not. */
export async function refresh(pool: Pool, app: string, account: string) {
  const acct = await stripe().v2.core.accounts.retrieve(account, { include: ["configuration.merchant", "requirements"] });
  const status = acct.configuration?.merchant?.capabilities?.card_payments?.status ?? "unknown";
  const ready = status === "active";
  const due = (acct.requirements?.entries ?? []).filter((e) => e.minimum_deadline?.status === "currently_due" || e.minimum_deadline?.status === "past_due").length;
  await pool.query("update app_payments set ready = $2, status = $3, checked_at = now() where app = $1", [app, ready, status]);
  return { ready, status, stillNeeded: due };
}

/** Creates the app's connected account (once) and gives a Stripe page for the business to finish setting it up. */
export async function connect(pool: Pool, a: { slug: string; title: string }, email: string, back: { refresh: string; done: string }) {
  let row = await accountFor(pool, a.slug);
  if (!row) {
    const acct = await stripe().v2.core.accounts.create({
      contact_email: email,
      display_name: a.title.slice(0, 100),
      dashboard: "full",
      defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      include: ["configuration.merchant"],
      metadata: { grove_app: a.slug },
    });
    await pool.query("insert into app_payments (app, account, by_email) values ($1, $2, $3) on conflict (app) do nothing", [a.slug, acct.id, email]);
    row = (await accountFor(pool, a.slug))!;
  }
  const link = await stripe().v2.core.accountLinks.create({
    account: row.account,
    use_case: { type: "account_onboarding", account_onboarding: { refresh_url: back.refresh, return_url: back.done } },
  });
  return { account: row.account, url: link.url, expires: link.expires_at };
}

const str = (v: unknown, what: string, max: number) => {
  if (typeof v !== "string" || !v.trim()) throw new PaymentError(`${what} is needed.`);
  if (v.length > max) throw new PaymentError(`${what} is too long (${max} characters at most).`);
  return v.trim();
};

/** A Stripe Checkout page for one payment, on the app's own connected account. */
export async function checkout(pool: Pool, a: { slug: string; url: string }, account: string, body: any) {
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < 30 || amount > 100_000_00) throw new PaymentError("amount must be a whole number in the smallest unit (pence, cents), from 30 (0.30) up, such as 1250 for 12.50.");
  const currency = (body.currency === undefined ? "GBP" : String(body.currency)).toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new PaymentError("currency must be three letters, like GBP.");
  const description = str(body.description, "description", 200);
  const reference = body.reference === undefined ? undefined : str(body.reference, "reference", 200);
  const returnTo = body.returnTo === undefined ? a.url : str(body.returnTo, "returnTo", 500);
  if (!/^https:\/\//.test(returnTo)) throw new PaymentError("returnTo must be an https address.");
  const back = new URL(returnTo);
  const done = new URL(returnTo);
  done.searchParams.set("paid", "1");
  const session = await stripe().checkout.sessions.create(
    {
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name: description } } }],
      success_url: done.href,
      cancel_url: back.href,
      ...(reference && { client_reference_id: reference.slice(0, 200) }),
      metadata: { grove_app: a.slug, ...(reference && { reference }) },
      payment_intent_data: { metadata: { grove_app: a.slug, ...(reference && { reference }) } },
      integration_identifier: `grove-app-checkout-${a.slug.replace(/[^a-z0-9]/g, "").slice(0, 20)}${INTEGRATION_SUFFIX}`,
    },
    { stripeAccount: account },
  );
  await pool.query("insert into real_payments (id, app, account, amount, currency, description, reference) values ($1, $2, $3, $4, $5, $6, $7)", [session.id, a.slug, account, amount, currency.toUpperCase(), description, reference ?? null]);
  return { id: session.id, url: session.url!, status: "unpaid" as const };
}
/** The fixed random letters Stripe's integration label asks for, so these sessions can be told apart in the Dashboard. */
const INTEGRATION_SUFFIX = "-qzmkrvta";

/** Whether a payment has been paid. Grove's record (kept by the webhook) first, then Stripe if it still says unpaid. */
export async function status(pool: Pool, app: string, body: any) {
  const id = str(body?.id, "id", 300);
  const { rows: [p] } = await pool.query("select * from real_payments where id = $1 and app = $2", [id, app]);
  if (!p) throw new PaymentError("No payment with that id.", 404);
  if (p.status !== "paid") {
    const s = await stripe().checkout.sessions.retrieve(id, {}, { stripeAccount: p.account }).catch(() => undefined);
    if (s?.payment_status === "paid" || s?.payment_status === "no_payment_required") await markPaid(pool, id);
    if (s?.payment_status === "paid") p.status = "paid";
  }
  return { id, status: p.status === "paid" ? ("paid" as const) : ("unpaid" as const), amount: p.amount, currency: p.currency, ...(p.reference && { reference: p.reference }) };
}

export const markPaid = (pool: Pool, id: string) => pool.query("update real_payments set status = 'paid', paid_at = coalesce(paid_at, now()) where id = $1", [id]);

/**
 * Stripe's events from connected accounts (a Connect webhook to /stripe/connect): a Checkout Session paid
 * straight away (checkout.session.completed with payment_status paid) or later (async_payment_succeeded).
 */
export async function onConnectEvent(pool: Pool, raw: string, signature: string | undefined) {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) throw new PaymentError("Connect webhooks aren't set up.", 503);
  const event = stripe().webhooks.constructEvent(raw, signature ?? "", secret);
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.payment_status === "paid") await markPaid(pool, s.id);
  }
  return event.type;
}
