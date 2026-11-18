// Grove's tools for moving things in: a website (crawled, or from an export file), proof that a site is
// the person's, uploads of export files, and spreadsheets turned into tables. Registered by index.ts.
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Pool } from "pg";
import { waitUntil } from "@neon/functions";
import { z, type Ctx } from "../../kit/kit.ts";
import type { Files } from "./build.ts";
import { MAX_TOTAL, tooBig } from "./code.ts";
import { crawl, fromExport, gather, hostOf, sensitiveHost, siteFiles, survey, withoutOldSite, type Limits } from "./importer.ts";
import { dataFiles, importedIndex, TABLE, wire } from "./datafile.ts";
import { bareHost, checkOwner, ownerCode, ownerHelp, owns } from "./owner.ts";
import { FetchRefused, get as fetchPublic } from "./fetcher.ts";
import { getObject } from "./storage.ts";
import { planFor } from "./billing.ts";
import { underBuildLimit } from "./guard.ts";
import { filesOn, keepFile } from "./services.ts";

/** What these tools need from the rest of Grove. */
export type ImportDeps = {
  pool: Pool;
  ctx: Ctx;
  site: string;
  sign: (what: string) => string;
  appFor: (ctx: Ctx, slug: string) => Promise<any>;
  init: () => Promise<unknown>;
  mustAgree: () => Promise<void>;
  notPaused: (a: any) => void;
  changeName: (change: string) => string;
  filesOf: (version: number | string) => Promise<Files>;
  /** Checks and saves files as the newest version of a change, and puts up its preview. */
  preview: (a: any, change: string, ch: any, files: Files, message: string) => Promise<{ next: string } & Record<string, unknown>>;
  previewAs: RunDeps["previewAs"];
};

/** What a queued import needs to run with nobody in the chat: the same, less the person's session. */
export type RunDeps = Pick<ImportDeps, "pool" | "site" | "sign" | "changeName" | "filesOf"> & {
  previewAs: (who: { email: string; isMaker: boolean }, a: any, change: string, ch: any, files: Files, message: string) => Promise<{ next: string } & Record<string, unknown>>;
};

/** The files of a change (or the shipped code), and the change itself if it exists. */
async function startingPoint(d: Pick<RunDeps, "pool" | "changeName" | "filesOf">, a: any, change: string) {
  const { rows: [ch] } = await d.pool.query("select * from changes where app = $1 and name = $2", [a.slug, d.changeName(change)]);
  return { ch, files: await d.filesOf(ch ? ch.version : a.live) };
}

/** Puts src/imported/index.ts together and connects it to src/app.ts. */
function wired(files: Files) {
  const out: Files = { ...files, "src/imported/index.ts": importedIndex(files) };
  const w = wire(out["src/app.ts"] ?? "", { home: Boolean(files["src/imported/site.ts"]) && /"path":"\/"/.test(Object.entries(files).filter(([p]) => /^src\/imported\/pages-/.test(p)).map(([, c]) => c).join("")) });
  if (out["src/app.ts"]) out["src/app.ts"] = w.code;
  return { files: out, wiring: { done: w.done, leftToDo: w.todo } };
}

/** The upload a name means: "latest" is the newest for the app, worked out once so a restarted import reads the same file. */
async function uploadRow(pool: Pool, a: any, id: string) {
  const { rows: [u] } = await pool.query(id === "latest" ? "select * from uploads where app = $1 order by at desc limit 1" : "select * from uploads where app = $1 and id::text = $2", id === "latest" ? [a.slug] : [a.slug, id]);
  if (!u) throw new Error(`No upload ${id === "latest" ? "yet" : id} for ${a.slug}. upload_link gives a page to upload the file.`);
  return u;
}

/** Reads an upload made through upload_link. */
async function uploaded(pool: Pool, a: any, id: string) {
  const u = await uploadRow(pool, a, id);
  const res = await getObject(`imports/${a.slug}/${u.id}`);
  if (!res) throw new Error("That upload has gone (uploads are kept for a week). Upload it again.");
  return { id: u.id as string, name: u.name as string, text: await res.text() };
}

/** Whether one of the app's makers has shown they run a site (Grove's maker always counts). */
const ownerOf = (pool: Pool, who: { email: string; isMaker: boolean }, a: any, host: string) => (who.isMaker ? Promise.resolve({ email: who.email, how: "Grove's maker" }) : owns(pool, a.makers, host));

/**
 * Runs one queued import with nobody in the chat. It claims the job first, so two copies of Grove never
 * run the same one; a job cut short (Grove restarted part-way) is claimed again, once, by runImports.
 */
export async function runImport(d: RunDeps, id: number | string) {
  const { pool, site, sign } = d;
  const { rows: [job] } = await pool.query(
    "update site_imports set status = 'running', attempts = attempts + 1, updated_at = now() where id = $1 and (status = 'queued' or (status = 'running' and attempts < 2 and updated_at < now() - interval '10 minutes')) returning *",
    [id],
  );
  if (!job) return;
  const step = (p: object) => pool.query("update site_imports set progress = $2, updated_at = now() where id = $1", [job.id, JSON.stringify(p)]).then(() => undefined);
  const { url, upload, pages } = job.params as { url?: string; upload?: string; pages: number };
  const change = job.change as string;
  const who = { email: job.by_email as string, isMaker: Boolean(job.by_maker) };
  const work = async () => {
    const { rows: [a] } = await pool.query("select * from apps where slug = $1", [job.app]);
    if (!a) throw new Error("The app has gone.");
    if (a.paused_at) throw new Error("The app is paused.");
    const paid = (await planFor(pool, a.makers[0])).plan === "paid";
    const mine = url && (await ownerOf(pool, who, a, hostOf(url)));
    const exportFile = upload ? await uploaded(pool, a, upload) : undefined;
    const { ch, files: before } = await startingPoint(d, a, change);
    const base = withoutOldSite(before);
    const used = Object.values(base).reduce((n, c) => n + c.length, 0);
    const limits: Limits = { pages, images: paid ? 1500 : 400, imageBytes: paid ? 600_000_000 : 60_000_000, codeBudget: Math.max(0, Math.floor((MAX_TOTAL - used) * 0.85) - 100_000), seconds: 180 };
    if (limits.codeBudget < 50_000) throw new Error(`${a.slug} has no room left for imported pages. Remove some files, or import into a new app.`);
    const s = url ? await crawl(url, limits, { owner: Boolean(mine), progress: step }) : fromExport(exportFile!.text, limits);
    if (!url && sensitiveHost(s.source) && !(await ownerOf(pool, who, a, s.source))) throw new Error(`Grove doesn't copy ${s.source}.`);
    if (!s.pages.length) throw new Error("No pages could be copied from that site.");
    await step({ stage: "copying pictures and stylesheets", pages: s.pages.length });
    await gather(s, { ...limits, seconds: 150 }, async (name, type, bytes) => {
      if (!filesOn()) throw new Error("no file store");
      return (await keepFile(pool, a.slug, { name, type, base64: Buffer.from(bytes).toString("base64"), public: true }, randomUUID(), { site, paid, trial: false, sign })).url;
    }, step);
    // Pages are measured as HTML, but kept as code: drop the last pages until it all fits.
    let made = wired({ ...base, ...siteFiles(s) });
    const size = (f: Files) => Object.values(f).reduce((n, c) => n + c.length, 0);
    if (size(made.files) > MAX_TOTAL - 20_000 && s.posts.some((p) => p.content)) {
      for (const p of s.posts) delete p.content;
      made = wired({ ...base, ...siteFiles(s) });
    }
    while (size(made.files) > MAX_TOTAL - 20_000 && s.pages.length > 1) {
      const drop = s.pages.splice(-Math.max(1, Math.ceil(s.pages.length / 10)));
      s.skipped.push(...drop.map((p) => ({ url: p.path, why: "the app has no more room for pages" })));
      made = wired({ ...base, ...siteFiles(s) });
    }
    const { files, wiring } = made;
    await step({ stage: "checking the code and putting up a trial copy", pages: s.pages.length });
    const out = await d.previewAs(who, a, change, ch, files, `Import ${s.pages.length} pages from ${s.source}`);
    const owner = await ownerOf(pool, who, a, s.source);
    return {
      ...out,
      source: s.source, madeWith: s.platform, pages: s.pages.length, posts: s.posts.length, pictures: s.images,
      forms: s.forms.map((f) => ({ page: f.path, fields: f.forms.map((x) => x.fields.map((y) => y.label ?? y.name)) })),
      leftBehind: s.removed.map((r) => ({ scripts: "scripts and trackers", forms: "forms (rebuild them: see src/imported/forms.ts)", embeds: "embeds from sites other than the usual video and map ones", plugins: "plugins" })[r] ?? r),
      skipped: s.skipped.slice(0, 25), skippedCount: s.skipped.length, wiring,
      yours: owner ? `yes (${owner.how})` : "not shown yet",
      next: [
        "Show the person the preview. Pages are at their old paths; anything the kit uses (like /account) moved under /site.",
        s.forms.length ? "Rebuild the forms listed in src/imported/forms.ts as real features, one small change at a time." : "",
        s.posts.length ? "The posts are data in src/imported/posts-*.ts: offer to turn them into a table with a blog page the person can add to by asking." : "",
        wiring.leftToDo.length ? `Finish connecting it in src/app.ts: ${wiring.leftToDo.join("; ")}.` : "",
        owner ? "ship_change when the person says so." : "Before it can ship, the person shows the site is theirs with verify_site.",
      ].filter(Boolean),
    };
  };
  await work().then(
    (result) => pool.query("update site_imports set status = 'done', result = $2, updated_at = now() where id = $1", [job.id, JSON.stringify(result)]),
    (e) => (console.error(`import ${job.id} failed:`, e), pool.query("update site_imports set status = 'failed', error = $2, updated_at = now() where id = $1", [job.id, String((e as Error)?.message ?? e).slice(0, 4000)])),
  );
}

/** For Grove's one-minute timer: starts queued imports and picks up ones cut short. Gives up after two tries. */
export async function runImports(d: RunDeps) {
  await d.pool.query("update site_imports set status = 'failed', error = 'It stopped without finishing, twice. Try again, perhaps with fewer pages.', updated_at = now() where status = 'running' and attempts >= 2 and updated_at < now() - interval '10 minutes'");
  const { rows } = await d.pool.query("select id from site_imports where status = 'queued' or (status = 'running' and attempts < 2 and updated_at < now() - interval '10 minutes') order by id limit 3");
  await Promise.all(rows.map((r) => runImport(d, r.id)));
  return rows.length;
}

export function importTools(server: McpServer, d: ImportDeps) {
  const deps = d;
  const { pool, ctx, site, sign, appFor, init, mustAgree, notPaused, changeName, preview } = d;
  const { json, person } = ctx;
  const who = { email: person.email, isMaker: ctx.isMaker };
  const ownerOfSource = (a: any, host: string) => ownerOf(pool, who, a, host);

  server.registerTool(
    "survey_site",
    {
      title: "Look at a website before moving it",
      annotations: { readOnlyHint: true },
      description:
        "A quick look at a public website someone wants to move into Grove, without copying anything: what it was made with (WordPress, Wix, Squarespace...), its title, how many pages its sitemap lists, the forms on its front page (which would be rebuilt as app features), and whether the person has already shown the site is theirs. Use it to tell the person what an import will involve before import_site.",
      inputSchema: { url: z.string().url().describe("The site's address, e.g. https://riverrowing.club") },
    },
    async ({ url }) => {
      await init();
      const host = hostOf(url);
      const mine = await owns(pool, [person.email], host);
      const why = sensitiveHost(host);
      if (why && !mine && !ctx.isMaker) throw new Error(`Grove doesn't copy ${host}: it looks like ${why}. If it really is the person's own site, they can show that with verify_site first.`);
      try {
        const s = await survey(url);
        return json({ ...s, yours: mine ? `yes (${mine.how})` : "not shown yet: the copy can be made and previewed, but verify_site is needed before it can go live", ...(!mine && ownerHelp(host, ownerCode(person.email, host, sign))) });
      } catch (e) {
        if (e instanceof FetchRefused) throw new Error(e.message);
        throw new Error(`${url} couldn't be read: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "verify_site",
    {
      title: "Show a website is yours",
      description:
        "Checks that the person runs a website, so a copy of it can go live from Grove (an imported site can be previewed without this, but not shipped). Without a code on the site yet, it gives the person their code and the ways to put it there: a DNS TXT record, a tag in the front page's head, a grove-verify.txt file, or for WordPress an application password of an administrator or editor (checked once, never kept). Call it again once the code is in place.",
      inputSchema: {
        site: z.string().min(3).max(200).describe("The site's address or domain, e.g. riverrowing.club"),
        wordpressUser: z.string().max(200).optional().describe("WordPress only: the account name the application password belongs to"),
        wordpressAppPassword: z.string().max(200).optional().describe("WordPress only: an application password (Users, Profile, Application passwords)"),
      },
    },
    async ({ site: typed, wordpressUser, wordpressAppPassword }) => {
      await init();
      await mustAgree();
      const host = bareHost(typed.includes("://") ? new URL(typed).hostname : typed.split("/")[0]);
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new Error("Give the site's domain, e.g. riverrowing.club");
      const r = await checkOwner(pool, person.email, host, sign, wordpressUser && wordpressAppPassword ? { user: wordpressUser, appPassword: wordpressAppPassword } : undefined);
      if (r.verified) return json({ site: host, verified: true, how: r.how, next: "Imported copies of this site can now be shipped. The code can come off the site." });
      return json({ site: host, verified: false, tried: r.tried, ...ownerHelp(host, r.code) });
    },
  );

  server.registerTool(
    "upload_link",
    {
      title: "A page for uploading an export file",
      description:
        "A link (good for an hour) to a page where the person uploads a file too big to paste into the chat, for import_site (a WordPress or Squarespace export: WordPress's Tools, Export; Squarespace's Settings, Import & export) or import_data (a CSV export from Airtable, Google Sheets, Notion, a CRM or a form tool). Then pass upload: \"latest\" to that tool. Uploads are kept for a week.",
      inputSchema: { app: z.string() },
    },
    async ({ app: slug }) => {
      const a = await appFor(ctx, slug);
      await mustAgree();
      if (!filesOn()) throw new Error("Uploads aren't switched on in this Grove. Paste a CSV into import_data instead, or import the live site by its address.");
      const until = Date.now() + 3600_000;
      return json({ uploadHere: `${site}/import/upload/${a.slug}?until=${until}&sig=${sign(`upload:${a.slug}:${until}`)}`, linkWorksFor: "one hour", accepts: "WordPress or Squarespace export (.xml), CSV or TSV, up to 30 MB", next: 'Once the person says it is uploaded, call import_site or import_data with upload: "latest".' });
    },
  );

  server.registerTool(
    "import_site",
    {
      title: "Copy a website into an app",
      description:
        "Copies a website the person runs into one of their apps, as a change with a trial copy: every page at the same path, its stylesheets, and its pictures (copied into Grove's file store). Either crawl the live site by url, or read a WordPress or Squarespace export file uploaded through upload_link (upload: \"latest\"), which gives tidy pages and posts but not the theme. Scripts, trackers and plugins are left behind; forms become placeholders listed in src/imported/forms.ts, to rebuild as real app features (a table and a route). WordPress posts also come as data in src/imported/posts-*.ts. It runs in the background: import_status says when it's done (usually a minute or two). The copy can be previewed straight away, but only goes live once verify_site shows the site is the person's. Only for sites the person owns or runs with the owner's say-so: ask first. A fresh import replaces the pages of an earlier one in the same change.",
      inputSchema: {
        app: z.string(),
        url: z.string().url().optional().describe("The live site to copy, e.g. https://riverrowing.club"),
        upload: z.string().optional().describe('An export file uploaded with upload_link: "latest", or its id'),
        change: z.string().default("import-site"),
        pages: z.number().int().min(1).max(200).default(60).describe("The most pages to copy"),
      },
    },
    async ({ app: slug, url, upload, change, pages }) => {
      const a = await appFor(ctx, slug);
      await mustAgree();
      notPaused(a);
      if (!url === !upload) throw new Error("Give either url (the live site) or upload (an export file), not both.");
      const { rows: [busy] } = await pool.query("select id from site_imports where app = $1 and status in ('queued', 'running') and updated_at > now() - interval '15 minutes'", [a.slug]);
      if (busy) throw new Error(`An import into ${a.slug} is already running. import_status says how it's going.`);
      const exportFile = upload ? await uploadRow(pool, a, upload) : undefined;
      const host = url ? hostOf(url) : undefined;
      const mine = host && (await ownerOfSource(a, host));
      const why = host && sensitiveHost(host);
      if (why && !mine) throw new Error(`Grove doesn't copy ${host}: it looks like ${why}.`);
      const paid = (await planFor(pool, a.makers[0])).plan === "paid";
      if (!ctx.isMaker) await underBuildLimit(pool, person.email, paid);
      // Queued, then started straight away; Grove's timer picks it up again if it's cut short.
      const { rows: [job] } = await pool.query(
        "insert into site_imports (app, change, source, kind, by_email, by_maker, params, status) values ($1, $2, $3, $4, $5, $6, $7, 'queued') returning id",
        [a.slug, changeName(change), host ?? exportFile!.name, url ? "site" : "export", person.email, ctx.isMaker, JSON.stringify({ url, upload: exportFile?.id, pages })],
      );
      waitUntil(runImport(d, job.id));
      return json({ import: job.id, status: "running", change, next: "It runs in the background, usually for a minute or two, and starts again by itself if it's cut short. Call import_status for progress and the preview address. Meanwhile tell the person what's happening." });
    },
  );

  server.registerTool(
    "import_status",
    {
      title: "How is the import going?",
      annotations: { readOnlyHint: true },
      description: "The latest imports into an app: running (with progress), done (with the preview, what was copied, what was left behind, the forms to rebuild and what to do next) or failed (with why).",
      inputSchema: { app: z.string() },
    },
    async ({ app: slug }) => {
      const a = await appFor(ctx, slug);
      const { rows } = await pool.query("select id, change, source, kind, status, progress, result, error, started_at, updated_at from site_imports where app = $1 order by id desc limit 3", [a.slug]);
      if (!rows.length) return json({ app: slug, imports: [], note: "Nothing has been imported into this app." });
      return json({ app: slug, imports: rows.map((r) => (r.status === "running" || r.status === "queued" ? { id: r.id, status: r.status, progress: r.progress, started: r.started_at, note: "Still going. Check again in half a minute." } : r.status === "failed" ? { id: r.id, status: r.status, source: r.source, why: r.error } : { id: r.id, status: r.status, ...r.result })) });
    },
  );

  server.registerTool(
    "import_data",
    {
      title: "Bring a spreadsheet into an app",
      description:
        "Turns rows from a spreadsheet into a table in an app, as a change with a trial copy: an export from Airtable, Google Sheets, Notion, Excel (saved as CSV), a CRM, a booking or form tool. Give the CSV itself (for small files), a link to it (a Google Sheet shared as 'anyone with the link' works), or a file uploaded with upload_link (upload: \"latest\"). Column types are worked out from the values; the rows load once when the app starts and are the app's to change after. Then add tools and pages that use the table. Check the table name with the person first.",
      inputSchema: {
        app: z.string(),
        table: z.string().regex(TABLE).describe("Name of the new table, e.g. customers"),
        csv: z.string().max(400_000).optional(),
        url: z.string().url().optional(),
        upload: z.string().optional(),
        change: z.string().default("import-data"),
      },
    },
    async ({ app: slug, table, csv, url, upload, change }) => {
      const a = await appFor(ctx, slug);
      await mustAgree();
      notPaused(a);
      if ([csv, url, upload].filter(Boolean).length !== 1) throw new Error("Give one of csv, url or upload.");
      let text = csv;
      if (url) {
        const sheet = url.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
        const gid = url.match(/[#&?]gid=(\d+)/)?.[1];
        const r = await fetchPublic(sheet ? `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv${gid ? `&gid=${gid}` : ""}` : url, { maxBytes: 5_000_000 }).catch((e) => { throw new Error(e instanceof FetchRefused ? e.message : `${url} couldn't be fetched.`); });
        if (r.status !== 200) throw new Error(`${url} answered ${r.status}.${sheet ? " Share the sheet as 'anyone with the link can view'." : ""}`);
        if (r.type === "text/html") throw new Error("That link gives a web page, not a CSV file.");
        text = r.text();
      }
      if (upload) {
        const u = await uploaded(pool, a, upload);
        if (/\.xlsx?$/i.test(u.name)) throw new Error("That's an Excel file. Save it as CSV (File, Save as, CSV) and upload that.");
        text = u.text;
      }
      const { ch, files: before } = await startingPoint(deps, a, change);
      if (before[`src/imported/data-${table}-1.ts`]) throw new Error(`${table} was imported into this app already. Pick another table name, or remove src/imported/data-${table}-*.ts first.`);
      if (new RegExp(`create table if not exists ${table}\\b`).test(Object.values(before).join("\n"))) throw new Error(`The app already has a table called ${table}. Pick another name.`);
      const d = dataFiles(table, text!);
      const { files, wiring } = wired({ ...before, ...d.files });
      tooBig(files);
      const out = await preview(a, change, ch, files, `Import ${d.rows} rows into ${table}`);
      return json({ ...out, table, rows: d.rows, columns: d.columns, wiring, next: [`Check with the person that the columns look right (${d.columns.length} of them), then add tools and pages that use ${table}.`, ...(wiring.leftToDo.length ? [`Finish connecting it in src/app.ts: ${wiring.leftToDo.join("; ")}.`] : []), out.next] });
    },
  );
}
