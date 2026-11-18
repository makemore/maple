// The MAPLE kit: everything every MAPLE app needs, so an app only adds its own tables and tools.
// MCP first, Auth (email codes, OAuth for Claude), Postgres, the Loop (ask the maker), Email.
// Apps made by Grove get a copy of this folder at src/maple/. Change it here, not in an app.
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { attachDatabasePool } from "@neon/functions";
import { createMcpAuth } from "@neon/oauth/mcp";
import { honoMcpBearerAuth, honoProtectedResourceMetadata, type McpAuthVariables } from "@neon/oauth/mcp/hono";
import { Hono, type Context } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Pool } from "pg";
import { z } from "zod";
import { createServices, type Services } from "./services.ts";
import { TASKS_SCHEMA, TICK_PATH, createTasks, jobList, tick, type Jobs } from "./tasks.ts";
import { consentPage, groveBadge, homePage, signInPage, withBadge, ICON_SVG } from "./pages.ts";

export { z };
export type Role = "maker" | "user";

/** The parts of maple.json the kit reads. See maple.schema.json in the MAPLE repository. */
export interface Manifest {
  name: string;
  title?: string;
  description?: string;
  maker: { name: string; email: string };
  auth?: { allowed?: string[]; allowedDomains?: string[]; /** Anyone with a verified email can sign in, as a user. */ open?: boolean };
  mcp?: { audience?: "everyone" | "technical" };
  loop?: { to?: string; tool?: string; dailyLimit?: number };
  email?: { from?: string };
}

export interface Person { email: string; role: Role }

/** What an app's tools get: the database, who is asking, and a helper that formats results. */
export interface Ctx {
  pool: Pool;
  person: Person;
  isMaker: boolean;
  /** Wraps data as a tool result, with the plain-English reminder as a second item (SPEC 2). */
  json: (data: unknown) => { content: { type: "text"; text: string }[] };
  /** What Grove does for the app: email, and pretend payments, background work and more. See services.ts. */
  services: Services;
}
export type { Services };
/** What a job gets when it runs: the database and the services. There is no signed-in person. */
export interface JobCtx { pool: Pool; services: Services }
export type AppJobs = Jobs<JobCtx>;

export interface AppDef {
  manifest: Manifest;
  /** Function slug in neon.ts; part of the app's address. */
  slug: string;
  /** The app's own tables. Must be safe to run on every start (create table if not exists ...). */
  schema?: string;
  /** What this app is for and how to use its tools, for the assistant. Plain sentences. */
  guide?: string;
  /** Register the app's own MCP tools. */
  tools?: (server: McpServer, ctx: Ctx) => void;
  /** Extra web routes (behind sign-in if the path starts with /api/). */
  routes?: (app: Hono<Env>, pool: Pool, services: Services) => void;
  /** Background work: what to do when a job started with services.tasks comes due. Throwing means "try again later". */
  jobs?: AppJobs;
  /** The app's own front page, as HTML. With one, the signed-in page (connect steps, requests) moves to /account. */
  home?: (info: { title: string; site: string; mcpUrl: string }) => string;
}

type Env = McpAuthVariables & { Variables: { person?: Person } };

const KINDS = ["upgrade", "problem", "question"] as const;
const LABEL = { upgrade: "Change request", problem: "Problem", question: "Question" } as const;
const REQUEST_COLS = "id, created_at, sender, kind, message, status, reply, updated_at, emailed";

const KIT_SCHEMA = `
create table if not exists maple_people (
  email text primary key, role text not null check (role in ('maker','user')),
  added_by text, added_at timestamptz not null default now());
create table if not exists requests (
  id serial primary key, created_at timestamptz not null default now(), sender text not null,
  kind text not null check (kind in ('upgrade','problem','question')), message text not null, prompt text,
  emailed boolean not null default false, status text not null default 'open' check (status in ('open','done','declined')),
  reply text, updated_at timestamptz);`;

export function createMapleApp(def: AppDef) {
  const m = def.manifest;
  const title = m.title ?? m.name;
  const makerName = m.maker.name;
  const technical = m.mcp?.audience === "technical";
  const askTool = m.loop?.tool ?? "ask_maker";
  const site = process.env.PUBLIC_URL || `https://${process.env.NEON_BRANCH_ID}-${def.slug}${process.env.NEON_FUNCTION_HOST_SUFFIX}`;
  const mcpUrl = site + "/mcp";

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  attachDatabasePool(pool);

  // Tables are created on first use; the people named in maple.json are added once, then managed with tools.
  let ready: Promise<unknown> | undefined;
  const init = () =>
    (ready ??= (async () => {
      await pool.query(KIT_SCHEMA + TASKS_SCHEMA);
      if (def.schema?.trim()) await pool.query(def.schema);
      const seed: Person[] = [
        { email: m.maker.email, role: "maker" },
        ...(m.auth?.allowed ?? []).map((email) => ({ email, role: "user" as const })),
      ];
      for (const p of seed) {
        await pool.query("insert into maple_people (email, role, added_by) values (lower($1), $2, 'maple.json') on conflict do nothing", [p.email, p.role]);
      }
    })().catch((e) => {
      ready = undefined;
      throw e;
    }));

  // A valid sign-in alone proves nothing (anyone can make an account): the verified email must be
  // on the people list, or end in one of the allowed domains.
  // Where the email comes from depends on the host. On Neon, the sign-in service keeps people in this
  // app's own database. A host that shares one sign-in service between many apps hands over the email
  // it has already verified (auth.verifiedEmail), so no app ever reads the list of everyone.
  async function personFor(userId: string | undefined, verifiedEmail?: string): Promise<Person | null> {
    if (!userId) return null;
    await init();
    const email: string | undefined = verifiedEmail
      ? verifiedEmail.toLowerCase()
      : (await pool.query(`select lower(email) email from neon_auth."user" where id::text = $1 and "emailVerified"`, [userId])).rows[0]?.email;
    if (!email) return null;
    const { rows: [p] } = await pool.query("select email, role from maple_people where email = $1", [email]);
    if (p) return p;
    if (m.auth?.open) return { email, role: "user" };
    const domain = email.split("@")[1];
    return (m.auth?.allowedDomains ?? []).some((d) => d.toLowerCase() === domain) ? { email, role: "user" } : null;
  }

  const style = (p: Person) =>
    p.role === "maker"
      ? `How to answer: this is ${makerName}, who makes ${title}; technical detail is fine.`
      : technical
        ? "How to answer: short and clear. Technical detail is fine."
        : `How to answer: short and in plain English. No tool or field names, nothing technical; anything technical goes to ${makerName} with ${askTool}.`;

  const instructions = (p: Person) =>
    [
      `${title} is an app the signed-in person uses through you. ${def.guide ?? ""}`.trim(),
      p.role === "maker"
        ? `You are talking to ${makerName}, its maker. Technical detail is fine. Close requests from users with update_request once done.`
        : technical
          ? `The people using it are comfortable with technical detail. Changes, problems and questions about the app go to ${makerName} with ${askTool}.`
          : `The people using it know nothing about AI agents, MCP or software. Use plain English, keep it short, never mention tool names, field names or anything technical. ${makerName} looks after the app: for any change, problem or technical question, offer to send it to ${makerName} with ${askTool}, and write an agent_prompt ${makerName} can hand to a coding agent.`,
    ].join("\n\n");

  // Loop email: through Grove when the app was made by Grove, else straight to Postmark.
  async function email(to: string[], subject: string, text: string, replyTo?: string) {
    const grove = process.env.GROVE_URL, secret = process.env.GROVE_APP_SECRET;
    const send = grove && secret
      ? fetch(grove + "/api/notify", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ subject, text, replyTo }) })
      : process.env.POSTMARK_TOKEN && m.email?.from
        ? fetch("https://api.postmarkapp.com/email", {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": process.env.POSTMARK_TOKEN },
            body: JSON.stringify({ From: m.email.from, To: to.join(","), ...(replyTo && { ReplyTo: replyTo }), Subject: subject, TextBody: text, MessageStream: "outbound" }),
          })
        : undefined;
    if (!send) return false;
    const res = await send.catch((e: Error) => e);
    if (res instanceof Error || !res.ok) {
      console.error("email failed:", res instanceof Error ? res.message : `${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  }

  const grove = process.env.GROVE_URL, appSecret = process.env.GROVE_APP_SECRET, trial = process.env.GROVE_TRIAL === "1";
  const services: Services = createServices({
    grove,
    secret: appSecret,
    trial,
    emailDirect: process.env.POSTMARK_TOKEN && m.email?.from ? email : undefined,
    tasks: createTasks({
      pool,
      init: () => init(),
      names: () => Object.keys(def.jobs ?? {}),
      trial,
      // Grove calls /maple/tick when a job is due, so it needs to know when that is.
      wake: grove && appSecret && !trial ? (at) => fetch(`${grove}/services/tasks/wake`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${appSecret}` }, body: JSON.stringify({ at: at.toISOString() }), signal: AbortSignal.timeout(5000) }) : undefined,
    }),
  });
  const runJobs = async () => (await init(), tick(pool, def.jobs ?? {}, { pool, services }));

  async function ask(sender: string, kind: (typeof KINDS)[number], message: string, prompt?: string) {
    await init();
    const limit = m.loop?.dailyLimit ?? 20;
    const { rows: [{ n }] } = await pool.query("select count(*)::int n from requests where created_at > now() - interval '1 day'");
    if (n >= limit) throw new Error(`${limit} requests already today, which looks like a loop, so this one was not sent. Try again tomorrow.`);
    const { rows: [row] } = await pool.query(`insert into requests (sender, kind, message, prompt) values ($1, $2, $3, $4) returning ${REQUEST_COLS}`, [sender, kind, message, prompt ?? null]);
    const makers = m.loop?.to ? [m.loop.to] : (await pool.query("select email from maple_people where role = 'maker'")).rows.map((r) => r.email);
    const agentPrompt = prompt && `${title} request #${row.id} from ${sender}, ${row.created_at.toISOString().slice(0, 10)}:\n\n${prompt}\n\nWhen it is done, close it with update_request (id ${row.id}) and a short reply ${sender} will read.`;
    const text = [
      `#${row.id} ${LABEL[kind]} from ${sender}`, "", "In their words:", message,
      ...(agentPrompt ? ["", "Prompt for your coding agent:", "-----", agentPrompt, "-----"] : []),
      "", `See all requests: ${site}`,
    ].join("\n");
    const sent = await email(makers, `${title} #${row.id} ${LABEL[kind].toLowerCase()}: ${message.split("\n")[0].slice(0, 70)}`, text, sender.includes("@") ? sender : undefined);
    if (sent) await pool.query("update requests set emailed = true where id = $1", [row.id]);
    return { ...row, emailed: sent };
  }

  const listRequests = async (status?: string) =>
    (await pool.query(`select ${REQUEST_COLS} from requests where $1::text is null or status = $1 order by id desc limit 50`, [status ?? null])).rows;

  function createServer(person: Person) {
    const isMaker = person.role === "maker";
    const reminder = style(person);
    const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }, { type: "text" as const, text: reminder }] });
    const server = new McpServer(
      { name: m.name, title, version: "0.1.0", icons: [{ src: site + "/icon.svg", mimeType: "image/svg+xml" }] },
      { instructions: instructions(person) },
    );
    const makerOnly = () => {
      if (!isMaker) throw new Error(`Only ${makerName} can do this.`);
    };

    server.registerTool(
      askTool,
      {
        title: `Ask ${makerName}`,
        description: `Sends a message to ${makerName}, who makes ${title}: a change or new feature (upgrade), something not working (problem), or a question (question). Use it for anything technical or anything the app can't do yet. Write message in the person's own words. For upgrades and problems also write agent_prompt: a clear, self-contained brief ${makerName} can hand to a coding agent. Confirm with the person before sending.`,
        inputSchema: {
          kind: z.enum(KINDS),
          message: z.string().min(1).max(4000),
          agent_prompt: z.string().max(8000).optional(),
        },
      },
      async ({ kind, message, agent_prompt }) => {
        const row = await ask(person.email, kind, message, agent_prompt);
        return json({ ...row, note: row.emailed ? `Sent to ${makerName} as request #${row.id}.` : `Saved as request #${row.id}; the email did not go out, but ${makerName} will see it in the list.` });
      },
    );

    server.registerTool(
      "list_requests",
      {
        title: `Requests to ${makerName}`,
        annotations: { readOnlyHint: true },
        description: `Messages sent to ${makerName}, newest first (up to 50), with status (open, done, declined) and ${makerName}'s reply.`,
        inputSchema: { status: z.enum(["open", "done", "declined"]).optional() },
      },
      async ({ status }) => json(await (init(), listRequests(status))),
    );

    server.registerTool(
      "update_request",
      {
        title: "Close or update a request",
        description: `For ${makerName}: mark a request done or declined (or reopen it) with a short reply the person who asked will read. Write the reply for them.`,
        inputSchema: { id: z.number().int(), status: z.enum(["open", "done", "declined"]), reply: z.string().max(4000).optional() },
      },
      async ({ id, status, reply }) => {
        makerOnly();
        await init();
        const { rows } = await pool.query(`update requests set status = $2, reply = coalesce($3, reply), updated_at = now() where id = $1 returning ${REQUEST_COLS}`, [id, status, reply ?? null]);
        if (!rows.length) throw new Error(`No request #${id}`);
        return json(rows[0]);
      },
    );

    server.registerTool(
      "list_people",
      {
        title: "Who can use this app",
        annotations: { readOnlyHint: true },
        description: `People who can sign in to ${title}, and whether each is a maker. Anyone with an email ending in an allowed domain can also sign in.`,
        inputSchema: {},
      },
      async () => {
        await init();
        // An app anyone can sign in to doesn't show its people to each other.
        if (m.auth?.open && person.role !== "maker") return json({ people: [{ email: person.email, role: person.role }], open: true });
        const { rows } = await pool.query("select email, role, added_at from maple_people order by role, email");
        return json({ people: rows, allowedDomains: m.auth?.allowedDomains ?? [], ...(m.auth?.open && { open: true }) });
      },
    );

    server.registerTool(
      "add_person",
      {
        title: "Let someone in",
        description: `For makers: lets someone sign in to ${title} with their email. role=maker also lets them close requests and manage people. Confirm first.`,
        inputSchema: { email: z.string().email(), role: z.enum(["user", "maker"]).default("user") },
      },
      async ({ email, role }) => {
        makerOnly();
        await init();
        await pool.query("insert into maple_people (email, role, added_by) values (lower($1), $2, $3) on conflict (email) do update set role = $2", [email, role, person.email]);
        return json({ added: email.toLowerCase(), role, signIn: site });
      },
    );

    server.registerTool(
      "remove_person",
      {
        title: "Take someone off",
        description: `For makers: stops someone signing in to ${title}. The last maker can't be removed. Confirm first.`,
        inputSchema: { email: z.string().email() },
      },
      async ({ email }) => {
        makerOnly();
        await init();
        const { rows: [{ n }] } = await pool.query("select count(*)::int n from maple_people where role = 'maker' and email <> lower($1)", [email]);
        if (!n) throw new Error("That is the last maker; add another maker first.");
        const { rowCount } = await pool.query("delete from maple_people where email = lower($1)", [email]);
        return json({ removed: rowCount ? email.toLowerCase() : null });
      },
    );

    if (isMaker && def.jobs && Object.keys(def.jobs).length)
      server.registerTool(
        "jobs",
        {
          title: "Background jobs",
          description: `For ${makerName}: the background jobs waiting to run in ${title}, when each is due, and any that failed and why. With runNow, also runs whatever is due straight away (on a trial copy this is the only way jobs run).`,
          inputSchema: { runNow: z.boolean().optional() },
        },
        async ({ runNow }) => {
          await init();
          const done = runNow ? await runJobs() : undefined;
          return json({ ...(done && { ranNow: done }), waiting: await jobList(pool), kinds: Object.keys(def.jobs ?? {}) });
        },
      );

    def.tools?.(server, { pool, person, isMaker, json, services });
    return server;
  }

  const mcpAuth = createMcpAuth({ baseUrl: process.env.NEON_AUTH_BASE_URL!, resource: mcpUrl });
  const oauth = honoMcpBearerAuth(mcpAuth);
  const app = new Hono<Env>();
  const page = { "Content-Security-Policy": "frame-ancestors 'none'", "Cache-Control": "no-store" };

  // One address per site: www.example.com goes to example.com, so sign-in (kept per address) carries over.
  app.use("*", async (c, next) => {
    const host = c.req.header("x-forwarded-host");
    if (host?.startsWith("www.")) {
      const url = new URL(c.req.url);
      return c.redirect(`https://${host.slice(4)}${url.pathname}${url.search}`, 301);
    }
    await next();
  });

  // Free apps hosted by Grove say so at the foot of every page. Grove sets GROVE_BADGE to the app's name when it deploys them.
  if (process.env.GROVE_BADGE && process.env.GROVE_URL) {
    const badge = groveBadge(process.env.GROVE_URL, process.env.GROVE_BADGE);
    app.use("*", async (c, next) => {
      await next();
      if (!c.res.headers.get("content-type")?.startsWith("text/html") || !c.res.body) return;
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      c.res = new Response(withBadge(await c.res.text(), badge), { status: c.res.status, headers });
    });
  }

  const authUrl = process.env.NEON_AUTH_BASE_URL ?? "";
  const signedInPage = (c: Context) => c.html(homePage(title, authUrl, mcpUrl), 200, page);
  if (def.home) {
    const home = def.home;
    app.get("/", (c) => c.html(home({ title, site, mcpUrl }), 200, { "Content-Security-Policy": "frame-ancestors 'none'" }));
    app.get("/account", signedInPage);
  } else {
    app.get("/", signedInPage);
  }
  app.get("/auth/sign-in", (c) => c.html(signInPage(title, authUrl), 200, page));
  app.get("/auth/consent", (c) => c.html(consentPage(title, authUrl), 200, page));
  app.get("/icon.svg", () => new Response(ICON_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } }));
  // Which commit is live: deploys check this to know the new version is serving.
  // Runs the background jobs that are due. Called by Grove, or by any scheduler given MAPLE_TICK_SECRET. See tasks.ts.
  app.post(TICK_PATH, async (c) => {
    const given = Buffer.from((c.req.header("authorization") ?? "").replace(/^Bearer /i, ""));
    const ok = [process.env.GROVE_APP_SECRET, process.env.MAPLE_TICK_SECRET].some((s) => s && s.length >= 16 && given.length === s.length && timingSafeEqual(given, Buffer.from(s)));
    if (!ok) return c.json({ error: "Not allowed." }, 401);
    return c.json(await runJobs());
  });
  app.get("/maple/health", (c) => c.json({ ok: true, commit: process.env.MAPLE_COMMIT ?? null }));

  honoProtectedResourceMetadata(app as unknown as Hono, mcpAuth);

  // For tests only: MAPLE_TEST_TOKEN acts as the maker. Unset in normal use.
  const testToken = process.env.MAPLE_TEST_TOKEN;
  const isTestToken = (c: Context) => {
    if (!testToken) return false;
    const want = Buffer.from(`Bearer ${testToken}`), got = Buffer.from(c.req.header("authorization") ?? "");
    return got.length === want.length && timingSafeEqual(got, want);
  };

  app.use("/mcp", async (c, next) => {
    if (isTestToken(c)) {
      c.set("person", { email: m.maker.email.toLowerCase(), role: "maker" });
      return next();
    }
    return oauth(c, async () => {
      const auth = c.get("auth") as { sub?: string; verifiedEmail?: string };
      const person = await personFor(auth.sub, auth.verifiedEmail);
      if (!person) {
        c.res = c.text(`This account is not allowed to use ${title}. Ask ${makerName} to add you.`, 403);
        return;
      }
      c.set("person", person);
      await next();
    });
  });

  // Dashboard calls: the browser sends the signed-in person's Neon Auth token.
  const jwks = process.env.NEON_AUTH_JWKS_URL ? createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL)) : undefined;
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/notify") return next(); // Grove's own endpoint checks its own secret
    if (isTestToken(c)) {
      c.set("person", { email: m.maker.email.toLowerCase(), role: "maker" });
      return next();
    }
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer /i, "");
    const sub = jwks && (await jwtVerify(token, jwks, { issuer: [authUrl, new URL(authUrl).origin] }).then((r) => r.payload.sub, () => undefined));
    if (!sub) return c.json({ error: "Please sign in again." }, 401);
    const person = await personFor(sub);
    if (!person) return c.json({ error: `This account is not allowed to use ${title}. Ask ${makerName} to add you.` }, 403);
    c.set("person", person);
    await next();
  });

  app.get("/api/home", async (c) => {
    await init();
    const person = c.get("person")!;
    return c.json({ title, person, maker: makerName, requests: await listRequests() });
  });

  // The app's own pages and routes can use its tables straight away: make sure they exist first.
  app.use("*", async (_c, next) => {
    await init();
    await next();
  });
  def.routes?.(app, pool, services);

  app.on(["GET", "DELETE"], "/mcp", (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405, { Allow: "POST" }));
  app.post("/mcp", async (c) => {
    const server = createServer(c.get("person")!);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return { app, pool, init, site, mcpUrl, email, services };
}
