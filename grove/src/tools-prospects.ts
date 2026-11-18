// The tools and pages for outreach previews (see prospects.ts). Making previews, listing them and writing
// the email are for Grove's maker only; claiming one is for the business it was made for.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Hono } from "hono";
import type { Pool } from "pg";
import { waitUntil } from "@neon/functions";
import { z, type Ctx } from "../../kit/kit.ts";
import { crawl, hostOf, previewOf, sensitiveHost, survey, type Preview } from "./importer.ts";
import { FetchRefused } from "./fetcher.ts";
import { owns, ownerCode, ownerHelp } from "./owner.ts";
import { claimPage, emailFor, gonePage, newToken, noPage, optedOut, optOut, PER_WEEK, PLATFORM_COST, PREVIEW_DAYS, PREVIEW_HEADERS, PREVIEW_LIMITS, previewPage } from "./prospects.ts";

export type ProspectDeps = { pool: Pool; ctx: Ctx; site: string; sign: (what: string) => string; init: () => Promise<unknown>; makerOnly: () => void };

const base = (token: string) => `/preview/${token}`;
const links = (site: string, token: string) => ({ preview: `${site}${base(token)}/`, no: `${site}${base(token)}/no`, claim: `${site}${base(token)}/claim` });

/** Copies the site into its preview. Runs after the tool has answered. */
export async function buildPreview(pool: Pool, id: number) {
  const { rows: [p] } = await pool.query("select id, host, token from prospects where id = $1 and status = 'building'", [id]);
  if (!p) return;
  try {
    const site = await crawl(`https://${p.host}/`, PREVIEW_LIMITS, { owner: false });
    if (!site.pages.length) throw new Error("no pages could be read");
    const preview = previewOf(site, base(p.token));
    await pool.query("update prospects set status = 'ready', preview = $2, platform = coalesce($3, platform), error = null, updated_at = now() where id = $1 and status = 'building'", [id, JSON.stringify(preview), preview.platform ?? null]);
  } catch (e) {
    await pool.query("update prospects set status = 'failed', error = $2, updated_at = now() where id = $1", [id, (e as Error).message.slice(0, 500)]);
  }
}

const summary = (site: string, r: any) => ({
  id: Number(r.id),
  business: r.business,
  site: r.host,
  status: r.status,
  ...(r.platform && { platform: r.platform }),
  ...(r.contact && { contact: r.contact }),
  ...(r.pages != null && { pages: Number(r.pages) }),
  ...(["ready", "emailed"].includes(r.status) && { preview: links(site, r.token).preview }),
  ...(r.error && { problem: r.error }),
  ...(r.emailed_at && { emailed: new Date(r.emailed_at).toISOString().slice(0, 10) }),
  ...(r.claimed_by && { claimedBy: r.claimed_by }),
  ...(r.note && { note: r.note }),
  deletesOn: new Date(r.expires_at).toISOString().slice(0, 10),
});

export function prospectTools(server: McpServer, d: ProspectDeps) {
  const { pool, ctx, site, sign, init, makerOnly } = d;
  const { json, person } = ctx;
  const connect = `${site}/mcp`;

  server.registerTool(
    "prospect_site",
    {
      title: "Make a private preview of a business's site (Grove maker only)",
      description:
        "For outreach: copies the public pages of a business's website into a private preview at an unguessable link, so Grove's maker can show the business its own site running on Grove. Nothing goes live: the preview is marked as not the live site, kept out of search engines, runs no scripts, keeps none of the site's files (pictures load from the site itself) and deletes itself after 14 days. Respects robots.txt. Refuses businesses that opted out, and sites that look like banks, government or health. Pick businesses, not individuals: a limited company with a public contact address. Takes a minute; prospects shows when it's ready.",
      inputSchema: {
        url: z.string().url().describe("The business's website, e.g. https://example-bakery.co.uk"),
        business: z.string().min(2).max(120).describe("The business's name as it uses it"),
        contact: z.string().email().optional().describe("The public business address the email would go to"),
        note: z.string().max(500).optional().describe("Why this one: where it was found, what it does"),
      },
    },
    async ({ url, business, contact, note }) => {
      makerOnly();
      await init();
      const host = hostOf(url);
      const why = sensitiveHost(host);
      if (why) throw new Error(`Not ${host}: it looks like ${why}.`);
      if (await optedOut(pool, host, contact)) throw new Error(`${host} asked not to hear from Grove. Leave it.`);
      const { rows: [old] } = await pool.query("select * from prospects where host = $1", [host]);
      if (old) return json({ already: summary(site, old), note: "There's already a preview for this site." });
      const { rows: [{ n }] } = await pool.query("select count(*)::int n from prospects where created_at > now() - interval '7 days'");
      if (n >= PER_WEEK()) throw new Error(`That's ${n} previews this week, the most for one week (${PER_WEEK()}). Keep outreach small and personal: write to these first.`);
      let platform: string | undefined;
      try {
        const s = await survey(url);
        platform = s.platform === "not recognised" ? undefined : s.platform;
        if (platform === "Shopify") throw new Error(`${host} is a Shopify shop. Grove doesn't move shops yet, so a preview would mislead.`);
      } catch (e) {
        if (e instanceof FetchRefused) throw new Error(e.message);
        if (/Shopify/.test((e as Error).message)) throw e;
        throw new Error(`${url} couldn't be read: ${(e as Error).message}`);
      }
      const token = newToken();
      const { rows: [p] } = await pool.query(
        "insert into prospects (host, business, contact, token, platform, note, by_email, expires_at) values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8)) returning *",
        [host, business, contact?.toLowerCase() ?? null, token, platform ?? null, note ?? null, person.email, PREVIEW_DAYS],
      );
      waitUntil(buildPreview(pool, Number(p.id)).catch((e) => console.error("building a preview:", e)));
      return json({ ...summary(site, p), next: "Copying the pages now (about a minute). prospects shows when it's ready; then look at the preview yourself before prospect_email." });
    },
  );

  server.registerTool(
    "prospects",
    {
      title: "Outreach previews (Grove maker only)",
      annotations: { readOnlyHint: true },
      description: "The private previews made for outreach, newest first: which are ready, emailed, claimed, declined or expired, with their links.",
      inputSchema: { status: z.enum(["building", "ready", "emailed", "claimed", "declined", "expired", "failed"]).optional() },
    },
    async ({ status }) => {
      makerOnly();
      await init();
      const { rows } = await pool.query(
        "select id, business, host, status, platform, contact, token, error, emailed_at, claimed_by, note, expires_at, jsonb_array_length(preview->'pages') pages from prospects where $1::text is null or status = $1 order by id desc limit 100",
        [status ?? null],
      );
      const { rows: [{ week }] } = await pool.query("select count(*)::int week from prospects where created_at > now() - interval '7 days'");
      return json({ thisWeek: `${week} of ${PER_WEEK()}`, prospects: rows.map((r) => summary(site, r)) });
    },
  );

  server.registerTool(
    "prospect_email",
    {
      title: "The email for an outreach preview (Grove maker only)",
      annotations: { readOnlyHint: true },
      description:
        "Writes the email to send a business about its preview: who Grove is, what it would save, the private link, and a one-click link to delete the preview and not be contacted again. It doesn't send anything: Grove's maker sends it from their own address, then calls prospect_update with emailed. Read it through and make it personal first.",
      inputSchema: { id: z.number().int(), from: z.string().max(120).optional().describe("The sender's name, as signed") },
    },
    async ({ id, from }) => {
      makerOnly();
      await init();
      const { rows: [p] } = await pool.query("select * from prospects where id = $1", [id]);
      if (!p) throw new Error(`No prospect ${id}.`);
      if (p.status !== "ready" && p.status !== "emailed") throw new Error(`The preview is ${p.status}${p.error ? ` (${p.error})` : ""}, so there's nothing to send.`);
      if (await optedOut(pool, p.host, p.contact)) throw new Error(`${p.host} asked not to hear from Grove.`);
      const mail = emailFor(p, links(site, p.token), { name: from ?? person.email.split("@")[0], legal: process.env.GROVE_LEGAL_NAME, contact: process.env.GROVE_CONTACT_EMAIL });
      return json({ to: p.contact ?? "(no address recorded: find the business's public contact address)", ...mail, ...(!process.env.GROVE_LEGAL_NAME && { warning: "GROVE_LEGAL_NAME isn't set, so the email doesn't say who is sending it in law. Set it before sending outreach." }), ...(PLATFORM_COST[p.platform ?? ""] ? {} : { check: "No cost on record for this platform: the email talks in general terms." }) });
    },
  );

  server.registerTool(
    "prospect_update",
    {
      title: "Record what happened with an outreach preview (Grove maker only)",
      description: "emailed: the email went (the preview then lasts 14 days from now). declined: they said no (deletes the preview and records that they don't want to hear from Grove). delete: take the preview down without recording a no. A note can be added either way.",
      inputSchema: { id: z.number().int(), what: z.enum(["emailed", "declined", "delete", "note"]), note: z.string().max(500).optional(), contact: z.string().email().optional() },
    },
    async ({ id, what, note, contact }) => {
      makerOnly();
      await init();
      const { rows: [p] } = await pool.query("select * from prospects where id = $1", [id]);
      if (!p) throw new Error(`No prospect ${id}.`);
      if (contact) await pool.query("update prospects set contact = $2 where id = $1", [id, contact.toLowerCase()]);
      if (note) await pool.query("update prospects set note = $2, updated_at = now() where id = $1", [id, note]);
      if (what === "emailed") await pool.query("update prospects set status = 'emailed', emailed_at = now(), expires_at = now() + make_interval(days => $2), updated_at = now() where id = $1 and status in ('ready', 'emailed')", [id, PREVIEW_DAYS]);
      if (what === "declined") await optOut(pool, p.token);
      if (what === "delete") await pool.query("update prospects set status = 'expired', preview = null, updated_at = now() where id = $1", [id]);
      const { rows: [now] } = await pool.query("select * from prospects where id = $1", [id]);
      return json(summary(site, now));
    },
  );

  server.registerTool(
    "claim_preview",
    {
      title: "Claim a preview Grove made of your site",
      description:
        "For a business Grove wrote to with a private preview of its website: takes the code from the preview's 'Keep it' page. The person must show the site is theirs first (the answer gives the ways, the same as verify_site); then it says how to make the app and import the site properly with create_app and import_site. Explain each step to the person.",
      inputSchema: { code: z.string().min(10).max(60) },
    },
    async ({ code }) => {
      await init();
      const { rows: [p] } = await pool.query("select * from prospects where token = $1 and status in ('ready', 'emailed', 'claimed')", [code.trim()]);
      if (!p) throw new Error("That code doesn't match a preview, or the preview has been deleted. The site can still be moved: survey_site, then create_app and import_site.");
      const mine = await owns(pool, [person.email], p.host);
      if (!mine) return json({ site: p.host, yours: "not shown yet", ...ownerHelp(p.host, ownerCode(person.email, p.host, sign)), next: "Once one of these is in place, call verify_site, then claim_preview again." });
      await pool.query("update prospects set status = 'claimed', claimed_by = $2, updated_at = now() where id = $1", [p.id, person.email]);
      return json({ site: p.host, claimed: true, next: `Make the app with create_app (a name like ${p.host.split(".")[0].replace(/[^a-z0-9-]/g, "")}), then import_site with https://${p.host}/ to copy the site properly, pictures and all. Then show the person the preview and ship it when they're happy. add_domain puts it on their own domain.` });
    },
  );
}

/** The preview pages, and the pages to keep or delete one. */
export function prospectRoutes(app: Hono, deps: { pool: () => Pool; site: () => string }) {
  const live = async (token: string) => {
    const pool = deps.pool();
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return;
    const { rows: [p] } = await pool.query("select host, business, status, expires_at, preview from prospects where token = $1 and status in ('ready', 'emailed', 'claimed') and expires_at > now() and preview is not null", [token]);
    return p as { host: string; business: string; status: string; expires_at: Date; preview: Preview } | undefined;
  };
  const gone = (c: any) => c.html("<!doctype html><meta name=robots content=noindex><title>Not here</title><p>This preview has been deleted.</p>", 404, PREVIEW_HEADERS);

  app.get("/preview/:token/no", async (c) => {
    const p = await live(c.req.param("token"));
    if (!p) return gone(c);
    return c.html(noPage(p.host, base(c.req.param("token"))), 200, PREVIEW_HEADERS);
  });
  app.post("/preview/:token/no", async (c) => {
    await optOut(deps.pool(), c.req.param("token"));
    return c.html(gonePage(), 200, PREVIEW_HEADERS);
  });
  app.get("/preview/:token/claim", async (c) => {
    const p = await live(c.req.param("token"));
    if (!p) return gone(c);
    return c.html(claimPage(p.host, c.req.param("token"), deps.site(), `${deps.site()}/mcp`), 200, PREVIEW_HEADERS);
  });
  app.get("/preview/:token/styles/:id{[a-f0-9]+\\.css}", async (c) => {
    const p = await live(c.req.param("token"));
    const css = p?.preview.css[c.req.param("id").replace(/\.css$/, "")];
    if (css === undefined) return c.notFound();
    return c.body(css, 200, { "content-type": "text/css; charset=utf-8", ...PREVIEW_HEADERS });
  });
  app.get("/preview/:token/*", async (c) => {
    const token = c.req.param("token");
    const p = await live(token);
    if (!p) return gone(c);
    const path = c.req.path.slice(base(token).length) || "/";
    const html = previewPage(p, base(token), path);
    if (!html) return c.html("<!doctype html><meta name=robots content=noindex><title>Not in the preview</title><p>That page isn't in the preview.</p>", 404, PREVIEW_HEADERS);
    return c.html(html, 200, PREVIEW_HEADERS);
  });
  app.get("/preview/:token", (c) => c.redirect(`${base(c.req.param("token"))}/`, 301));
}
