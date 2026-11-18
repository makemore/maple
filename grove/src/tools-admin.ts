// Tools only Grove's maker can use: pausing and resuming apps, blocking people, reports, the waiting
// list and how Grove is doing. Registered by index.ts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Pool } from "pg";
import { z, type Ctx } from "../../kit/kit.ts";
import { stats } from "./stats.ts";

export type AdminDeps = {
  pool: Pool;
  ctx: Ctx;
  init: () => Promise<unknown>;
  appFor: (ctx: Ctx, slug: string) => Promise<any>;
  makerOnly: () => void;
  pause: (a: any, why: string) => Promise<void>;
  putUpAgain: (a: any) => Promise<void>;
};

export function adminTools(server: McpServer, d: AdminDeps) {
  const { pool, ctx, init, appFor, makerOnly, pause, putUpAgain } = d;
  const { json, person } = ctx;

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
    "stats",
    {
      title: "How Grove is doing",
      annotations: { readOnlyHint: true },
      description: "For Grove's maker: people and apps, the funnel (joined, made an app, shipped a change of their own, came back after a week), paying accounts, and what needs a look (open reports, ships stopped by the checks, failed imports). From Grove's own tables; nothing is tracked on anyone's pages.",
      inputSchema: { days: z.number().int().min(1).max(365).default(30) },
    },
    async ({ days }) => {
      makerOnly();
      await init();
      return json(await stats(pool, days));
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
}
