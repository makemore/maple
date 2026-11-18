// The tools for real payments: connecting an app's business to Stripe, and checking it's ready.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Pool } from "pg";
import { z, type Ctx } from "../../kit/kit.ts";
import { accountFor, connect, paymentsOn, refresh } from "./payments.ts";
import { planFor } from "./billing.ts";
import { trustOf } from "./safety.ts";

export type PaymentDeps = { pool: Pool; ctx: Ctx; site: string; sign: (what: string) => string; appFor: (ctx: Ctx, slug: string) => Promise<any>; mustAgree: () => Promise<void>; notPaused: (a: any) => void };

/** Grove's pages Stripe sends people back to: one to say it's done, one that makes a fresh link if the old one ran out. */
export const backLinks = (site: string, slug: string, sign: (what: string) => string) => {
  const until = Date.now() + 7 * 24 * 3600_000;
  const sig = sign(`payments:${slug}:${until}`);
  return { refresh: `${site}/payments/refresh/${slug}?until=${until}&sig=${sig}`, done: `${site}/payments/done/${slug}` };
};

export function paymentTools(server: McpServer, d: PaymentDeps) {
  const { pool, ctx, site, sign, appFor, mustAgree, notPaused } = d;
  const { json, person } = ctx;

  server.registerTool(
    "connect_payments",
    {
      title: "Take real card payments",
      description:
        "Connects an app to a Stripe account of its own, so services.payments takes real card payments instead of pretend ones. The money goes straight to that account: the business behind the app is the seller, Stripe charges them its usual card fees, and Grove takes nothing. Gives a Stripe page where the person running the business (the maker, or the client the app is for) sets up or signs in to Stripe and enters their business and bank details; it can take a few minutes, and Stripe may check details for a day or two. Until Stripe says it's ready, and always on trial copies, payments stay pretend. Explain this and confirm whose business it is first.",
      inputSchema: { app: z.string() },
    },
    async ({ app: slug }) => {
      const a = await appFor(ctx, slug);
      await mustAgree();
      notPaused(a);
      if (!paymentsOn()) throw new Error("Real payments aren't switched on in this Grove yet. Payments stay pretend meanwhile, so the app can be built and tried.");
      const paid = (await planFor(pool, a.makers[0])).plan === "paid";
      if (!ctx.isMaker && !(await trustOf(pool, person.email, { paid })).trusted) throw new Error("Real payments are for accounts that have been on Grove a few days (or on the paid plan). Until then, build with the pretend payments: the code stays the same.");
      const r = await connect(pool, a, person.email, backLinks(site, a.slug, sign));
      return json({ app: slug, setUpHere: r.url, linkWorksUntil: r.expires, next: "Give the person this Stripe link. Whoever runs the business behind the app should complete it, in their own name. When they're back, payments_status says whether Stripe is ready. Payments stay pretend until it is." });
    },
  );

  server.registerTool(
    "payments_status",
    {
      title: "Are real payments ready?",
      annotations: { readOnlyHint: true },
      description: "Whether an app takes real card payments yet: not connected, waiting for Stripe (with how many details Stripe still needs), or ready. Ask Stripe again with this after the person finishes setting up.",
      inputSchema: { app: z.string() },
    },
    async ({ app: slug }) => {
      const a = await appFor(ctx, slug);
      const row = await accountFor(pool, a.slug);
      if (!row) return json({ app: slug, payments: "pretend", note: "Not connected to Stripe. connect_payments starts it." });
      if (!paymentsOn()) return json({ app: slug, payments: "pretend", note: "Real payments are switched off in this Grove." });
      const r = await refresh(pool, a.slug, row.account);
      return json({
        app: slug,
        payments: r.ready ? "real" : "pretend until Stripe is ready",
        stripe: r.status,
        ...(r.stillNeeded && { stripeStillNeeds: `${r.stillNeeded} detail${r.stillNeeded === 1 ? "" : "s"}` }),
        note: r.ready ? "Card payments from the live app are real now: money goes to the business's Stripe account. Trial copies still use pretend payments." : "connect_payments gives a fresh Stripe link to finish setting up.",
      });
    },
  );
}
