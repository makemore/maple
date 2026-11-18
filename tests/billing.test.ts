// Paying for Grove: who counts as paid, checking that a webhook call is Stripe's, and recording what it says.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { billingOn, checkout, onEvent, planFor, thePrice, verified } from "../grove/src/billing.ts";

const SECRET = "whsec_test";
const header = (body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

/** A stand-in for the database: answers with the given rows and remembers what it was asked. */
const fakePool = (rows: any[] = []) => {
  const asked: { sql: string; args: any[] }[] = [];
  return { asked, query: async (sql: string, args: any[] = []) => (asked.push({ sql, args }), { rows, rowCount: rows.length }) } as any;
};

const realFetch = globalThis.fetch;
let calls: { method: string; path: string; body: string }[] = [];
/** Stands in for Stripe: answers each path from the table (a function, or a value). */
function stripeAnswers(table: Record<string, any>) {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const path = String(url).replace("https://api.stripe.com/v1", "");
    calls.push({ method: init.method ?? "GET", path, body: String(init.body ?? "") });
    const hit = table[path];
    if (hit === undefined) return new Response(JSON.stringify({ error: { message: `No such thing: ${path}` } }), { status: 404 });
    return new Response(JSON.stringify(typeof hit === "function" ? hit(init) : hit));
  }) as any;
}

beforeEach(() => {
  calls = [];
  Object.assign(process.env, { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_ours", STRIPE_WEBHOOK_SECRET: SECRET });
  delete process.env.APPS_PER_PERSON;
  delete process.env.PAID_APPS_PER_PERSON;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("webhook: a call signed by Stripe is accepted", () => {
  const body = '{"type":"ping"}';
  assert.equal(verified(body, header(body)), true);
});

test("webhook: wrong secret, changed body, old call, or no signature is refused", () => {
  const body = '{"type":"ping"}';
  assert.equal(verified(body, header(body, "whsec_other")), false);
  assert.equal(verified(body + " ", header(body)), false);
  assert.equal(verified(body, header(body, SECRET, Math.floor(Date.now() / 1000) - 600)), false);
  assert.equal(verified(body, undefined), false);
  assert.equal(verified(body, "nonsense"), false);
  assert.equal(verified(body, "t=1,v1="), false);
  delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.equal(verified(body, header(body)), false, "with no secret set, nothing is trusted");
});

test("billing is only on with both a key and a price", () => {
  assert.equal(billingOn(), true);
  delete process.env.STRIPE_PRICE_ID;
  assert.equal(billingOn(), false);
});

test("plan: free by default, paid while the subscription is good", async () => {
  assert.deepEqual(await planFor(fakePool(), "a@b.c"), { plan: "free", apps: 5, customer: undefined, status: "none" });
  assert.equal((await planFor(fakePool([{ customer: "cus_1", status: "active" }]), "a@b.c")).apps, 10);
  assert.equal((await planFor(fakePool([{ customer: "cus_1", status: "trialing" }]), "a@b.c")).plan, "paid");
  for (const status of ["canceled", "past_due", "unpaid", "incomplete"]) assert.equal((await planFor(fakePool([{ customer: "cus_1", status }]), "a@b.c")).plan, "free", status);
  process.env.APPS_PER_PERSON = "2";
  assert.equal((await planFor(fakePool(), "a@b.c")).apps, 2);
  delete process.env.APPS_PER_PERSON;
});

test("more apps for the asking: none by default; when a ceiling is set, a step at a time and only when nearly full", async () => {
  const { askForMore } = await import("../grove/src/billing.ts");
  assert.equal((await askForMore(fakePool(), "a@b.c", "a shop for my sister", 5)).granted, false, "the free plan is 5, full stop");
  process.env.FREE_APPS_MAX = "100";
  process.env.APPS_PER_PERSON = "25";
  try {
    assert.match((await askForMore(fakePool(), "a@b.c", "a shop", 10)).note, /still room for 15 more/);
    const more = await askForMore(fakePool(), "a@b.c", "a shop", 24);
    assert.deepEqual([more.granted, more.apps], [true, 50]);
    assert.equal((await planFor(fakePool([{ allowed: 9999 }]), "a@b.c")).apps, 100, "never past the ceiling");
  } finally {
    delete process.env.FREE_APPS_MAX;
    delete process.env.APPS_PER_PERSON;
  }
});

test("the paid plan's prices: round numbers in five currencies, monthly and yearly, graduated so the first 10 sites share the base price", async () => {
  const { PLAN_AMOUNTS, thePrice, planPrices, priceText } = await import("../grove/src/billing.ts");
  for (const i of ["month", "year"] as const) {
    assert.deepEqual(Object.keys(PLAN_AMOUNTS[i].base), ["usd", "gbp", "eur", "cad", "aud"]);
    assert.deepEqual(Object.keys(PLAN_AMOUNTS[i].extra), Object.keys(PLAN_AMOUNTS[i].base));
    for (const a of [...Object.values(PLAN_AMOUNTS[i].base), ...Object.values(PLAN_AMOUNTS[i].extra)]) assert.equal(a % 50, 0, "round amounts");
  }
  for (const c of Object.keys(PLAN_AMOUNTS.year.base)) assert.equal(PLAN_AMOUNTS.year.base[c], PLAN_AMOUNTS.month.base[c] * 10, "a year is ten months");
  assert.deepEqual(planPrices().month.gbp, { base: "£10 a month", extra: "£1 a month" });
  assert.deepEqual(planPrices().year.cad, { base: "C$140 a year", extra: "C$15 a year" });
  assert.equal(priceText(), "$10 a month (or $100 a year) for up to 10 sites, then $1 a month ($10 a year) for each one after that");
  process.env.STRIPE_PRICE_ID = "price_old";
  const key = PLAN_AMOUNTS.year.lookup;
  stripeAnswers({
    [`/prices?lookup_keys[]=${key}&active=true`]: { data: [] },
    "/prices/price_old": { id: "price_old", product: "prod_grove" },
    "/prices": { id: "price_year" },
  });
  assert.equal(await thePrice("year"), "price_year");
  const sent = new URLSearchParams(calls.find((c) => c.method === "POST" && c.path === "/prices")!.body);
  assert.deepEqual(
    ["product", "currency", "billing_scheme", "tiers_mode", "recurring[interval]", "lookup_key", "tiers[0][up_to]", "tiers[0][flat_amount]", "tiers[0][unit_amount]", "tiers[1][up_to]", "tiers[1][unit_amount]", "currency_options[aud][tiers][0][flat_amount]", "currency_options[aud][tiers][1][unit_amount]"].map((k) => sent.get(k)),
    ["prod_grove", "usd", "tiered", "graduated", "year", key, "10", "10000", "0", "inf", "1000", "15000", "1500"],
  );
  calls = [];
  stripeAnswers({ [`/prices?lookup_keys[]=${key}&active=true`]: { data: [{ id: "price_year" }] } });
  assert.equal(await thePrice("year"), "price_year", "made once, then remembered");
});

test("checkout: the chosen interval's price, with as many sites as the person already has", async () => {
  const { PLAN_AMOUNTS } = await import("../grove/src/billing.ts");
  stripeAnswers({
    [`/prices?lookup_keys[]=${PLAN_AMOUNTS.month.lookup}&active=true`]: { data: [{ id: "price_month" }] },
    "/checkout/sessions": { url: "https://checkout.stripe.com/x" },
  });
  assert.equal(await checkout("a@b.c", "https://grove.test", undefined, "month", 14), "https://checkout.stripe.com/x");
  const sent = new URLSearchParams(calls.find((c) => c.path === "/checkout/sessions")!.body);
  assert.deepEqual([sent.get("line_items[0][price]"), sent.get("line_items[0][quantity]"), sent.get("mode")], ["price_month", "14", "subscription"]);
});

test("per-site plan: allows up to the ceiling and keeps the subscription's quantity at the number of apps", async () => {
  const { PLAN_AMOUNTS, matchSites } = await import("../grove/src/billing.ts");
  const plan = await planFor(fakePool([{ customer: "cus_1", status: "active", per_site: true }]), "a@b.c");
  assert.deepEqual([plan.apps, plan.included], [200, 10]);
  const pool = { query: async (sql: string) => ({ rows: sql.includes("from plans") ? [{ subscription: "sub_1", status: "active", per_site: true }] : [{ n: 12 }] }) } as any;
  stripeAnswers({ "/subscriptions/sub_1": { items: { data: [{ id: "si_1", quantity: 10, price: { lookup_key: PLAN_AMOUNTS.month.lookup } }] } }, "/subscription_items/si_1": {} });
  assert.equal(await matchSites(pool, "a@b.c"), 12);
  const sent = new URLSearchParams(calls.find((c) => c.path === "/subscription_items/si_1")!.body);
  assert.deepEqual([sent.get("quantity"), sent.get("proration_behavior")], ["12", "create_prorations"]);
  calls = [];
  stripeAnswers({ "/subscriptions/sub_1": { items: { data: [{ id: "si_1", quantity: 12, price: { lookup_key: PLAN_AMOUNTS.month.lookup } }] } } });
  await matchSites(pool, "a@b.c");
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "nothing to change");
  const flat = { query: async () => ({ rows: [{ subscription: "sub_1", status: "active", per_site: false }] }) } as any;
  assert.equal(await matchSites(flat, "a@b.c"), undefined, "the old flat plan is left alone");
});

test("webhook event: a new subscription to our plan is recorded against the person's email", async () => {
  stripeAnswers({ "/subscriptions/sub_1": { id: "sub_1", customer: "cus_1", status: "active", metadata: { email: "Ana@Example.com" }, items: { data: [{ price: { id: "price_ours" } }] } } });
  const pool = fakePool();
  await onEvent(pool, { type: "customer.subscription.created", data: { object: { id: "sub_1" } } });
  assert.equal(pool.asked.length, 1);
  assert.deepEqual(pool.asked[0].args, ["ana@example.com", "cus_1", "sub_1", "active", false]);
});

test("webhook event: the status is read fresh from Stripe, not trusted from the event", async () => {
  stripeAnswers({ "/subscriptions/sub_1": { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { email: "a@b.c" }, items: { data: [{ price: { id: "price_ours" } }] } } });
  const pool = fakePool();
  await onEvent(pool, { type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "active" } } });
  assert.equal(pool.asked[0].args[3], "canceled");
});

test("webhook event: a finished checkout is recorded, using its reference when the subscription has no email", async () => {
  stripeAnswers({ "/subscriptions/sub_2": { id: "sub_2", customer: "cus_2", status: "active", metadata: {}, items: { data: [{ price: { id: "price_ours" } }] } } });
  const pool = fakePool();
  await onEvent(pool, { type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_2", client_reference_id: "tom@example.com" } } });
  assert.deepEqual(pool.asked[0].args, ["tom@example.com", "cus_2", "sub_2", "active", false]);
});

test("webhook event: other products, other event types and one-off payments change nothing", async () => {
  stripeAnswers({ "/subscriptions/sub_3": { id: "sub_3", customer: "cus_3", status: "active", metadata: { email: "a@b.c" }, items: { data: [{ price: { id: "price_something_else" } }] } } });
  const pool = fakePool();
  await onEvent(pool, { type: "customer.subscription.created", data: { object: { id: "sub_3" } } });
  await onEvent(pool, { type: "invoice.paid", data: { object: { id: "in_1" } } });
  await onEvent(pool, { type: "checkout.session.completed", data: { object: { mode: "payment" } } });
  await onEvent(pool, {});
  assert.equal(pool.asked.length, 0);
});

test("checkout: asks Stripe for a subscription page for this person and returns its address", async () => {
  stripeAnswers({ "/checkout/sessions": { url: "https://checkout.stripe.com/c/pay/cs_test_1" } });
  assert.equal(await checkout("a@b.c", "https://grove.example"), "https://checkout.stripe.com/c/pay/cs_test_1");
  const sent = new URLSearchParams(calls[0].body);
  assert.equal(sent.get("mode"), "subscription");
  assert.equal(sent.get("line_items[0][price]"), await thePrice(), "the plan's own price");
  assert.equal(sent.get("customer_email"), "a@b.c");
  assert.equal(sent.get("subscription_data[metadata][email]"), "a@b.c");
  assert.equal(sent.get("success_url"), "https://grove.example/account?paid=1");
});

test("checkout: a returning customer is reused, and one Stripe no longer has is not", async () => {
  stripeAnswers({ "/customers/cus_ok": { id: "cus_ok" }, "/customers/cus_deleted": { id: "cus_deleted", deleted: true }, "/checkout/sessions": { url: "https://checkout.stripe.com/x" } });
  await checkout("a@b.c", "https://grove.example", "cus_ok");
  assert.equal(new URLSearchParams(calls.at(-1)!.body).get("customer"), "cus_ok");
  for (const gone of ["cus_deleted", "cus_from_another_account"]) {
    await checkout("a@b.c", "https://grove.example", gone);
    const sent = new URLSearchParams(calls.at(-1)!.body);
    assert.equal(sent.get("customer"), null, gone);
    assert.equal(sent.get("customer_email"), "a@b.c", gone);
  }
});

test("a Stripe error is passed on in words", async () => {
  stripeAnswers({});
  await assert.rejects(checkout("a@b.c", "https://grove.example"), /Stripe: No such thing/);
});
