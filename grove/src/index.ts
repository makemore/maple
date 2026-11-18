// Grove: the MAPLE app that makes MAPLE apps. Ask it for an app and it creates the database, sign-in
// and address, keeps the app's code, and builds and deploys it itself; then it lets the app's makers
// change the code from the same chat, through previews, checks and one-step shipping.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import manifest from "../maple.json" with { type: "json" };
import { createMapleApp, z, type Ctx, type Manifest } from "../../kit/kit.ts";
import { BILLING_SCHEMA, billingOn, checkout, onEvent, planFor, portal, priceText, verified } from "./billing.ts";
import { BuildError, bundle, check, upload, zip, type Files } from "./build.ts";
import { Client } from "pg";
import { capCompute, connectionUri, createBranch, createProject, deleteBranch, deleteProject, registerDomain, setUpSignIn } from "./neon.ts";
import { waitUntil } from "@neon/functions";
import { parseTriggerDelivery } from "@neon/functions/triggers";
import { GUARD_SCHEMA, MAX_OPEN_CHANGES, appNamed, blockedWhy, concerns, mayNotify, pausedArchive, report, reportPage, underBuildLimit } from "./guard.ts";
import { HEAVY, METER_SCHEMA, carryOn, firstLimit, record, rounded, stopMessage, summary, today } from "./meter.ts";
import { LEGAL_SCHEMA, TERMS_VERSION, agree, agreed, privacyPage, termsOn, termsPage } from "./legal.ts";
import { sitePage, type PaidPlan } from "./site.ts";
import { CHANGE, MAX_FILE, RESERVED, SLUG, applyWrites, diff, merge, tooBig, withKit } from "./code.ts";
import { TEMPLATE } from "./template-files.ts";
import { UPKEEP_SCHEMA, due, prune } from "./upkeep.ts";
import { getObject } from "./storage.ts";
import { SERVICES, SERVICES_SCHEMA, ServiceError, appEmailsPerDay, checkEmail, footer, fromName, known, pretend, pretendCheckout, pretendPayPage, pretendStatus, removeFile, removeFilesOf, sendMail, wakeAt, wakeDue, whoGets, filesOn, keepFile, linkFile, linkGood, fileKey } from "./services.ts";

// An app's code lives here as whole versions: every saved change and every shipped state is one row.
const schema = `
create table if not exists apps (
  slug text primary key, title text not null, description text not null, makers text[] not null,
  users text[] not null default '{}', neon_project_id text, url text, secret_hash text not null,
  status text not null default 'creating', error text, created_at timestamptz not null default now());
alter table apps add column if not exists branch_id text;
alter table apps add column if not exists live bigint;
create table if not exists versions (
  id bigserial primary key, app text not null, files jsonb not null, message text not null, author text not null,
  created_at timestamptz not null default now(), shipped_at timestamptz);
create index if not exists versions_app on versions (app, id);
create table if not exists changes (
  app text not null, name text not null, version bigint not null, base bigint not null, branch_id text, url text,
  updated_at timestamptz not null default now(), primary key (app, name));
create table if not exists waitlist (
  email text primary key, idea text, created_at timestamptz not null default now());${BILLING_SCHEMA}${LEGAL_SCHEMA}${GUARD_SCHEMA}${METER_SCHEMA}${SERVICES_SCHEMA}${UPKEEP_SCHEMA}`;

const DOMAIN = process.env.APPS_DOMAIN;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const sign = (what: string) => {
  if (!process.env.GROVE_SECRET) throw new Error("Grove is missing its GROVE_SECRET setting.");
  return createHmac("sha256", process.env.GROVE_SECRET).update(what).digest("hex");
};
/** What an app sends to prove itself to Grove. Worked out from the app's name, so it is never stored. */
const appSecret = (slug: string) => sign(`app:${slug}`);

const guide = `Grove makes small apps that people use through their AI assistant: each app has its own database,
email-code sign-in, its own address, a Claude connector and a way for its users to ask its maker for changes.
Use create_app when someone wants a new app, then build the features they described with the code tools:
read AGENTS.md and src/app.ts of the app first, make the change with write_files (it checks the code and
puts up a preview; if it reports problems, fix them and write again), show the preview, and ship_change only
when the person says so. After create_app, tell the person how to add the app to Claude
(Settings, Connectors, Add custom connector, paste the connection address).
If a tool says the person must agree to the terms first, give them both links, ask plainly whether they agree,
and call accept_terms only after they say yes themselves. Never agree for them.
Building uses up the person's assistant allowance, which matters on a subscription. Before making an app or a
change that touches several files, say in a few plain words how big the job is (the usage tool gives what
changes have typically taken) and keep each change small: read only the files you need, and write only the
files that change. If a tool says to stop and check with the person, do that before anything else.`;

// The paid plan as the site shows it: read from Stripe now and then, so the page itself never waits on Stripe.
let paid: PaidPlan | undefined, paidAt = 0;
function paidPlan() {
  if (billingOn() && Date.now() - paidAt > 3_600_000) {
    paidAt = Date.now();
    priceText().then((price) => (paid = { price: price.replace(".00", ""), apps: Number(process.env.PAID_APPS_PER_PERSON ?? 25) })).catch(() => (paidAt = 0));
  }
  return paid;
}
paidPlan();

const { app, pool, init, email, site } = createMapleApp({ manifest: { ...(manifest as Manifest), auth: { ...manifest.auth, open: manifest.auth.open && !process.env.GROVE_INVITE_ONLY } }, slug: "grove", schema, guide, tools, routes, home: ({ mcpUrl }) => sitePage(mcpUrl, Number(process.env.APPS_PER_PERSON ?? 5), paidPlan(), process.env.GROVE_REPO_URL) });

async function appFor(ctx: Ctx, slug: string) {
  await init();
  const { rows: [a] } = await pool.query("select * from apps where slug = $1 and status <> 'creating'", [slug]);
  if (!a || (!ctx.isMaker && !a.makers.includes(ctx.person.email))) throw new Error(`No app called ${slug} that you make. list_apps shows yours.`);
  return a;
}

const changeName = (change: string) => {
  if (!CHANGE.test(change)) throw new Error("change must be short, lowercase letters, digits and dashes, e.g. add-fee-reminders");
  return change;
};

async function filesOf(version: number | string): Promise<Files> {
  const { rows: [v] } = await pool.query("select files from versions where id = $1", [version]);
  if (!v) throw new Error(`Version ${version} is missing.`);
  return v.files;
}

async function changeFor(slug: string, change: string) {
  const { rows: [ch] } = await pool.query("select * from changes where app = $1 and name = $2", [slug, changeName(change)]);
  if (!ch) throw new Error(`No change called ${change} on ${slug}. write_files starts one.`);
  return ch;
}

async function save(slug: string, files: Files, message: string, author: string, shipped = false) {
  const { rows: [v] } = await pool.query("insert into versions (app, files, message, author, shipped_at) values ($1, $2, $3, $4, case when $5 then now() end) returning id", [slug, JSON.stringify(files), message, author, shipped]);
  return v.id as string;
}

/** Checks the types and bundles. Throws with every problem found, written so an assistant can fix them. */
async function built(files: Files) {
  const [c, b] = await Promise.allSettled([check(files), bundle(files)]);
  if (c.status === "rejected") throw c.reason;
  if (b.status === "rejected" && !(b.reason instanceof BuildError)) throw b.reason;
  const problems = [...new Set([...c.value, ...(b.status === "rejected" ? (b.reason as BuildError).problems : [])])];
  if (problems.length || b.status === "rejected") throw new Error(`The code has problems, so nothing was saved or deployed. Fix these and try again:\n${problems.slice(0, 40).join("\n")}`);
  return b.value;
}

/** What a free app gets: database hours a month, and how often a repeating job may run. Both keep the cost of free apps known. */
const FREE_CU_HOURS = Number(process.env.FREE_APP_CU_HOURS ?? 20), FREE_JOB_HOURS = Number(process.env.FREE_APP_JOB_HOURS ?? 6);

/** Puts a built version on one of the app's database branches and makes sign-in work at its address. */
async function putUp(a: any, branch: string, archive: Record<string, string>, version: string, publicUrl?: string, first = false) {
  // Free apps carry a line about Grove at the foot of their pages; the paid plan takes it off.
  const free = (await planFor(pool, a.makers[0])).plan === "free";
  const env = { GROVE_URL: site, GROVE_APP_SECRET: appSecret(a.slug), MAPLE_COMMIT: String(version), ...(publicUrl ? { PUBLIC_URL: publicUrl } : { GROVE_TRIAL: "1" }), ...(free && { GROVE_BADGE: a.slug, MAPLE_MIN_JOB_HOURS: String(FREE_JOB_HOURS) }) };
  // A free app's database gets a monthly allowance; the paid plan has none. Failing to set it doesn't stop the app going up.
  await capCompute(a.neon_project_id, free ? FREE_CU_HOURS : 0).catch((e: Error) => console.error(`compute cap for ${a.slug} not set:`, e.message));
  const { address } = await upload({ key: process.env.NEON_API_KEY!, project: a.neon_project_id, branch }, archive, env);
  const url = publicUrl ?? address;
  // The app's own address at Neon, which Grove's front door on Cloudflare passes requests on to.
  if (publicUrl) await pool.query("update apps set origin = $2 where slug = $1", [a.slug, address]);
  // With Grove's front door on Cloudflare in front of every app (APPS_EDGE), the name is served there, not registered at Neon.
  if (first && publicUrl && publicUrl !== address && !process.env.APPS_EDGE) await registerDomain(a.neon_project_id, branch, new URL(publicUrl).host);
  await setUpSignIn(a.neon_project_id, branch, url, { name: fromName(a.title ?? a.slug), email: `grove@${new URL(site).host}` });
  return url;
}

/** Whether the address is already answering with this version (Neon can take a minute or two to switch). */
const serving = (url: string, version: string | number) =>
  fetch(`${url}/maple/health`, { signal: AbortSignal.timeout(6000) }).then((r) => r.json()).then((h: any) => String(h.commit) === String(version), () => false);

/** Puts the shipped version up again as it is, e.g. after the maker's plan changed or a pause ended. */
async function putUpAgain(a: any) {
  if (a.paused_at || !a.live) return;
  await putUp(a, a.branch_id, await built(await filesOf(a.live)), a.live, a.url);
}

/** Why this app can't be changed right now, if it is paused. Its code and information can still be taken away. */
const notPaused = (a: any) => {
  if (a.paused_at) throw new Error(`${a.slug} has been paused by Grove${a.paused_why ? `: ${a.paused_why}` : ""}. It can't be changed or shipped until that is sorted out${process.env.GROVE_CONTACT_EMAIL ? `: write to ${process.env.GROVE_CONTACT_EMAIL}` : ""}. export_app still gives its code and information.`);
};

const SWITCH = "Neon can take a minute or two to switch to a new version";

function tools(server: McpServer, ctx: Ctx) {
  const { json, person } = ctx;

  // Every tool call is counted against the person and the app, by the size of what went in and what came back.
  // The tools that move a lot of text stop and ask once the day's total reaches what the person has agreed to.
  const register = server.registerTool.bind(server) as (...a: any[]) => any;
  (server as any).registerTool = (name: string, config: any, handler: (args: any, extra: any) => Promise<any>) =>
    register(name, config, async (args: any, extra: any) => {
      await init();
      if (HEAVY.has(name)) {
        const t = await today(pool, person.email), stop = stopMessage(t.used, t.upto);
        if (stop) throw new Error(stop);
      }
      const app = typeof args?.app === "string" ? args.app : name === "create_app" && typeof args?.name === "string" ? args.name : "";
      const sizeIn = JSON.stringify(args ?? {}).length;
      const count = (out: number) => record(pool, person.email, app.slice(0, 60), sizeIn, out).catch((e) => console.error("counting usage:", e));
      try {
        const result = await handler(args, extra);
        await count((result?.content ?? []).reduce((n: number, c: any) => n + (typeof c?.text === "string" ? c.text.length : 0), 0));
        return result;
      } catch (e) {
        await count(e instanceof Error ? e.message.length : 0);
        throw e;
      }
    });

  server.registerTool(
    "usage",
    {
      title: "How much has this used?",
      annotations: { readOnlyHint: true },
      description:
        "How much of the person's assistant allowance Grove's tools have used: today, and per app over the last 30 days, with what one saved change has typically taken (small, medium or large). These count only what passes through Grove; the assistant's own thinking and the length of the chat come on top, usually several times over. Use it to tell the person how big a job is before starting it.",
      inputSchema: {},
    },
    async () => {
      const t = await today(pool, person.email);
      return json({
        today: { tokens: t.used, inWords: `${rounded(t.used)} tokens through Grove's tools today`, grovePausesToAskAt: t.upto },
        apps: await summary(pool, person.email),
        guide: "Sizes are per saved change: small is under 10 thousand tokens, medium under 50 thousand, large is more. Making a new app is usually medium. A fresh chat for each new piece of work keeps the cost per step down.",
      });
    },
  );

  server.registerTool(
    "accept_usage",
    {
      title: "Carry on after a usage warning",
      description: "Records that the person wants to keep going today after Grove stopped to warn them about how much of their assistant allowance has been used. Only call this after telling them the figure and after they have clearly said yes themselves in this chat. Grove will stop and ask again at twice the amount.",
      inputSchema: { agree: z.literal(true).describe("true only when the person has just said they want to carry on") },
    },
    async () => {
      const { used, next } = await carryOn(pool, person.email);
      return json({ carryOn: true, usedToday: used, grovePausesToAskAgainAt: next, firstPauseEachDay: firstLimit() });
    },
  );

  /** Making, changing and paying need the person's agreement to the current terms, and an account in good standing. */
  const mustAgree = async () => {
    const why = await blockedWhy(pool, person.email);
    if (why) throw new Error(`This account can't make or change apps: ${why}${process.env.GROVE_CONTACT_EMAIL ? ` To ask about it, write to ${process.env.GROVE_CONTACT_EMAIL}.` : ""}`);
    if (!(await agreed(pool, person.email)))
      throw new Error(`Before this, the person needs to agree to Grove's terms (${site}/terms) and privacy notice (${site}/privacy). Show them both links, ask if they agree, and when they say yes call accept_terms.`);
  };

  /** Checks and saves the files as the newest version of a change, and puts it up as a preview on its own copy of the database. */
  const preview = async (a: any, change: string, ch: any, files: Files, message: string) => {
    notPaused(a);
    // Each open change has a preview with its own copy of the database, and Neon allows ten copies per app.
    if (!ch) {
      const { rows: [{ n }] } = await pool.query("select count(*)::int n from changes where app = $1", [a.slug]);
      if (n >= MAX_OPEN_CHANGES) throw new Error(`${a.slug} already has ${n} open changes, which is the most an app can have. Ship or drop one first (app_status lists them).`);
    }
    if (!ctx.isMaker) await underBuildLimit(pool, person.email, (await planFor(pool, person.email)).plan === "paid");
    const archive = await built(files);
    const version = await save(a.slug, files, message, person.email);
    for (const c of concerns(files)) await report(pool, a.slug, c, "Grove check");
    const branch = ch?.branch_id ?? (await createBranch(a.neon_project_id, `preview-${change}`, a.branch_id));
    await pool.query(
      "insert into changes (app, name, version, base, branch_id) values ($1, $2, $3, $4, $5) on conflict (app, name) do update set version = $3, branch_id = $5, updated_at = now()",
      [a.slug, change, version, a.live, branch],
    );
    const url = await putUp(a, branch, archive, version);
    await pool.query("update changes set url = $3 where app = $1 and name = $2", [a.slug, change, url]);
    return { change, version, status: "saved", preview: url, previewConnect: url + "/mcp", next: `${SWITCH}; change_status says when the preview shows this version. Show the person the preview, and ship_change when they say so.` };
  };

  const makerOnly = () => {
    if (!ctx.isMaker) throw new Error("Only Grove's maker can do this.");
  };

  /** Swaps an app (and its previews) for the paused page, or puts it back. */
  const pause = async (a: any, why: string) => {
    await pool.query("update apps set paused_at = now(), paused_why = $2 where slug = $1", [a.slug, why]);
    const { rows } = await pool.query("select branch_id from changes where app = $1 and branch_id is not null", [a.slug]);
    for (const branch of [a.branch_id, ...rows.map((r) => r.branch_id)])
      await upload({ key: process.env.NEON_API_KEY!, project: a.neon_project_id, branch }, pausedArchive(a.title, site), { MAPLE_COMMIT: "paused" });
  };

  server.registerTool(
    "pause_app",
    {
      title: "Pause an app",
      description: "For Grove's maker: takes an app offline and shows a 'paused' page in its place (Neon takes a minute or two to switch, so the app can still answer for that long), for an app that is harming people or breaking the terms. Its code and information are kept, and its maker can still download them, but can't change or ship it. Give the reason in words its maker can read. Confirm first.",
      inputSchema: { app: z.string(), why: z.string().min(5).max(500) },
    },
    async ({ app: slug, why }) => {
      makerOnly();
      const a = await appFor(ctx, slug);
      await pause(a, why);
      return json({ paused: slug, why, makers: a.makers, next: "The app can keep answering for a minute or two while Neon switches to the paused page. resume_app puts it back; leave a few minutes between pausing and resuming." });
    },
  );

  server.registerTool(
    "resume_app",
    { title: "Put a paused app back", description: "For Grove's maker: puts a paused app back online as it was. Its previews come back the next time each change is saved.", inputSchema: { app: z.string() } },
    async ({ app: slug }) => {
      makerOnly();
      const a = await appFor(ctx, slug);
      if (!a.paused_at) return json({ app: slug, note: "It wasn't paused." });
      await pool.query("update apps set paused_at = null, paused_why = null where slug = $1", [slug]);
      await putUpAgain({ ...a, paused_at: null });
      return json({ resumed: slug });
    },
  );

  server.registerTool(
    "block_person",
    {
      title: "Block a person",
      description: "For Grove's maker: stops a person making or changing apps, and pauses every app they make. For someone using Grove to harm people. Give the reason in words they can read. Confirm first.",
      inputSchema: { email: z.string().email(), why: z.string().min(5).max(500) },
    },
    async ({ email: who, why }) => {
      makerOnly();
      await init();
      const address = who.toLowerCase();
      if (address === person.email) throw new Error("That's you.");
      await pool.query("insert into blocked (email, why) values ($1, $2) on conflict (email) do update set why = $2", [address, why]);
      const { rows } = await pool.query("select * from apps where $1 = any(makers) and paused_at is null and status <> 'creating'", [address]);
      for (const a of rows) await pause(a, why);
      return json({ blocked: address, appsPaused: rows.map((a) => a.slug) });
    },
  );

  server.registerTool(
    "unblock_person",
    { title: "Unblock a person", description: "For Grove's maker: lets a blocked person make and change apps again. Their paused apps stay paused until resume_app.", inputSchema: { email: z.string().email() } },
    async ({ email: who }) => {
      makerOnly();
      await init();
      const { rowCount } = await pool.query("delete from blocked where email = $1", [who.toLowerCase()]);
      const { rows } = await pool.query("select slug from apps where $1 = any(makers) and paused_at is not null", [who.toLowerCase()]);
      return json({ unblocked: Boolean(rowCount), stillPaused: rows.map((a) => a.slug) });
    },
  );

  server.registerTool(
    "services",
    {
      title: "What Grove does for apps",
      annotations: { readOnlyHint: true },
      description:
        "What Grove can do for an app so its maker sets nothing up: email, background work and files (real), and payments, text messages, AI and PDFs (pretend for now: they answer in the real shape but nothing really happens). Use it before building a feature that needs one, and to see what an app has asked for lately. With app, also lists that app's last 30 calls. Tell the person plainly which services are pretend.",
      inputSchema: { app: z.string().optional().describe("One of the person's apps, to see what it has used") },
    },
    async ({ app: slug }) => {
      await init();
      const list = SERVICES.map((s) => ({ service: s.name, status: s.real ? "real" : "pretend for now", what: s.what, inCode: s.use }));
      if (!slug) return json({ services: list, howTo: "Each app's AGENTS.md and src/maple/services.ts say how to call them. Apps made before services existed need update_kit first." });
      const a = await appFor(ctx, slug);
      const { rows } = await pool.query("select service, action, mock as pretend, trial, result, at from service_calls where app = $1 order by id desc limit 30", [a.slug]);
      return json({ services: list, recent: rows });
    },
  );

  server.registerTool(
    "list_reports",
    {
      title: "Reports about apps",
      annotations: { readOnlyHint: true },
      description: "For Grove's maker: open reports about apps, from the public and from Grove's own check of app code (reporter 'Grove check'), with who makes each app and whether it is paused. A report is something to look into, not proof.",
      inputSchema: {},
    },
    async () => {
      makerOnly();
      await init();
      const { rows } = await pool.query("select r.id, r.app, r.what, r.reporter, r.created_at, a.makers, a.url, a.paused_at is not null as paused from reports r left join apps a on a.slug = r.app where r.closed_at is null order by r.created_at desc limit 100");
      return json({ reports: rows });
    },
  );

  server.registerTool(
    "close_report",
    { title: "Close a report", description: "For Grove's maker: marks a report as dealt with, whatever was decided.", inputSchema: { id: z.number().int() } },
    async ({ id }) => {
      makerOnly();
      await init();
      const { rowCount } = await pool.query("update reports set closed_at = now() where id = $1 and closed_at is null", [id]);
      return json({ closed: Boolean(rowCount) });
    },
  );

  server.registerTool(
    "accept_terms",
    {
      title: "Agree to Grove's terms",
      description: "Records that the person agrees to Grove's terms and privacy notice. Only call this after showing them both links and after they have clearly said yes themselves in this chat. Never call it on their behalf.",
      inputSchema: { agree: z.literal(true).describe("true only when the person has just said they agree") },
    },
    async () => {
      await init();
      if (!termsOn()) return json({ agreed: true, note: "There is nothing to agree to yet." });
      await agree(pool, person.email);
      return json({ agreed: true, version: TERMS_VERSION, terms: `${site}/terms`, privacy: `${site}/privacy` });
    },
  );

  server.registerTool(
    "create_app",
    {
      title: "Create an app",
      description:
        "Creates a new app and puts it live: its own Postgres database, email-code sign-in, its own address and a Claude connector, starting from the MAPLE template. The person asking becomes its maker. users are the emails of the people it is for, who can sign in (more can be added later from inside the app). Takes about 20 seconds. Then build the described features with write_files. Confirm the name and who it is for first.",
      inputSchema: {
        name: z.string().regex(SLUG).describe("Short lowercase name; it becomes the app's address, e.g. river-rowing-fees"),
        title: z.string().min(2).max(60).describe("Name people see, e.g. 'Club Helper'"),
        description: z.string().min(10).max(1000).describe("What it is for and what it should do, in a sentence or three"),
        users: z.array(z.string().email()).max(50).default([]),
        audience: z.enum(["everyone", "technical"]).default("everyone").describe("everyone: users know nothing about software (the default)"),
      },
    },
    async ({ name, title, description, users, audience }) => {
      await init();
      await mustAgree();
      if (RESERVED.has(name)) throw new Error(`${name} can't be used as a name. Pick another.`);
      const { rows: [{ mine, total }] } = await pool.query("select count(*) filter (where $1 = any(makers))::int mine, count(*)::int total from apps", [person.email]);
      const plan = await planFor(pool, person.email);
      if (!ctx.isMaker && mine >= plan.apps)
        throw new Error(plan.plan === "free" && billingOn() ? `That's all ${plan.apps} apps on the free plan. The paid plan allows more: the upgrade tool gives a payment link.` : `That's all ${plan.apps} apps on your plan. Ask the Grove maker for more.`);
      if (total >= Number(process.env.GROVE_MAX_APPS ?? 80)) throw new Error("Grove is full for now. Ask the Grove maker.");
      const taken = await pool.query("insert into apps (slug, title, description, makers, users, secret_hash) values ($1, $2, $3, $4, $5, $6) on conflict do nothing", [name, title, description, [person.email], users.map((u) => u.toLowerCase()), hash(appSecret(name))]);
      if (!taken.rowCount) throw new Error(`There is already an app called ${name}. Pick another name.`);
      const appManifest = {
        $schema: "https://raw.githubusercontent.com/makemore/maple/main/maple.schema.json",
        maple: "0.1",
        name,
        title,
        description,
        maker: { name: person.email.split("@")[0], email: person.email },
        auth: { method: "email-code", allowed: users },
        mcp: { audience },
        loop: {},
        database: {},
      };
      const files: Files = { ...TEMPLATE, "maple.json": JSON.stringify(appManifest, null, 2) + "\n", "README.md": `# ${title}\n\n${description}\n\nA MAPLE app made with Grove. See AGENTS.md to build on it.\n` };
      let made: { project: string; branch: string } | undefined;
      try {
        const [archive, where] = await Promise.all([built(files), createProject(name).then((p) => (made = p))]);
        const version = await save(name, files, `Start ${title} from the MAPLE template`, person.email, true);
        const a = { slug: name, title, neon_project_id: where.project, makers: [person.email] };
        const url = await putUp(a, where.branch, archive, version, DOMAIN && `https://${name}.${DOMAIN}`, true);
        await pool.query("update apps set neon_project_id = $2, branch_id = $3, url = $4, live = $5, status = 'live' where slug = $1", [name, where.project, where.branch, url, version]);
        return json({ app: name, status: "starting", address: url, connect: url + "/mcp", next: "The address starts answering within a minute or two; app_status says when. Meanwhile, read AGENTS.md and src/app.ts and start building the features with write_files." });
      } catch (e) {
        if (made) await deleteProject(made.project).catch(() => {});
        await pool.query("delete from versions where app = $1", [name]);
        await pool.query("delete from apps where slug = $1", [name]);
        throw e;
      }
    },
  );

  server.registerTool(
    "list_apps",
    { title: "Your apps", annotations: { readOnlyHint: true }, description: "Apps you make (all apps, for Grove's maker), newest first.", inputSchema: {} },
    async () => {
      await init();
      const { rows } = await pool.query("select slug, title, description, makers, users, url, status, created_at from apps where $1 or $2 = any(makers) order by created_at desc", [ctx.isMaker, person.email]);
      return json(rows);
    },
  );

  server.registerTool(
    "app_status",
    {
      title: "Is it live?",
      annotations: { readOnlyHint: true },
      description: "Whether an app's latest shipped version is answering yet (live) or still switching over (starting), its address, the connection address to add in Claude, its open changes and what shipped lately.",
      inputSchema: { app: z.string() },
    },
    async ({ app: slug }) => {
      const a = await appFor(ctx, slug);
      const [ok, changes, shipped] = await Promise.all([
        serving(a.url, a.live),
        pool.query("select name, updated_at from changes where app = $1 order by updated_at desc", [slug]),
        pool.query("select id as version, message, author, shipped_at from versions where app = $1 and shipped_at is not null order by shipped_at desc, id desc limit 5", [slug]),
      ]);
      const kitBehind = diff(await filesOf(a.live), withKit(await filesOf(a.live), TEMPLATE)).length > 0;
      if (a.paused_at) return json({ app: slug, status: "paused", why: a.paused_why, address: a.url, note: "Grove has paused this app. export_app still gives its code and information." });
      return json({ app: slug, status: ok ? "live" : "starting", version: a.live, kit: kitBehind ? "a newer kit is available: update_kit" : "up to date", address: a.url, connect: a.url + "/mcp", openChanges: changes.rows, shipped: shipped.rows, ...(!ok && { note: `${SWITCH}; check again shortly.` }) });
    },
  );

  server.registerTool(
    "plan",
    { title: "Your plan", annotations: { readOnlyHint: true }, description: "Which Grove plan the person is on (free or paid), how many apps it allows and how many they have, and what the paid plan costs.", inputSchema: {} },
    async () => {
      await init();
      const [p, { rows: [{ n }] }] = await Promise.all([planFor(pool, person.email), pool.query("select count(*)::int n from apps where $1 = any(makers)", [person.email])]);
      return json({ plan: p.plan, appsAllowed: p.apps, appsMade: n, ...(billingOn() ? p.plan === "free" && { paidPlan: { apps: Number(process.env.PAID_APPS_PER_PERSON ?? 25), price: await priceText() } } : { note: "There is no paid plan yet." }) });
    },
  );

  server.registerTool(
    "upgrade",
    {
      title: "Move to the paid plan",
      description: "Gives a link to a secure payment page (Stripe) for Grove's paid plan, which allows more apps. Tell the person the price from the plan tool first. Payment happens on that page, never in the chat: don't ask for card details.",
      inputSchema: {},
    },
    async () => {
      await init();
      if (!billingOn()) throw new Error("There is no paid plan yet.");
      await mustAgree();
      const p = await planFor(pool, person.email);
      if (p.plan === "paid") throw new Error("Already on the paid plan. manage_billing changes or cancels it.");
      return json({ payHere: await checkout(person.email, site, p.customer), price: await priceText(), next: "Once paid, the plan tool shows the paid plan within a minute." });
    },
  );

  server.registerTool(
    "manage_billing",
    { title: "Change or cancel the paid plan", description: "Gives a link to Stripe's page for changing the card, seeing invoices or cancelling the paid plan.", inputSchema: {} },
    async () => {
      await init();
      const p = await planFor(pool, person.email);
      if (!billingOn() || !p.customer) throw new Error("There is nothing to manage: this person has never paid for Grove.");
      return json({ manageHere: await portal(p.customer, site) });
    },
  );

  server.registerTool(
    "list_waitlist",
    {
      title: "Who asked for an invite",
      annotations: { readOnlyHint: true },
      description: "For Grove's maker: people who asked for an invite on the website, newest first, with what they'd like to make. Let one in with add_person.",
      inputSchema: {},
    },
    async () => {
      if (!ctx.isMaker) throw new Error("Only Grove's maker can see the waiting list.");
      await init();
      const { rows } = await pool.query("select w.email, w.idea, w.created_at, (p.email is not null) as invited from waitlist w left join maple_people p on p.email = w.email order by w.created_at desc limit 200");
      return json(rows);
    },
  );

  server.registerTool(
    "list_files",
    {
      title: "List an app's files",
      annotations: { readOnlyHint: true },
      description: "Every file in an app's code, as shipped or in a change, with sizes. Files under src/maple/ are MAPLE's and can't be changed.",
      inputSchema: { app: z.string(), change: z.string().optional().describe("A change name; omit for the shipped code") },
    },
    async ({ app: slug, change }) => {
      const a = await appFor(ctx, slug);
      const files = await filesOf(change ? (await changeFor(slug, change)).version : a.live);
      return json({ of: change ?? "shipped", files: Object.entries(files).map(([path, content]) => ({ path, size: Buffer.byteLength(content) })) });
    },
  );

  server.registerTool(
    "read_files",
    {
      title: "Read an app's files",
      annotations: { readOnlyHint: true },
      description: "Reads up to 20 files from an app's code, as shipped or in a change. Start with AGENTS.md and src/app.ts.",
      inputSchema: { app: z.string(), paths: z.array(z.string()).min(1).max(20), change: z.string().optional() },
    },
    async ({ app: slug, paths, change }) => {
      const a = await appFor(ctx, slug);
      const files = await filesOf(change ? (await changeFor(slug, change)).version : a.live);
      return json({ of: change ?? "shipped", files: paths.map((path) => (path in files ? { path, content: files[path] } : { path, missing: true })) });
    },
  );

  server.registerTool(
    "write_files",
    {
      title: "Change an app's code",
      description:
        "Writes whole files (content) or deletes them (content null) in a named change to an app; the change starts from the shipped code the first time. The result is checked (types and imports) straight away: if there are problems they come back and nothing is saved, so fix them and write again. If it passes, it is saved and put up as a preview with its own copy of the database. Never touches the live app: ship_change does that. Files under src/maple/ are refused.",
      inputSchema: {
        app: z.string(),
        change: z.string().describe("Short name for this change, e.g. add-fee-reminders. Reuse it to fix or extend the same change."),
        message: z.string().min(3).max(500).describe("What this changes and why"),
        files: z.array(z.object({ path: z.string().min(1).max(200), content: z.string().max(MAX_FILE).nullable() })).min(1).max(30),
      },
    },
    async ({ app: slug, change, message, files: writes }) => {
      const a = await appFor(ctx, slug);
      await mustAgree();
      changeName(change);
      const { rows: [ch] } = await pool.query("select * from changes where app = $1 and name = $2", [slug, change]);
      const files = applyWrites(await filesOf(ch ? ch.version : a.live), writes);
      return json(await preview(a, change, ch, files, message));
    },
  );

  server.registerTool(
    "update_kit",
    {
      title: "Bring an app's kit up to date",
      description:
        "Every app carries its own copy of the MAPLE kit (sign-in, the assistant connection, people, requests, email). This puts the newest kit into an app as a change called kit-update, checked and previewed like any other; nothing the maker wrote is touched. Ship it with ship_change once the preview works. Says so if the app is already up to date.",
      inputSchema: { app: z.string() },
    },
    async ({ app: slug }) => {
      const a = await appFor(ctx, slug);
      await mustAgree();
      const live = await filesOf(a.live), files = withKit(live, TEMPLATE);
      const changed = diff(live, files);
      if (!changed.length) return json({ app: slug, kit: "up to date" });
      tooBig(files);
      const { rows: [ch] } = await pool.query("select * from changes where app = $1 and name = 'kit-update'", [slug]);
      return json({ ...(await preview(a, "kit-update", ch, files, "Bring the MAPLE kit up to date")), filesChanged: changed });
    },
  );

  server.registerTool(
    "change_status",
    {
      title: "How is the change doing?",
      annotations: { readOnlyHint: true },
      description: "For a change: its preview address, whether the preview is showing the latest saved version yet (ready) or still switching (starting), and the files it changes compared with the shipped code.",
      inputSchema: { app: z.string(), change: z.string() },
    },
    async ({ app: slug, change }) => {
      const a = await appFor(ctx, slug);
      const ch = await changeFor(slug, change);
      const [ok, mine, live] = await Promise.all([ch.url ? serving(ch.url, ch.version) : false, filesOf(ch.version), filesOf(a.live)]);
      return json({
        change,
        status: ok ? "ready" : "starting",
        version: ch.version,
        preview: ch.url,
        previewConnect: ch.url && ch.url + "/mcp",
        filesChanged: diff(live, mine),
        ...(ch.base !== a.live && { note: "Other changes have shipped since this one started. ship_change combines them if they don't touch the same files." }),
      });
    },
  );

  server.registerTool(
    "ship_change",
    {
      title: "Ship a change",
      description: "Makes a change the live app: the same code that was previewed, combined with anything shipped since. The preview and its copy of the database are removed. Only when the person has said to ship it.",
      inputSchema: { app: z.string(), change: z.string() },
    },
    async ({ app: slug, change }) => {
      const a = await appFor(ctx, slug);
      await mustAgree();
      notPaused(a);
      const ch = await changeFor(slug, change);
      let files = await filesOf(ch.version), version: string = ch.version;
      if (ch.base !== a.live) {
        const m = merge(await filesOf(ch.base), await filesOf(a.live), files);
        if (m.clashes.length) throw new Error(`This change clashes with something shipped since it started, in: ${m.clashes.join(", ")}. Read those files from the shipped code, write the combined versions to this change, and ship again.`);
        files = m.files;
      }
      const archive = await built(files);
      const { rows: [msg] } = await pool.query("select message from versions where id = $1", [ch.version]);
      if (ch.base !== a.live) version = await save(slug, files, msg.message, person.email);
      await putUp(a, a.branch_id, archive, version, a.url);
      await pool.query("update versions set shipped_at = now(), message = $2 where id = $1", [version, `${change}: ${msg.message}`.slice(0, 600)]);
      await pool.query("update apps set live = $2 where slug = $1", [slug, version]);
      await pool.query("delete from changes where app = $1 and name = $2", [slug, change]);
      if (ch.branch_id) await deleteBranch(a.neon_project_id, ch.branch_id).catch((e) => console.error("preview not removed:", e));
      return json({ shipped: change, version, address: a.url, next: `${SWITCH}; app_status says when it is live.` });
    },
  );

  server.registerTool(
    "drop_change",
    {
      title: "Throw a change away",
      description: "Removes a change and its preview without shipping it. Confirm first.",
      inputSchema: { app: z.string(), change: z.string() },
    },
    async ({ app: slug, change }) => {
      const a = await appFor(ctx, slug);
      const ch = await changeFor(slug, change);
      if (ch.branch_id) await deleteBranch(a.neon_project_id, ch.branch_id);
      await pool.query("delete from changes where app = $1 and name = $2", [slug, change]);
      return json({ dropped: change });
    },
  );

  server.registerTool(
    "rollback",
    {
      title: "Undo the last ship",
      description: "Puts the app's code back to how it was before the last shipped change, as a new version (nothing is lost; data is untouched). Confirm first.",
      inputSchema: { app: z.string() },
    },
    async ({ app: slug }) => {
      const a = await appFor(ctx, slug);
      notPaused(a);
      const { rows } = await pool.query("select id, message from versions where app = $1 and shipped_at is not null order by shipped_at desc, id desc limit 2", [slug]);
      if (rows.length < 2) throw new Error("Nothing to roll back to.");
      const files = await filesOf(rows[1].id);
      const archive = await built(files);
      const version = await save(slug, files, `Roll back "${rows[0].message}"`.slice(0, 600), person.email, true);
      await putUp(a, a.branch_id, archive, version, a.url);
      await pool.query("update apps set live = $2 where slug = $1", [slug, version]);
      return json({ rolledBack: rows[0].message, version, next: `${SWITCH}; app_status says when it is live.` });
    },
  );

  server.registerTool(
    "give_app",
    {
      title: "Hand an app over",
      description:
        "For an app's maker: offers the whole app to someone else, such as the client it was made for. Nothing changes until they accept it from their own Grove with accept_app, within 14 days. When they do, they become its only maker (it counts as one of their apps, on their plan) and the person giving it loses it. Its address, code, information and people stay as they are. Confirm the email with the person first. With to left out, takes back an offer.",
      inputSchema: { app: z.string(), to: z.string().email().optional().describe("Who to offer it to. Leave out to take the offer back.") },
    },
    async ({ app: slug, to }) => {
      await mustAgree();
      const a = await appFor(ctx, slug);
      notPaused(a);
      if (!to) return json({ withdrawn: Boolean((await pool.query("delete from app_offers where app = $1", [a.slug])).rowCount) });
      const email_ = to.toLowerCase();
      if (a.makers.includes(email_)) throw new Error("They already make this app.");
      if (await blockedWhy(pool, email_)) throw new Error("That person can't be given apps on this Grove.");
      await pool.query("insert into app_offers (app, to_email, from_email) values ($1, $2, $3) on conflict (app) do update set to_email = $2, from_email = $3, at = now()", [a.slug, email_, person.email]);
      const told = await sendMail(`Grove <grove@${new URL(site).host}>`, email_, `${person.email} wants to hand you an app: ${a.title}`,
        `${person.email} has offered you ${a.title} (${a.url}), an app made with Grove.\n\nIf you accept, it becomes yours: you'd be the one who can change it, and it would count as one of your apps.\n\nTo accept, add Grove to your AI assistant (${site}/#connect), sign in with this email address, and say: accept the app ${a.slug}\n\nThe offer lasts 14 days. If you weren't expecting this, ignore it and nothing happens.`, person.email);
      return json({ offered: a.slug, to: email_, emailed: told, next: `They accept from their own Grove by saying "accept the app ${a.slug}". Until then nothing changes, and give_app without "to" takes the offer back.` });
    },
  );

  server.registerTool(
    "accept_app",
    {
      title: "Accept an app someone is handing over",
      description: "Accepts an app another maker offered to the signed-in person with give_app. They become its only maker and it counts as one of their apps. With no app, lists what they have been offered. Ask before accepting.",
      inputSchema: { app: z.string().optional() },
    },
    async ({ app: slug }) => {
      await init();
      const { rows: offers } = await pool.query("select o.app, o.from_email, o.at, a.title, a.url from app_offers o join apps a on a.slug = o.app where o.to_email = $1 and o.at > now() - interval '14 days'", [person.email]);
      if (!slug) return json({ offers });
      await mustAgree();
      const offer = offers.find((o) => o.app === slug);
      if (!offer) throw new Error(`Nobody has offered you an app called ${slug}, or the offer has run out.`);
      const { rows: [a] } = await pool.query("select * from apps where slug = $1", [slug]);
      notPaused(a);
      const [plan, { rows: [{ n }] }] = await Promise.all([planFor(pool, person.email), pool.query("select count(*)::int n from apps where $1 = any(makers)", [person.email])]);
      if (n >= plan.apps) throw new Error(`That would be more than the ${plan.apps} apps on your plan. ${plan.plan === "free" && billingOn() ? "The upgrade tool gives a link to the paid plan." : "Delete one first."}`);
      // The app keeps its own list of people, in its own database: make the new maker one there, and the old makers ordinary users.
      const db = new Client({ connectionString: await connectionUri(a.neon_project_id, a.branch_id) });
      await db.connect();
      try {
        await db.query("update maple_people set role = 'user' where role = 'maker'");
        await db.query("insert into maple_people (email, role, added_by) values ($1, 'maker', 'grove') on conflict (email) do update set role = 'maker'", [person.email]);
      } finally {
        await db.end();
      }
      await pool.query("update apps set makers = $2, users = (select coalesce(array_agg(distinct u), '{}') from unnest(users || makers) u where u <> $3) where slug = $1", [a.slug, [person.email], person.email]);
      await pool.query("delete from app_offers where app = $1", [a.slug]);
      // The line free apps carry depends on the maker's plan, so put the app up again under the new one.
      waitUntil(putUpAgain({ ...a, makers: [person.email] }).catch((e) => console.error("after hand-over:", e)));
      return json({ yours: a.slug, address: a.url, from: offer.from_email, note: `${offer.from_email} can still use the app as an ordinary person unless you remove them in the app itself. The app's maple.json still names them as its maker: change the name and email there with your next change.` });
    },
  );

  server.registerTool(
    "delete_app",
    {
      title: "Delete an app",
      description: "Deletes an app for good: its address stops working and its database, with everything in it, is destroyed. This can't be undone. Offer export_app first, and only go ahead when the person has typed the app's name to confirm.",
      inputSchema: { app: z.string(), confirm: z.string().describe("The app's name again, as typed by the person") },
    },
    async ({ app: slug, confirm }) => {
      const a = await appFor(ctx, slug);
      if (confirm !== slug) throw new Error("confirm must be the app's name, typed by the person.");
      if (a.neon_project_id) await deleteProject(a.neon_project_id).catch((e) => { if (!/ 404 /.test(String(e))) throw e; });
      await removeFilesOf(pool, slug);
      for (const t of ["changes", "versions", "app_offers", "service_calls", "pretend_payments"]) await pool.query(`delete from ${t} where app = $1`, [slug]);
      await pool.query("delete from apps where slug = $1", [slug]);
      return json({ deleted: slug });
    },
  );

  server.registerTool(
    "export_app",
    {
      title: "Take an app away",
      description: "For an app's maker: a link to download the app's shipped code as a zip (an ordinary project that runs anywhere Node and Postgres do; with Neon's tools, 'neon deploy' puts it up on your own account). With database true, also the connection string for the app's live database, to copy the data out with pg_dump. The connection string is a password: only show it when the person asks for their data.",
      inputSchema: { app: z.string(), database: z.boolean().default(false) },
    },
    async ({ app: slug, database }) => {
      const a = await appFor(ctx, slug);
      const until = Date.now() + 3600_000;
      return json({
        download: `${site}/export/${slug}.zip?v=${a.live}&until=${until}&sig=${sign(`export:${slug}:${a.live}:${until}`)}`,
        linkWorksFor: "one hour",
        ...(database && { database: await connectionUri(a.neon_project_id, a.branch_id), databaseNote: "Anyone with this can read and change the app's data. Copy it out with: pg_dump '<connection string>' > data.sql" }),
      });
    },
  );
}

// Apps send their loop emails here, so they never hold an email key. Each app proves itself with its own secret.
function routes(app: import("hono").Hono<any>) {
  // The website's invite form. Open to anyone, so it only ever stores an email and a short note, and stops at 200 a day.
  app.get("/terms", (c) => c.html(termsPage()));
  app.get("/privacy", (c) => c.html(privacyPage()));

  // Anyone can report an app, signed in or not. Reports go to Grove's maker (list_reports) and by email.
  app.get("/report", (c) => c.html(reportPage(appNamed(c.req.query("app") ?? ""))));
  app.post("/report", async (c) => {
    const form = await c.req.parseBody();
    const typed = String(form.app ?? ""), what = String(form.what ?? "").trim(), from = String(form.email ?? "").trim();
    if (!typed.trim() || what.length < 5) return c.html(reportPage(appNamed(typed), "Please say which app and what is wrong."), 400);
    await init();
    const { rows: [a] } = await pool.query("select slug, url from apps where slug = $1", [appNamed(typed)]);
    if (!a) return c.html(reportPage(typed.trim().slice(0, 200), "We couldn't find an app with that name. Check the address and try again."), 404);
    if (await report(pool, a.slug, what, from || "someone who didn't leave an email")) {
      const { rows } = await pool.query("select email from maple_people where role = 'maker'");
      waitUntil(email(rows.map((r) => r.email), `Report about ${a.slug}`, `${what.slice(0, 2000)}\n\nApp: ${a.url}\nFrom: ${from || "no email given"}\n\nlist_reports in Grove shows all open reports; pause_app takes an app offline.`, from || undefined).catch(() => false));
    }
    return c.html(reportPage("", "Thank you. Your report has been sent and a person will read it."));
  });

  app.post("/join", async (c) => {
    const body = await c.req.json<{ email?: unknown; idea?: unknown }>().catch(() => ({}) as { email?: unknown; idea?: unknown });
    const address = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (address.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return c.json({ message: "That doesn't look like an email address." }, 400);
    await init();
    const { rows: [{ n }] } = await pool.query("select count(*)::int n from waitlist where created_at > now() - interval '1 day'");
    if (n >= 200) return c.json({ message: "The list is full for today. Please try again tomorrow." }, 429);
    await pool.query("insert into waitlist (email, idea) values ($1, $2) on conflict (email) do nothing", [address, typeof body.idea === "string" ? body.idea.trim().slice(0, 1000) || null : null]);
    return c.json({ message: "Thanks. We've got it." });
  });

  // The download link export_app gives out: the app's code as a zip. The link is signed and lasts an hour.
  app.get("/export/:file", async (c) => {
    const slug = c.req.param("file").replace(/\.zip$/, ""), v = c.req.query("v") ?? "", until = c.req.query("until") ?? "";
    const want = Buffer.from(sign(`export:${slug}:${v}:${until}`)), got = Buffer.from(c.req.query("sig") ?? "");
    if (got.length !== want.length || !timingSafeEqual(got, want) || Number(until) < Date.now()) return c.text("This link has expired. Ask for a new one.", 403);
    await init();
    const { rows: [row] } = await pool.query("select files from versions where id = $1 and app = $2", [v, slug]);
    if (!row) return c.text("Not found.", 404);
    return new Response(new Uint8Array(zip(row.files)), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${slug}.zip"` } });
  });

  // Stripe tells Grove here when someone pays, changes or cancels. Each call is signed by Stripe.
  app.post("/stripe/webhook", async (c) => {
    const body = await c.req.text();
    if (!verified(body, c.req.header("stripe-signature"))) return c.json({ error: "Bad signature." }, 400);
    await init();
    const whose = await onEvent(pool, JSON.parse(body));
    // The plan decides whether the person's apps carry the line about Grove, so put them up again. Not worth making Stripe wait.
    if (whose)
      waitUntil(
        (async () => {
          const { rows } = await pool.query("select * from apps where makers[1] = $1 and status <> 'creating'", [whose]);
          for (const a of rows) await putUpAgain(a).catch((e) => console.error(`putting ${a.slug} up again:`, e));
        })(),
      );
    return c.json({ received: true });
  });

  // What apps ask Grove to do for them. Each app proves who it is with its own secret, as for /api/notify.
  app.post("/services/:service/:action", async (c) => {
    const { service, action } = c.req.param();
    const secret = (c.req.header("authorization") ?? "").replace(/^Bearer /i, "");
    if (!secret) return c.json({ error: "No app secret." }, 401);
    await init();
    const want = hash(secret);
    const { rows: [a] } = await pool.query("select slug, title, url, makers, users, paused_at, secret_hash from apps where secret_hash = $1", [want]);
    if (!a || !timingSafeEqual(Buffer.from(a.secret_hash), Buffer.from(want))) return c.json({ error: "Unknown app." }, 401);
    if (!known(service, action)) return c.json({ error: "Grove has no such service." }, 404);
    if (a.paused_at) return c.json({ error: "This app is paused." }, 403);
    const body: any = await c.req.json().catch(() => ({}));
    const trial = body?.trial === true;
    try {
      const { rows: [{ n }] } = await pool.query("select count(*)::int n from service_calls where app = $1 and at > now() - interval '1 hour'", [a.slug]);
      if (n >= 600) throw new ServiceError("This app has asked Grove for too much in the last hour. Try again later.", 429);
      let result: any, kept: any = {};
      const id = randomUUID();
      if (service === "email") {
        const mail = checkEmail(body);
        const who = whoGets(mail.to, [...a.makers, ...a.users], trial);
        const paid = (await planFor(pool, a.makers[0])).plan !== "free";
        const { rows: [{ sent }] } = await pool.query("select coalesce(sum(jsonb_array_length(result->'sent')), 0)::int sent from service_calls where app = $1 and service = 'email' and at > now() - interval '1 day'", [a.slug]);
        if (sent + who.sent.length > appEmailsPerDay(paid)) throw new ServiceError(`This app has sent all the emails it can today (${appEmailsPerDay(paid)}).`, 429);
        const went: string[] = [], failed: string[] = [];
        for (const to of who.sent) ((await sendMail(`${fromName(a.title)} <grove@${new URL(site).host}>`, to, mail.subject, mail.text + footer(a, site), mail.replyTo ?? a.makers[0])) ? went : failed).push(to);
        if (failed.length && !went.length) throw new ServiceError("The email could not be sent. Try again in a minute.", 502);
        result = { sent: went, held: who.held, ...(failed.length && { failed }), ...(who.held.length && { note: "This is a trial copy, so only the app's own people were emailed. The held addresses will be emailed once the change is live." }) };
        kept = { to: mail.to, subject: mail.subject };
      } else if (service === "tasks") {
        if (!trial) await wakeAt(pool, a.slug, body);
        return c.json({ ok: true });
      } else if (service === "files" && filesOn()) {
        const paid = (await planFor(pool, a.makers[0])).plan !== "free";
        result = action === "put" ? await keepFile(pool, a.slug, body, id, { site, paid, trial, sign }) : action === "link" ? await linkFile(pool, a.slug, body, { site, sign }) : await removeFile(pool, a.slug, body);
        kept = { name: body?.name, type: body?.type, id: body?.id };
        await pool.query("insert into service_calls (app, service, action, body, result, mock, trial) values ($1, $2, $3, $4, $5, false, $6)", [a.slug, service, action, JSON.stringify(kept), JSON.stringify(result), trial]);
        return c.json(result);
      } else if (service === "payments" && action === "checkout") result = await pretendCheckout(pool, a.slug, body, id, site);
      else if (service === "payments") result = await pretendStatus(pool, a.slug, body);
      else {
        result = pretend(service, action, body, id, site);
        const { base64: _b, html: _h, ...rest } = body ?? {};
        kept = JSON.stringify(rest).length < 4000 ? rest : {};
      }
      await pool.query("insert into service_calls (app, service, action, body, result, mock, trial) values ($1, $2, $3, $4, $5, $6, $7)", [a.slug, service, action, JSON.stringify(kept), JSON.stringify(result), service !== "email", trial]);
      return c.json(result);
    } catch (e) {
      if (e instanceof ServiceError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  });

  // Grove's front door on Cloudflare (edge/worker.js) asks where the app for an address lives.
  app.get("/edge/where", async (c) => {
    const given = Buffer.from(c.req.header("x-edge-secret") ?? ""), want = Buffer.from(process.env.EDGE_SECRET ?? "");
    if (want.length < 16 || given.length !== want.length || !timingSafeEqual(given, want)) return c.json({ error: "Not allowed." }, 401);
    const host = (c.req.query("host") ?? "").toLowerCase();
    if (!DOMAIN || !host.endsWith(`.${DOMAIN}`)) return c.json({ error: "No app here." }, 404);
    await init();
    const { rows: [a] } = await pool.query("select origin from apps where slug = $1 and origin is not null", [host.slice(0, -DOMAIN.length - 1)]);
    return a ? c.json({ origin: a.origin }) : c.json({ error: "No app here." }, 404);
  });

  // Neon calls this once a minute (see neon.ts). It wakes the apps that have a background job due.
  app.post("/cron/tick", async (c) => {
    const parsed = await parseTriggerDelivery(c.req.raw);
    if (!parsed.ok) return c.text(parsed.error, parsed.error === "invalid_body" ? 400 : 401);
    await init();
    const woken = await wakeDue(pool, appSecret);
    if (await due(pool, "prune")) waitUntil(prune(pool).then((r) => console.log("pruned", JSON.stringify(r)), (e) => console.error("prune failed:", e)));
    return c.json({ woken: woken.length, failed: woken.filter((w) => !w.ok).length });
  });

  // A file an app asked Grove to keep. Public ones open for anyone; private ones need a link that hasn't run out.
  // Served so a browser never runs it as part of this site: images show, everything else downloads.
  app.get("/files/:id/:name", async (c) => {
    await init();
    const id = c.req.param("id");
    const { rows: [f] } = /^[0-9a-f-]{36}$/.test(id) ? await pool.query("select f.*, a.paused_at from files f join apps a on a.slug = f.app where f.id = $1", [id]) : { rows: [] };
    if (!f || f.paused_at) return c.notFound();
    if (!f.public && !linkGood(f.id, c.req.query("until"), c.req.query("sig"), sign)) return c.text("This link has run out. Ask the app for a new one.", 403);
    const stored = await getObject(fileKey(f.app, f.id));
    if (!stored) return c.notFound();
    return new Response(stored.body, {
      headers: {
        "content-type": f.type,
        "content-length": String(f.bytes),
        "content-disposition": `${f.type.startsWith("image/") ? "inline" : "attachment"}; filename="${f.name}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": f.public ? "public, max-age=3600" : "private, no-store",
      },
    });
  });

  // Where a pretend payment sends people. It never asks for card details.
  const pretendPayment = async (id: string) =>
    (await pool.query("select p.*, a.title as app_title from pretend_payments p join apps a on a.slug = p.app where p.id = $1", [id])).rows[0];
  app.get("/pretend/pay/:id", async (c) => {
    await init();
    const p = await pretendPayment(c.req.param("id"));
    return p ? c.html(pretendPayPage(p)) : c.notFound();
  });
  app.post("/pretend/pay/:id", async (c) => {
    await init();
    await pool.query("update pretend_payments set paid_at = coalesce(paid_at, now()) where id = $1", [c.req.param("id")]);
    const p = await pretendPayment(c.req.param("id"));
    return p ? c.html(pretendPayPage(p)) : c.notFound();
  });

  app.post("/api/notify", async (c) => {
    const secret = (c.req.header("authorization") ?? "").replace(/^Bearer /i, "");
    if (!secret) return c.json({ error: "No app secret." }, 401);
    await init();
    const want = hash(secret);
    const { rows: [a] } = await pool.query("select slug, makers, secret_hash from apps where secret_hash = $1", [want]);
    if (!a || !timingSafeEqual(Buffer.from(a.secret_hash), Buffer.from(want))) return c.json({ error: "Unknown app." }, 401);
    const { subject, text, replyTo } = await c.req.json<{ subject: string; text: string; replyTo?: string }>();
    if (typeof subject !== "string" || typeof text !== "string") return c.json({ error: "subject and text are required." }, 400);
    if (!(await mayNotify(pool, a.slug))) return c.json({ error: "This app has sent all the emails it can today." }, 429);
    const sent = await email(a.makers, subject.slice(0, 200), text.slice(0, 20_000), replyTo);
    return c.json({ sent }, sent ? 200 : 502);
  });
}

export default app;
