// Grove: the MAPLE app that makes MAPLE apps. Ask it for an app and it creates the database, sign-in
// and address, keeps the app's code, and builds and deploys it itself; then it lets the app's makers
// change the code from the same chat, through previews, checks and one-step shipping.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import manifest from "../maple.json" with { type: "json" };
import { createMapleApp, z, type Ctx, type Manifest } from "../../kit/kit.ts";
import { BILLING_SCHEMA, billingOn, checkout, onEvent, planFor, portal, priceText, verified } from "./billing.ts";
import { BuildError, bundle, check, upload, zip, type Files } from "./build.ts";
import { connectionUri, createBranch, createProject, deleteBranch, deleteProject, registerDomain, setUpSignIn } from "./neon.ts";
import { sitePage, type PaidPlan } from "./site.ts";
import { TEMPLATE } from "./template-files.ts";

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
  email text primary key, idea text, created_at timestamptz not null default now());${BILLING_SCHEMA}`;

// The kit stays as MAPLE made it; features go everywhere else.
const PROTECTED = [/^src\/maple\//, /^package-lock\.json$/];
const MAX_FILE = 200_000, MAX_FILES = 200, MAX_TOTAL = 3_000_000;
const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const CHANGE = /^[a-z0-9][a-z0-9-]{0,38}$/;
// Names that would look like part of Grove itself on the apps domain.
const RESERVED = new Set(["www", "grove", "maple", "api", "app", "apps", "admin", "mail", "email", "help", "support", "status", "preview", "login", "signin", "sign-in", "account", "billing", "pay", "secure", "security"]);
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
(Settings, Connectors, Add custom connector, paste the connection address).`;

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

const { app, pool, init, email, site } = createMapleApp({ manifest: manifest as Manifest, slug: "grove", schema, guide, tools, routes, home: ({ mcpUrl }) => sitePage(mcpUrl, Number(process.env.APPS_PER_PERSON ?? 5), paidPlan()) });

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

/** Puts a built version on one of the app's database branches and makes sign-in work at its address. */
async function putUp(a: any, branch: string, archive: Record<string, string>, version: string, publicUrl?: string, first = false) {
  const env = { GROVE_URL: site, GROVE_APP_SECRET: appSecret(a.slug), MAPLE_COMMIT: String(version), ...(publicUrl && { PUBLIC_URL: publicUrl }) };
  const { address } = await upload({ key: process.env.NEON_API_KEY!, project: a.neon_project_id, branch }, archive, env);
  const url = publicUrl ?? address;
  if (first && publicUrl && publicUrl !== address) await registerDomain(a.neon_project_id, branch, new URL(publicUrl).host);
  await setUpSignIn(a.neon_project_id, branch, url);
  return url;
}

/** Whether the address is already answering with this version (Neon can take a minute or two to switch). */
const serving = (url: string, version: string | number) =>
  fetch(`${url}/maple/health`, { signal: AbortSignal.timeout(6000) }).then((r) => r.json()).then((h: any) => String(h.commit) === String(version), () => false);

/** Combines a change with what shipped since it started, file by file. */
function merge(base: Files, live: Files, mine: Files) {
  const files: Files = {}, clashes: string[] = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(live), ...Object.keys(mine)])) {
    const b = base[path], l = live[path], m = mine[path];
    const pick = m === b ? l : l === b || l === m ? m : (clashes.push(path), m);
    if (pick !== undefined) files[path] = pick;
  }
  return { files, clashes };
}

const diff = (from: Files, to: Files) =>
  [...new Set([...Object.keys(from), ...Object.keys(to)])].sort().flatMap((p) => (from[p] === to[p] ? [] : [`${!(p in from) ? "added" : !(p in to) ? "deleted" : "changed"} ${p}`]));

const SWITCH = "Neon can take a minute or two to switch to a new version";

function tools(server: McpServer, ctx: Ctx) {
  const { json, person } = ctx;

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
        const a = { slug: name, neon_project_id: where.project };
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
      return json({ app: slug, status: ok ? "live" : "starting", version: a.live, address: a.url, connect: a.url + "/mcp", openChanges: changes.rows, shipped: shipped.rows, ...(!ok && { note: `${SWITCH}; check again shortly.` }) });
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
      changeName(change);
      const { rows: [ch] } = await pool.query("select * from changes where app = $1 and name = $2", [slug, change]);
      const files = { ...(await filesOf(ch ? ch.version : a.live)) };
      for (const f of writes) {
        if (f.path.startsWith("/") || f.path.includes("..") || f.path.includes("\\")) throw new Error(`Bad path: ${f.path}`);
        if (PROTECTED.some((p) => p.test(f.path))) throw new Error(`${f.path} belongs to MAPLE and can't be changed here.`);
        if (f.content?.includes("\0")) throw new Error(`${f.path} isn't a text file.`);
        if (f.path === "maple.json" && f.content !== null) JSON.parse(f.content);
        if (f.content === null) delete files[f.path];
        else files[f.path] = f.content;
      }
      if (Object.keys(files).length > MAX_FILES || Object.values(files).reduce((n, c) => n + c.length, 0) > MAX_TOTAL) throw new Error("That makes the app too big for Grove. Remove some files.");
      const archive = await built(files);
      const version = await save(slug, files, message, person.email);
      const branch = ch?.branch_id ?? (await createBranch(a.neon_project_id, `preview-${change}`, a.branch_id));
      await pool.query(
        "insert into changes (app, name, version, base, branch_id) values ($1, $2, $3, $4, $5) on conflict (app, name) do update set version = $3, branch_id = $5, updated_at = now()",
        [slug, change, version, a.live, branch],
      );
      const url = await putUp(a, branch, archive, version);
      await pool.query("update changes set url = $3 where app = $1 and name = $2", [slug, change, url]);
      return json({ change, version, status: "saved", preview: url, previewConnect: url + "/mcp", next: `${SWITCH}; change_status says when the preview shows this version. Show the person the preview, and ship_change when they say so.` });
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
      for (const t of ["changes", "versions"]) await pool.query(`delete from ${t} where app = $1`, [slug]);
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
  app.post("/join", async (c) => {
    const body = await c.req.json<{ email?: unknown; idea?: unknown }>().catch(() => ({}) as { email?: unknown; idea?: unknown });
    const address = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (address.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return c.json({ message: "That doesn't look like an email address." }, 400);
    await init();
    const { rows: [{ n }] } = await pool.query("select count(*)::int n from waitlist where created_at > now() - interval '1 day'");
    if (n >= 200) return c.json({ message: "The list is full for today. Please try again tomorrow." }, 429);
    await pool.query("insert into waitlist (email, idea) values ($1, $2) on conflict (email) do nothing", [address, typeof body.idea === "string" ? body.idea.trim().slice(0, 1000) || null : null]);
    return c.json({ message: "Thanks. You're on the list, and we'll be in touch." });
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
    await onEvent(pool, JSON.parse(body));
    return c.json({ received: true });
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
    const sent = await email(a.makers, subject.slice(0, 200), text.slice(0, 20_000), replyTo);
    return c.json({ sent }, sent ? 200 : 502);
  });
}

export default app;
