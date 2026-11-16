// Grove: the MAPLE app that makes MAPLE apps. Ask it for an app and it creates the git repository,
// the database, sign-in and the deploy pipeline; then it lets the app's makers change the app's
// code from the same chat, through previews, checks and one-step shipping.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import manifest from "../maple.json" with { type: "json" };
import { createMapleApp, z, type Ctx, type Manifest } from "../../kit/kit.ts";
import { commitFiles, deployStatus, failureLog, gh, GitHubError, ORG, readFile, setSecret, setVariable } from "./github.ts";
import { createProject, projectKey } from "./neon.ts";
import { TEMPLATE } from "./template-files.ts";

const schema = `
create table if not exists apps (
  slug text primary key, title text not null, description text not null, makers text[] not null,
  users text[] not null default '{}', neon_project_id text, url text, secret_hash text not null,
  status text not null default 'creating', error text, created_at timestamptz not null default now());`;

// The kit, the pipeline and the dependencies stay as MAPLE made them; features go everywhere else.
const PROTECTED = [/^src\/maple\//, /^\.github\//, /^package-lock\.json$/];
const MAX_FILE = 200_000;
const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const CHANGE = /^[a-z0-9][a-z0-9-]{0,38}$/;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

const guide = `Grove makes small apps that people use through their AI assistant: each app has its own database,
email-code sign-in, a Claude connector and a way for its users to ask its maker for changes. Use
create_app when someone wants a new app, then build the features they described with the code tools:
read AGENTS.md and src/app.ts of the app first, make the change on a change branch with write_files,
check it with change_status (fix and write again if it fails), show the preview, and ship_change only
when the person says so. After create_app, tell the person how to add the app to Claude
(Settings, Connectors, Add custom connector, paste the connection address) once app_status says it is live.`;

const { app, pool, init, email, site } = createMapleApp({ manifest: manifest as Manifest, slug: "grove", schema, guide, tools, routes });

async function appFor(ctx: Ctx, slug: string) {
  await init();
  const { rows: [a] } = await pool.query("select * from apps where slug = $1", [slug]);
  if (!a || (!ctx.isMaker && !a.makers.includes(ctx.person.email))) throw new Error(`No app called ${slug} that you make. list_apps shows yours.`);
  return a;
}

const branchOf = (change: string) => {
  if (!CHANGE.test(change)) throw new Error("change must be short, lowercase letters, digits and dashes, e.g. add-fee-reminders");
  return `change/${change}`;
};

function tools(server: McpServer, ctx: Ctx) {
  const { json, person } = ctx;

  server.registerTool(
    "create_app",
    {
      title: "Create an app",
      description:
        "Creates a new app: its private git repository (from the MAPLE template), its own Postgres database, email-code sign-in, a Claude connector and automatic deploys. The person asking becomes its maker. users are the emails of the people it is for, who can sign in (more can be added later from inside the app). Takes a few seconds; the first deploy then takes 2-3 minutes: check app_status. Then build the described features with write_files. Confirm the name and who it is for first.",
      inputSchema: {
        name: z.string().regex(SLUG).describe("Short lowercase name for the address and repository, e.g. river-rowing-fees"),
        title: z.string().min(2).max(60).describe("Name people see, e.g. 'Club Helper'"),
        description: z.string().min(10).max(1000).describe("What it is for and what it should do, in a sentence or three"),
        users: z.array(z.string().email()).max(50).default([]),
        audience: z.enum(["everyone", "technical"]).default("everyone").describe("everyone: users know nothing about software (the default)"),
      },
    },
    async ({ name, title, description, users, audience }) => {
      await init();
      const { rows: [{ n }] } = await pool.query("select count(*)::int n from apps where $1 = any(makers)", [person.email]);
      if (!ctx.isMaker && n >= Number(process.env.APPS_PER_PERSON ?? 5)) throw new Error("You have reached your app limit. Ask the Grove maker for more.");
      const secret = randomBytes(32).toString("hex");
      const taken = await pool.query("insert into apps (slug, title, description, makers, users, secret_hash) values ($1, $2, $3, $4, $5, $6) on conflict do nothing", [name, title, description, [person.email], users.map((u) => u.toLowerCase()), hash(secret)]);
      if (!taken.rowCount) throw new Error(`There is already an app called ${name}. Pick another name.`);
      const fail = async (e: unknown) => {
        await pool.query("update apps set status = 'failed', error = $2 where slug = $1", [name, e instanceof Error ? e.message : String(e)]);
        throw e;
      };
      try {
        const projectId = await createProject(name);
        await pool.query("update apps set neon_project_id = $2 where slug = $1", [name, projectId]);
        const key = await projectKey(projectId, `deploy-${name}`);
        await gh("POST", `/orgs/${ORG}/repos`, { name, private: true, auto_init: true, description: `${title}: ${description}`.slice(0, 350) });
        await Promise.all([
          setSecret(name, "NEON_API_KEY", key),
          setSecret(name, "GROVE_APP_SECRET", secret),
          setVariable(name, "NEON_PROJECT_ID", projectId),
          setVariable(name, "GROVE_URL", site),
        ]);
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
        const files = Object.entries(TEMPLATE).map(([path, content]) => ({ path, content: path === "maple.json" ? JSON.stringify(appManifest, null, 2) + "\n" : content }));
        files.push({ path: "README.md", content: `# ${title}\n\n${description}\n\nA [MAPLE](https://github.com/makemore/maple) app made with Grove. See AGENTS.md to build on it.\n` });
        await commitFiles(name, "main", files, `Start ${title} from the MAPLE template`);
        await pool.query("update apps set status = 'deploying' where slug = $1", [name]);
      } catch (e) {
        await fail(e);
      }
      return json({ app: name, status: "deploying", next: "The first deploy takes 2-3 minutes; check app_status. Meanwhile, read AGENTS.md and src/app.ts and start building the features on a change branch." });
    },
  );

  server.registerTool(
    "list_apps",
    { title: "Your apps", annotations: { readOnlyHint: true }, description: "Apps you make (all apps, for Grove's maker), newest first.", inputSchema: {} },
    async () => {
      await init();
      const { rows } = await pool.query("select slug, title, description, makers, users, url, status, error, created_at from apps where $1 or $2 = any(makers) order by created_at desc", [ctx.isMaker, person.email]);
      return json(rows);
    },
  );

  server.registerTool(
    "app_status",
    {
      title: "Is it live?",
      annotations: { readOnlyHint: true },
      description: "Whether an app's latest version is live, still deploying, or failed (with the end of the failing log), plus its address and the connection address to add in Claude.",
      inputSchema: { app: z.string() },
    },
    async ({ app: slug }) => {
      const a = await appFor(ctx, slug);
      if (a.status === "failed" && !a.url) return json({ app: slug, status: "failed", error: a.error });
      const d = await deployStatus(slug, "main");
      if (d.state === "success" && d.url) await pool.query("update apps set url = $2, status = 'live' where slug = $1", [slug, d.url]);
      const url = d.state === "success" ? d.url : a.url;
      return json({
        app: slug,
        status: d.state === "success" ? "live" : d.state === "failure" ? "failed" : "deploying",
        version: d.sha.slice(0, 7),
        ...(url && { address: url, connect: url + "/mcp" }),
        ...(d.state === "failure" && { failure: await failureLog(slug, "main") }),
      });
    },
  );

  server.registerTool(
    "list_files",
    {
      title: "List an app's files",
      annotations: { readOnlyHint: true },
      description: "Every file in an app's repository, on main or on a change branch, with sizes. Files under src/maple/ and .github/ are MAPLE's and can't be changed.",
      inputSchema: { app: z.string(), change: z.string().optional().describe("A change branch name; omit for main") },
    },
    async ({ app: slug, change }) => {
      await appFor(ctx, slug);
      const ref = change ? branchOf(change) : "main";
      const t = await gh("GET", `/repos/${ORG}/${slug}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      return json({ ref, files: t.tree.filter((x: any) => x.type === "blob").map((x: any) => ({ path: x.path, size: x.size })) });
    },
  );

  server.registerTool(
    "read_files",
    {
      title: "Read an app's files",
      annotations: { readOnlyHint: true },
      description: "Reads up to 20 files from an app's repository, on main or a change branch. Start with AGENTS.md and src/app.ts.",
      inputSchema: { app: z.string(), paths: z.array(z.string()).min(1).max(20), change: z.string().optional() },
    },
    async ({ app: slug, paths, change }) => {
      await appFor(ctx, slug);
      const ref = change ? branchOf(change) : "main";
      return json({ ref, files: await Promise.all(paths.map(async (path) => ({ path, content: await readFile(slug, path, ref) }))) });
    },
  );

  server.registerTool(
    "write_files",
    {
      title: "Change an app's code",
      description:
        "Writes whole files (content) or deletes them (content null) on a change branch of an app, as one commit; the branch is made from main the first time. Each push runs the checks and deploys a preview with its own copy of the database. Then call change_status. Never touches main: ship_change does that. Files under src/maple/, .github/ and package-lock.json are refused.",
      inputSchema: {
        app: z.string(),
        change: z.string().describe("Short name for this change, e.g. add-fee-reminders. Reuse it to fix or extend the same change."),
        message: z.string().min(3).max(500).describe("Commit message: what and why"),
        files: z.array(z.object({ path: z.string().min(1).max(200), content: z.string().max(MAX_FILE).nullable() })).min(1).max(30),
      },
    },
    async ({ app: slug, change, message, files }) => {
      await appFor(ctx, slug);
      for (const f of files) {
        if (f.path.startsWith("/") || f.path.includes("..")) throw new Error(`Bad path: ${f.path}`);
        if (PROTECTED.some((p) => p.test(f.path))) throw new Error(`${f.path} belongs to MAPLE and can't be changed here.`);
        if (f.path === "maple.json" && f.content !== null) JSON.parse(f.content);
      }
      const sha = await commitFiles(slug, branchOf(change), files, `${message}\n\nVia Grove by ${person.email}`);
      return json({ change, commit: sha.slice(0, 7), next: "Checks and the preview take 1-3 minutes; call change_status." });
    },
  );

  server.registerTool(
    "change_status",
    {
      title: "How is the change doing?",
      annotations: { readOnlyHint: true },
      description: "For a change branch: checking, failed (with the end of the failing log, to fix with write_files), or ready with a preview address. Also lists the files changed compared with main.",
      inputSchema: { app: z.string(), change: z.string() },
    },
    async ({ app: slug, change }) => {
      await appFor(ctx, slug);
      const branch = branchOf(change);
      const [d, cmp] = await Promise.all([deployStatus(slug, branch), gh("GET", `/repos/${ORG}/${slug}/compare/main...${encodeURIComponent(branch)}`)]);
      return json({
        change,
        status: d.state === "success" ? "ready" : d.state === "failure" ? "failed" : "checking",
        commit: d.sha.slice(0, 7),
        ...(d.state === "success" && { preview: d.url, previewConnect: d.url + "/mcp" }),
        ...(d.state === "failure" && { failure: await failureLog(slug, branch) }),
        filesChanged: cmp.files?.map((f: any) => `${f.status} ${f.filename} (+${f.additions} -${f.deletions})`),
        behindMain: cmp.behind_by,
      });
    },
  );

  server.registerTool(
    "ship_change",
    {
      title: "Ship a change",
      description: "Merges a change into main once its checks and preview passed; the live app updates in 2-3 minutes (check app_status). Only when the person has said to ship it.",
      inputSchema: { app: z.string(), change: z.string() },
    },
    async ({ app: slug, change }) => {
      await appFor(ctx, slug);
      const branch = branchOf(change);
      const d = await deployStatus(slug, branch);
      if (d.state !== "success") throw new Error(`The change isn't ready (${d.state}). Check change_status first.`);
      try {
        await gh("POST", `/repos/${ORG}/${slug}/merges`, { base: "main", head: branch, commit_message: `Ship ${change}\n\nVia Grove by ${person.email}` });
      } catch (e) {
        if (e instanceof GitHubError && e.status === 409) throw new Error("This change clashes with something shipped since. Read the files again from main, write them to a new change, and ship that.");
        throw e;
      }
      await gh("DELETE", `/repos/${ORG}/${slug}/git/refs/heads/${branch}`);
      return json({ shipped: change, next: "Live in 2-3 minutes; app_status shows when." });
    },
  );

  server.registerTool(
    "drop_change",
    {
      title: "Throw a change away",
      description: "Deletes a change branch and its preview without shipping it. Confirm first.",
      inputSchema: { app: z.string(), change: z.string() },
    },
    async ({ app: slug, change }) => {
      await appFor(ctx, slug);
      await gh("DELETE", `/repos/${ORG}/${slug}/git/refs/heads/${branchOf(change)}`);
      return json({ dropped: change });
    },
  );

  server.registerTool(
    "rollback",
    {
      title: "Undo the last ship",
      description: "Puts the app's code back to how it was before the last shipped change, as a new commit (nothing is lost; data is untouched). The live app updates in 2-3 minutes. Confirm first.",
      inputSchema: { app: z.string() },
    },
    async ({ app: slug }) => {
      await appFor(ctx, slug);
      const r = `/repos/${ORG}/${slug}`;
      const head = await gh("GET", `${r}/commits/main`);
      const parent = head.parents[0];
      if (!parent) throw new Error("Nothing to roll back to.");
      const before = await gh("GET", `${r}/git/commits/${parent.sha}`);
      const commit = await gh("POST", `${r}/git/commits`, { message: `Roll back "${head.commit.message.split("\n")[0]}"\n\nVia Grove by ${person.email}`, tree: before.tree.sha, parents: [head.sha] });
      await gh("PATCH", `${r}/git/refs/heads/main`, { sha: commit.sha });
      return json({ rolledBack: head.commit.message.split("\n")[0], next: "Live in 2-3 minutes; app_status shows when." });
    },
  );
}

// Apps send their loop emails here, so they never hold an email key. Each app proves itself with its own secret.
function routes(app: import("hono").Hono<any>) {
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
