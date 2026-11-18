// Real payments: a direct charge on the app's own connected account, recorded so status can answer,
// and the business's Stripe account created with Stripe's own pricing and loss cover.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkout, connect, status, useStripe, PaymentError } from "../grove/src/payments.ts";

const pool = () => {
  const rows: any[] = [], asked: any[] = [];
  return {
    asked, rows,
    query: async (sql: string, args: any[] = []) => {
      asked.push({ sql, args });
      if (/insert into real_payments/.test(sql)) rows.push({ id: args[0], app: args[1], account: args[2], amount: args[3], currency: args[4], reference: args[6], status: "unpaid" });
      if (/select \* from real_payments/.test(sql)) return { rows: rows.filter((r) => r.id === args[0] && r.app === args[1]) };
      if (/update real_payments set status = 'paid'/.test(sql)) rows.filter((r) => r.id === args[0]).forEach((r) => (r.status = "paid"));
      if (/select \* from app_payments/.test(sql)) return { rows: asked.some((a) => /insert into app_payments/.test(a.sql)) ? [{ app: args[0], account: "acct_1" }] : [] };
      return { rows: [] };
    },
  } as any;
};

test("checkout: a direct charge on the app's own account, no payment method list, recorded", async () => {
  let made: any, opts: any;
  useStripe({ checkout: { sessions: { create: async (p: any, o: any) => ((made = p), (opts = o), { id: "cs_test_1", url: "https://checkout.stripe.com/c/1" }) } } });
  const p = pool();
  const r = await checkout(p, { slug: "club", url: "https://club.grovehelper.com" }, "acct_1", { amount: 1250, description: "Spring fees", reference: "member-7", returnTo: "https://club.grovehelper.com/fees" });
  assert.deepEqual(r, { id: "cs_test_1", url: "https://checkout.stripe.com/c/1", status: "unpaid" });
  assert.equal(opts.stripeAccount, "acct_1");
  assert.equal(made.mode, "payment");
  assert.equal(made.line_items[0].price_data.unit_amount, 1250);
  assert.equal(made.line_items[0].price_data.currency, "gbp");
  assert.equal(made.payment_method_types, undefined);
  assert.equal(made.application_fee_amount, undefined, "Grove takes nothing");
  assert.equal(made.success_url, "https://club.grovehelper.com/fees?paid=1");
  assert.match(made.integration_identifier, /^grove-app-checkout-club-[a-z]{8}$/);
  assert.equal(p.rows.length, 1);
  await assert.rejects(checkout(p, { slug: "club", url: "https://x" }, "acct_1", { amount: 10, description: "x" }), PaymentError);
  await assert.rejects(checkout(p, { slug: "club", url: "https://x" }, "acct_1", { amount: 500, description: "x", returnTo: "http://insecure" }), /https/);
});

test("status: unpaid until Stripe says paid, then remembered", async () => {
  let paid = false;
  useStripe({ checkout: { sessions: { create: async () => ({ id: "cs_2", url: "u" }), retrieve: async () => ({ payment_status: paid ? "paid" : "unpaid" }) } } });
  const p = pool();
  await checkout(p, { slug: "shop", url: "https://shop.grovehelper.com" }, "acct_9", { amount: 900, description: "Mug" });
  assert.equal((await status(p, "shop", { id: "cs_2" })).status, "unpaid");
  paid = true;
  assert.equal((await status(p, "shop", { id: "cs_2" })).status, "paid");
  await assert.rejects(status(p, "other-app", { id: "cs_2" }), /No payment/);
});

test("connect: the business's own account, full Dashboard, Stripe's pricing and loss cover", async () => {
  let made: any, link: any;
  useStripe({ v2: { core: { accounts: { create: async (p: any) => ((made = p), { id: "acct_new" }) }, accountLinks: { create: async (p: any) => ((link = p), { url: "https://connect.stripe.com/setup/x", expires_at: "later" }) } } } });
  const p = pool();
  const r = await connect(p, { slug: "club", title: "River Rowing" }, "maker@x.example", { refresh: "https://grove/r", done: "https://grove/d" });
  assert.equal(r.url, "https://connect.stripe.com/setup/x");
  assert.equal(made.dashboard, "full");
  assert.deepEqual(made.defaults.responsibilities, { fees_collector: "stripe", losses_collector: "stripe" });
  assert.equal(made.configuration.merchant.capabilities.card_payments.requested, true);
  assert.equal(made.type, undefined, "Accounts v2, not the old account types");
  assert.equal(link.use_case.type, "account_onboarding");
  assert.equal(link.account, "acct_1");
});
