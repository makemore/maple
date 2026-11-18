// A person's own domain for an app's website (www.riverrowing.club), through Cloudflare for SaaS: Grove
// asks Cloudflare to serve the name, the person points it at Grove with one DNS record, and Cloudflare
// issues the certificate. The front door then serves the app at that name as well as its own address.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Pool } from "pg";
import { z, type Ctx } from "../../kit/kit.ts";
import { sensitiveHost } from "./importer.ts";
import { trustOf } from "./safety.ts";
import { planFor } from "./billing.ts";

export const DOMAINS_SCHEMA = `
create table if not exists app_domains (
  domain text primary key, app text not null, cf_id text, status text not null default 'pending', ssl text, note text,
  by_email text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists app_domains_app on app_domains (app);`;

/** Whether Grove can set up domains: a Cloudflare token allowed to edit the apps zone's custom hostnames. */
export const domainsOn = () => Boolean(process.env.CF_API_TOKEN && process.env.CF_ZONE_ID && process.env.APPS_DOMAIN);
/** The name people point their domain at. A proxied record on the apps zone, set as its fallback origin. */
export const target = () => process.env.DOMAINS_TARGET ?? `domains.${process.env.APPS_DOMAIN}`;
export const MAX_DOMAINS = (paid: boolean) => (paid ? 5 : 1);

/** A domain someone may use: a real name, not Grove's own, not a bank's, a government's or a big brand's. */
export function domainProblem(raw: string) {
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return { domain: d, problem: "That isn't a domain name. Give it like www.example.com." };
  const own = [process.env.APPS_DOMAIN, "makewithgrove.com", "grovehelper.com"].filter(Boolean) as string[];
  if (own.some((o) => d === o || d.endsWith(`.${o}`))) return { domain: d, problem: "That's one of Grove's own addresses." };
  const why = sensitiveHost(d);
  if (why) return { domain: d, problem: `${d} looks like ${why}, so Grove won't serve it.` };
  if (d.split(".").length === 2) return { domain: d, problem: `Use a name with something in front, like www.${d}: most domain companies can't point a bare ${d} at another service. Set the bare name to forward to www at your domain company.` };
  return { domain: d };
}

async function cloudflare(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.CF_API_TOKEN}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok || out.success === false) throw new Error(`Cloudflare: ${out.errors?.map((e: any) => e.message).join("; ") || res.status}`);
  return out.result;
}

/** What Cloudflare says about a name, in words for the person. */
export function describe(h: any) {
  const ssl = h?.ssl?.status as string | undefined;
  const live = h?.status === "active" && ssl === "active";
  const waiting = h?.ownership_verification_http || h?.ssl?.validation_records?.length;
  return {
    status: live ? "live" : h?.status === "blocked" || h?.status === "moved" ? "stopped" : "waiting",
    ssl,
    note: live ? "It's live: the app's website answers at this name." : h?.verification_errors?.length ? `Cloudflare says: ${h.verification_errors.join("; ")}` : waiting ? "Waiting for the DNS record. Once it's in place, the certificate follows within a few minutes (sometimes up to a day)." : "Setting up.",
  };
}

export type DomainDeps = { pool: Pool; ctx: Ctx; appFor: (ctx: Ctx, slug: string) => Promise<any>; mustAgree: () => Promise<void>; notPaused: (a: any) => void };

export function domainTools(server: McpServer, d: DomainDeps) {
  const { pool, ctx, appFor, mustAgree, notPaused } = d;
  const { json, person } = ctx;

  server.registerTool(
    "add_domain",
    {
      title: "Use your own domain",
      description:
        "Serves an app's website at the person's own domain as well as its Grove address, e.g. www.riverrowing.club. Grove sets it up with Cloudflare; the person then adds one DNS record (a CNAME, given in the result) at their domain company, and the secure certificate follows by itself. Use a name with something in front (www.); the bare domain can forward to it at the domain company. The app's assistant connection keeps its Grove address. One domain per app on the free plan, five on the paid plan. Ask the person for the exact name first.",
      inputSchema: { app: z.string(), domain: z.string().min(4).max(253) },
    },
    async ({ app: slug, domain: typed }) => {
      const a = await appFor(ctx, slug);
      await mustAgree();
      notPaused(a);
      if (!domainsOn()) throw new Error("Own domains aren't switched on in this Grove yet. The app works at its Grove address meanwhile.");
      const { domain, problem } = domainProblem(typed);
      if (problem) throw new Error(problem);
      const paid = (await planFor(pool, a.makers[0])).plan === "paid";
      if (!ctx.isMaker && !(await trustOf(pool, person.email, { paid })).trusted) throw new Error("Own domains are for accounts that have been on Grove a few days (or on the paid plan). Until then the app works at its Grove address.");
      const { rows: [taken] } = await pool.query("select app from app_domains where domain = $1", [domain]);
      if (taken) throw new Error(taken.app === a.slug ? `${domain} is already set up for ${a.slug}: domain_status says how it's going.` : `${domain} is in use by another app.`);
      const { rows: [{ n }] } = await pool.query("select count(*)::int n from app_domains where app = $1", [a.slug]);
      if (n >= MAX_DOMAINS(paid)) throw new Error(`${a.slug} already has ${n} domain${n === 1 ? "" : "s"}, the most on ${paid ? "the paid plan" : "the free plan"}. remove_domain frees one.`);
      const h = await cloudflare("/custom_hostnames", { method: "POST", body: JSON.stringify({ hostname: domain, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } }, custom_metadata: { app: a.slug } }) });
      const s = describe(h);
      await pool.query("insert into app_domains (domain, app, cf_id, status, ssl, note, by_email) values ($1, $2, $3, $4, $5, $6, $7)", [domain, a.slug, h.id, s.status, s.ssl ?? null, s.note, person.email]);
      return json({
        domain, app: a.slug, status: s.status,
        dnsRecord: { type: "CNAME", name: domain.split(".")[0], fullName: domain, value: target(), note: "Turn off any 'proxy' or 'forwarding' for this record at the domain company; it should be a plain CNAME." },
        next: `Tell the person to add that CNAME record at their domain company (where they bought ${domain}). Once it's there, domain_status shows it going live, usually within a few minutes. Their old site keeps working until they change the record.`,
      });
    },
  );

  server.registerTool(
    "domain_status",
    {
      title: "How is the domain doing?",
      annotations: { readOnlyHint: true },
      description: "An app's own domains and whether each is live yet, waiting for its DNS record, or stopped, with the record to add.",
      inputSchema: { app: z.string() },
    },
    async ({ app: slug }) => {
      const a = await appFor(ctx, slug);
      const { rows } = await pool.query("select * from app_domains where app = $1 order by created_at", [a.slug]);
      const out = [];
      for (const r of rows) {
        let s = { status: r.status, ssl: r.ssl, note: r.note };
        if (domainsOn() && r.cf_id && r.status !== "live") {
          s = describe(await cloudflare(`/custom_hostnames/${r.cf_id}`).catch(() => undefined)) as typeof s;
          await pool.query("update app_domains set status = $2, ssl = $3, note = $4, updated_at = now() where domain = $1", [r.domain, s.status, s.ssl ?? null, s.note]);
        }
        out.push({ domain: r.domain, ...s, dnsRecord: { type: "CNAME", fullName: r.domain, value: target() } });
      }
      return json({ app: slug, domains: out, ...(!out.length && { note: "No domains yet. add_domain sets one up." }) });
    },
  );

  server.registerTool(
    "remove_domain",
    {
      title: "Stop using a domain",
      description: "Stops serving an app at one of its own domains. The app keeps its Grove address. The person can remove the DNS record afterwards. Confirm first.",
      inputSchema: { app: z.string(), domain: z.string() },
    },
    async ({ app: slug, domain }) => {
      const a = await appFor(ctx, slug);
      const { rows: [r] } = await pool.query("delete from app_domains where app = $1 and domain = $2 returning cf_id", [a.slug, domain.trim().toLowerCase()]);
      if (!r) throw new Error(`${domain} isn't one of ${a.slug}'s domains.`);
      if (r.cf_id && domainsOn()) await cloudflare(`/custom_hostnames/${r.cf_id}`, { method: "DELETE" }).catch((e) => console.error(`removing ${domain} at Cloudflare:`, e));
      return json({ removed: domain, app: a.slug });
    },
  );
}
