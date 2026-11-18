// Paying for Grove: who counts as paid, checking that a webhook call is Stripe's, and recording what it says.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { billingOn, checkout, onEvent, planFor, verified } from "../grove/src/billing.ts";

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
  assert.deepEqual(await planFor(fakePool(), "a@b.c"), { plan: "free", apps: 25, customer: undefined, status: "none" });
  assert.equal((await planFor(fakePool([{ customer: "cus_1", status: "active" }]), "a@b.c")).apps, 250);
  assert.equal((await planFor(fakePool([{ customer: "cus_1", status: "trialing" }]), "a@b.c")).plan, "paid");
  for (const status of ["canceled", "past_due", "unpaid", "incomplete"]) assert.equal((await planFor(fakePool([{ customer: "cus_1", status }]), "a@b.c")).plan, "free", status);
  process.env.APPS_PER_PERSON = "2";
  assert.equal((await planFor(fakePool(), "a@b.c")).apps, 2);
  delete process.env.APPS_PER_PERSON;
});

test("more apps for the asking: a step at a time on the free plan, up to its ceiling, and only when nearly full", async () => {
  const { askForMore } = await import("../grove/src/billing.ts");
  assert.match((await askForMore(fakePool(), "a@b.c", "a shop for my sister", 10)).note, /still room for 15 more/);
  const more = await askForMore(fakePool(), "a@b.c", "a shop for my sister", 24);
  assert.deepEqual([more.granted, more.apps], [true, 50]);
  const most = await askForMore(fakePool([{ allowed: 100 }]), "a@b.c", "more", 99);
  assert.equal(most.granted, false);
  assert.match(most.note, /100 is the most the free plan goes to/);
  assert.equal((await planFor(fakePool([{ allowed: 75 }]), "a@b.c")).apps, 75);
  assert.equal((await planFor(fakePool([{ allowed: 9999 }]), "a@b.c")).apps, 100, "never past the ceiling");
  assert.equal((await askForMore(fakePool([{ customer: "c", status: "active" }]), "a@b.c", "more", 249)).granted, false);
});

test("webhook event: a new subscription to our plan is recorded against the person's email", async () => {
  stripeAnswers({ "/subscriptions/sub_1": { id: "sub_1", customer: "cus_1", status: "active", metadata: { email: "Ana@Example.com" }, items: { data: [{ price: { id: "price_ours" } }] } } });
  const pool = fakePool();
  await onEvent(pool, { type: "customer.subscription.created", data: { object: { id: "sub_1" } } });
  assert.equal(pool.asked.length, 1);
  assert.deepEqual(pool.asked[0].args, ["ana@example.com", "cus_1", "sub_1", "active"]);
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
  assert.deepEqual(pool.asked[0].args, ["tom@example.com", "cus_2", "sub_2", "active"]);
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
  assert.equal(sent.get("line_items[0][price]"), "price_ours");
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
