// Copying a website into an app, as files in the app's own code: each page cleaned and kept as data,
// its stylesheets kept alongside, its pictures copied into Grove's file store, and a small renderer
// that serves them at the same paths. The result is ordinary code the maker owns, like everything else.
import { createHash } from "node:crypto";
import { ASSET, ASSET_RE, pagePath, readPage, sameSite, cssUrls, type Assets, type Form, type Read } from "./html.ts";
import { blockedBy, disallowed, eachLimited, FetchRefused, get } from "./fetcher.ts";
import type { Files } from "./build.ts";

export type Page = { path: string; title: string; description: string; lang?: string; bodyClass?: string; image?: string; styles: string[]; body: string; part?: number };
export type Post = { title: string; slug: string; path: string; date: string; categories: string[]; excerpt: string; content?: string; status?: string };
export type Site = {
  source: string; platform?: string; title?: string; pages: Page[]; css: Record<string, string>; forms: { path: string; forms: Form[] }[];
  posts: Post[]; skipped: { url: string; why: string }[]; removed: string[]; images: { kept: number; leftAtSource: number; bytes: number };
  /** How much of the code budget the pages and inline styles take. */
  used?: number;
};

/** The biggest page kept. Bigger ones are split across files, since one file holds at most 200 KB. */
export const MAX_PAGE = 600_000;

/** Pages Grove keeps out of an import's way because the kit (or the import itself) uses them. */
export const KIT_PATHS = [/^\/account$/, /^\/auth(\/|$)/, /^\/mcp(\/|$)/, /^\/\.well-known(\/|$)/, /^\/maple(\/|$)/, /^\/api(\/|$)/, /^\/icon\.svg$/, /^\/imported-styles(\/|$)/, /^\/files(\/|$)/];
const kitOwned = (p: string) => KIT_PATHS.some((r) => r.test(p));

/** Big names people copy to trick others. Their sites aren't imported unless the person shows they run them. */
const BRANDS = /(^|\.)(paypal|apple|icloud|microsoft|microsoftonline|office|office365|live|outlook|google|gmail|youtube|facebook|instagram|whatsapp|meta|amazon|netflix|hmrc|royalmail|dhl|fedex|ups|usps|evri|binance|coinbase|metamask|kraken|barclays|hsbc|lloydsbank|lloyds|natwest|santander|revolut|monzo|starlingbank|nationwide|halifax|chase|wellsfargo|bankofamerica|citi|citibank|stripe|ebay|steam|steampowered|roblox|linkedin|x|twitter|tiktok|dropbox|docusign|adobe|wetransfer)\.[a-z.]+$/i;
export function sensitiveHost(host: string) {
  const h = host.toLowerCase();
  if (/(^|\.)(gov|mil|bank|police)(\.[a-z]{2})?$/.test(h) || /\.gov\.[a-z]{2}$/.test(h) || /\.nhs\.uk$/.test(h)) return "a government, police, health service or bank site";
  if (BRANDS.test(h)) return "a big company's site that people copy to trick others";
  if (/(^|[.-])(login|signin|sign-in|logon|webmail|secure|verify|wallet|bank|banking)([.-]|$)/.test(h)) return "an address that looks like a sign-in or banking page";
  return undefined;
}

export const hostOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, "");

export type Limits = { pages: number; images: number; imageBytes: number; codeBudget: number; seconds: number };

/** Keeps a list of the pictures and stylesheets a site uses, each with a placeholder in the pages. */
class Registry implements Assets {
  list: { url: string; kind: "image" | "style"; final?: string }[] = [];
  index = new Map<string, number>();
  add(url: string, kind: "image" | "style") {
    const clean = url.replace(/#.*$/, "");
    let n = this.index.get(clean);
    if (n === undefined) this.index.set(clean, (n = this.list.push({ url: clean, kind }) - 1));
    return ASSET(n);
  }
}

const isHtml = (type: string) => !type || type === "text/html" || type === "application/xhtml+xml";
const locs = (xml: string) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
const fileish = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp3|mp4|mov|css|js|xml|json|txt|ics)$/i;

export type Progress = (p: { stage: string; pages?: number; found?: number; images?: number }) => Promise<void> | void;

/** What a quick look at a site finds, without keeping anything: for telling the person what an import would involve. */
export async function survey(start: string) {
  const first = await get(start, { maxBytes: 4_000_000 });
  if (first.status >= 400) throw new FetchRefused(`${start} answered ${first.status}.`);
  const origin = new URL(first.url);
  const reg = new Registry(), css = new Map<string, string>();
  const read = readPage(first.text(), first.url, css, reg);
  const sitemap = await sitemapUrls(origin, "").catch(() => []);
  const wordpress = read.platform === "WordPress" ? await get(new URL("/wp-json/wp/v2/posts?per_page=1&_fields=id", origin).href, { maxBytes: 200_000 }).then((r) => (r.status === 200 ? "open: posts can be read as data" : "closed"), () => "no") : undefined;
  return { address: first.url, host: hostOf(first.url), platform: read.platform ?? "not recognised", title: read.title, description: read.description, pagesInSitemap: sitemap.length, linksOnFrontPage: read.links.length, formsOnFrontPage: read.forms, pictures: reg.list.filter((a) => a.kind === "image").length, stylesheets: reg.list.filter((a) => a.kind === "style").length + css.size, removedFromFrontPage: read.removed, ...(wordpress && { wordpressApi: wordpress }) };
}

async function sitemapUrls(origin: URL, robots: string) {
  const roots = new Set([...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]));
  for (const p of ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"]) roots.add(new URL(p, origin).href);
  const seen = new Set<string>(), pages: string[] = [];
  const queue = [...roots];
  while (queue.length && seen.size < 12) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    const r = await get(u, { maxBytes: 5_000_000, timeoutMs: 10_000 }).catch(() => undefined);
    if (!r || r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.text().slice(0, 2000))) continue;
    const text = r.text();
    if (/<sitemapindex/i.test(text)) queue.push(...locs(text));
    else pages.push(...locs(text));
  }
  return [...new Set(pages)];
}

/** Crawls a public site: the start page, its sitemap and the links between pages, within the limits. */
export async function crawl(start: string, limits: Limits, o: { owner: boolean; progress?: Progress } = { owner: false }): Promise<Site & { reg: Registry }> {
  const deadline = Date.now() + limits.seconds * 1000;
  const first = await get(start, { maxBytes: 4_000_000 });
  if (first.status >= 400) throw new FetchRefused(`${start} answered ${first.status}, so there's nothing to copy.`);
  if (!isHtml(first.type)) throw new FetchRefused(`${start} isn't a web page (it's ${first.type}).`);
  const origin = new URL(first.url);
  const robotsText = await get(new URL("/robots.txt", origin).href, { maxBytes: 500_000, timeoutMs: 8000 }).then((r) => (r.status === 200 ? r.text() : ""), () => "");
  const rules = o.owner ? [] : disallowed(robotsText);
  const reg = new Registry(), inline = new Map<string, string>();
  const site: Site = { source: hostOf(first.url), pages: [], css: {}, forms: [], posts: [], skipped: [], removed: [], images: { kept: 0, leftAtSource: 0, bytes: 0 } };
  const done = new Set<string>(), queued = new Set<string>();
  const queue: string[] = [];
  const want = (u: URL) => {
    if (!sameSite(u, origin.hostname) || fileish.test(u.pathname) || /\/(wp-admin|wp-login|cart|checkout|my-account|feed)(\/|$)|\/wp-json\//.test(u.pathname)) return;
    const key = pagePath(u);
    if (queued.has(key)) return;
    if (blockedBy(rules, u.pathname)) return void site.skipped.push({ url: u.href, why: "the site's robots.txt asks robots to stay out" });
    queued.add(key);
    queue.push(new URL(key, origin).href);
  };
  const removed = new Set<string>();
  let bytes = 0, tries = 1;
  const cssBytes = () => [...inline.values()].reduce((n, c) => n + c.length, 0);
  const take = (r: Read, url: string) => {
    const path = pagePath(new URL(url));
    if (done.has(path)) return;
    done.add(path);
    r.removed.forEach((x) => removed.add(x));
    site.platform ??= r.platform;
    if (r.body.length > MAX_PAGE) return void site.skipped.push({ url, why: `the page is too big to keep (${Math.round(r.body.length / 1000)} KB of HTML)` });
    if (bytes + r.body.length + cssBytes() > limits.codeBudget) return void site.skipped.push({ url, why: "the app has no more room for pages" });
    bytes += r.body.length + 500;
    site.pages.push({ path, title: r.title, description: r.description, lang: r.lang, bodyClass: r.bodyClass, image: r.image, styles: r.styles, body: r.body });
    if (r.forms.length) site.forms.push({ path, forms: r.forms });
    for (const l of r.links) want(new URL(l, origin));
  };
  queued.add(pagePath(origin));
  take(readPage(first.text(), first.url, inline, reg), first.url);
  site.title = site.pages[0]?.title;
  await o.progress?.({ stage: "reading the sitemap", pages: 1 });
  for (const u of await sitemapUrls(origin, robotsText).catch(() => [])) {
    try {
      want(new URL(u));
    } catch {}
  }
  // Breadth first, a few at a time, until the limits.
  while (queue.length && site.pages.length < limits.pages && tries < limits.pages * 2 + 10 && Date.now() < deadline) {
    const batch = queue.splice(0, Math.min(6, limits.pages - site.pages.length));
    tries += batch.length;
    await eachLimited(batch, 6, async (url) => {
      try {
        const r = await get(url, { maxBytes: 3_000_000 });
        if (r.status >= 400) return void site.skipped.push({ url, why: `it answered ${r.status}` });
        if (!isHtml(r.type)) return;
        if (!sameSite(new URL(r.url), origin.hostname)) return void site.skipped.push({ url, why: "it moves to another site" });
        take(readPage(r.text(), r.url, inline, reg), r.url);
      } catch (e) {
        site.skipped.push({ url, why: e instanceof FetchRefused ? e.message : "it couldn't be fetched" });
      }
    });
    await o.progress?.({ stage: "copying pages", pages: site.pages.length, found: queued.size });
  }
  if (queue.length) site.skipped.push({ url: `${queue.length} more pages`, why: Date.now() >= deadline ? "the import ran out of time; import again to fetch more" : `the import stops at ${limits.pages} pages` });
  if (site.platform === "WordPress") site.posts = await wordpressPosts(origin, reg).catch(() => []);
  // Posts come as data too; past the app's room they keep their title and summary but not their text.
  let room = limits.codeBudget - bytes - cssBytes();
  for (const p of site.posts) {
    const n = (p.content?.length ?? 0) * 1.15 + 400;
    if (n > room) delete p.content;
    else room -= n, (bytes += n);
  }
  site.removed = [...removed];
  for (const [id, css] of inline) site.css[id] = css;
  return { ...site, reg, used: bytes + cssBytes() } as Site & { reg: Registry };
}

/** A WordPress site's posts, through its public API, as structured data the app can turn into a table. */
async function wordpressPosts(origin: URL, reg: Registry) {
  const posts: Post[] = [];
  const cats = new Map<number, string>();
  const c = await get(new URL("/wp-json/wp/v2/categories?per_page=100&_fields=id,name", origin).href, { maxBytes: 1_000_000 }).catch(() => undefined);
  if (c?.status === 200) for (const x of JSON.parse(c.text())) cats.set(x.id, x.name);
  for (let page = 1; page <= 5; page++) {
    const r = await get(new URL(`/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=date,slug,link,title,excerpt,content,categories`, origin).href, { maxBytes: 8_000_000, timeoutMs: 20_000 }).catch(() => undefined);
    if (!r || r.status !== 200) break;
    const list = JSON.parse(r.text());
    if (!Array.isArray(list) || !list.length) break;
    for (const p of list) {
      const content = readPage(`<body>${p.content?.rendered ?? ""}</body>`, p.link, new Map(), reg).body;
      posts.push({ title: decode(p.title?.rendered ?? ""), slug: p.slug, path: pagePath(new URL(p.link)), date: p.date, categories: (p.categories ?? []).map((id: number) => cats.get(id)).filter(Boolean), excerpt: decode(strip(p.excerpt?.rendered ?? "")).slice(0, 600), content });
    }
    if (list.length < 100) break;
  }
  return posts;
}

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, " ");

// --- WordPress export files (WXR). Squarespace's export is the same format. ---

const tag = (item: string, name: string) => {
  const m = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  const v = m[1].trim();
  return v.startsWith("<![CDATA[") ? v.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").replace(/\]\]\]\]><!\[CDATA\[>/g, "]]>") : decode(v);
};

/** WordPress keeps paragraphs as blank lines and adds the <p> tags when it shows a page. */
export const paragraphs = (html: string) =>
  /<(p|div|h[1-6]|ul|ol|figure|table|blockquote)[\s>]/i.test(html) && !/\n\s*\n/.test(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(pre)[\s\S]*?<\/\1>/gi, ""))
    ? html
    : html.split(/\n\s*\n/).map((b) => (/^\s*<(p|div|h[1-6]|ul|ol|figure|table|blockquote|pre|hr)[\s>]/i.test(b) ? b : `<p>${b.trim().replace(/\n/g, "<br>")}</p>`)).join("\n");

/** Reads a WordPress (or Squarespace) export file into a plain, tidy site: its pages, its posts and a blog page. */
export function fromExport(xml: string, limits: Limits): Site & { reg: Registry } {
  if (!/<rss[\s>]/i.test(xml.slice(0, 5000)) || !/wordpress\.org\/export/i.test(xml.slice(0, 20000))) throw new Error("That file isn't a WordPress export. In WordPress: Tools, Export, All content. In Squarespace: Settings, Import & export, Export.");
  const channel = xml.slice(0, xml.search(/<item[\s>]/i) === -1 ? 20000 : xml.search(/<item[\s>]/i));
  const link = tag(channel, "link") || "https://example.com";
  const origin = new URL(/^https?:/.test(link) ? link : `https://${link}`);
  const reg = new Registry();
  const site: Site & { reg: Registry } = { source: hostOf(origin.href), platform: /squarespace/i.test(xml.slice(0, 5000)) ? "Squarespace (export)" : "WordPress (export)", title: tag(channel, "title"), pages: [], css: {}, forms: [], posts: [], skipped: [], removed: [], images: { kept: 0, leftAtSource: 0, bytes: 0 }, reg };
  const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const pages: { title: string; path: string; body: string; date: string; order: number }[] = [];
  const removed = new Set<string>();
  let bytes = 0;
  for (const item of items) {
    const type = tag(item, "wp:post_type"), status = tag(item, "wp:status");
    if (status !== "publish" || (type !== "page" && type !== "post")) continue;
    const title = tag(item, "title"), url = tag(item, "link"), date = tag(item, "wp:post_date");
    let path: string;
    try {
      path = pagePath(new URL(url, origin));
    } catch {
      path = `/${tag(item, "wp:post_name") || "page"}`;
    }
    const r = readPage(`<body>${paragraphs(tag(item, "content:encoded"))}</body>`, new URL(path, origin).href, new Map(), reg);
    r.removed.forEach((x) => removed.add(x));
    if (r.forms.length) site.forms.push({ path, forms: r.forms });
    if (type === "post") {
      const categories = [...item.matchAll(/<category domain="category"[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => tag(`<c>${m[1]}</c>`, "c"));
      site.posts.push({ title, slug: tag(item, "wp:post_name"), path, date, categories, excerpt: strip(tag(item, "excerpt:encoded") || r.body).slice(0, 300), content: r.body });
    }
    if (bytes + r.body.length > limits.codeBudget || pages.length >= limits.pages) {
      site.skipped.push({ url: path, why: "the app has no more room for pages" });
      continue;
    }
    bytes += r.body.length + 500;
    pages.push({ title, path, body: r.body, date, order: Number(tag(item, "wp:menu_order")) || 0 });
  }
  const top = pages.filter((p) => !site.posts.some((x) => x.path === p.path)).sort((a, b) => a.order - b.order);
  const nav = `<header class="site"><a class="name" href="/">${esc(site.title ?? "Home")}</a><nav>${top.filter((p) => p.path !== "/").slice(0, 8).map((p) => `<a href="${esc(p.path)}">${esc(p.title)}</a>`).join("")}${site.posts.length ? `<a href="/blog">Blog</a>` : ""}</nav></header>`;
  const wrap = (title: string, inner: string) => `${nav}<main><h1>${esc(title)}</h1>${inner}</main>`;
  site.css.plain = PLAIN_CSS;
  for (const p of pages) site.pages.push({ path: p.path, title: `${p.title} | ${site.title}`, description: "", styles: ["inline:plain"], body: wrap(p.title, (site.posts.some((x) => x.path === p.path) ? `<p class="date">${esc(p.date.slice(0, 10))}</p>` : "") + p.body) });
  const list = site.posts.slice().sort((a, b) => b.date.localeCompare(a.date)).map((x) => `<li><a href="${esc(x.path)}">${esc(x.title)}</a> <span class="date">${esc(x.date.slice(0, 10))}</span><p>${esc(x.excerpt)}</p></li>`).join("");
  if (site.posts.length && !site.pages.some((p) => p.path === "/blog")) site.pages.push({ path: "/blog", title: `Blog | ${site.title}`, description: "", styles: ["inline:plain"], body: wrap("Blog", `<ul class="posts">${list}</ul>`) });
  if (!site.pages.some((p) => p.path === "/")) site.pages.unshift({ path: "/", title: site.title ?? "Home", description: tag(channel, "description"), styles: ["inline:plain"], body: wrap(site.title ?? "Home", `<p>${esc(tag(channel, "description"))}</p>${list ? `<h2>Latest</h2><ul class="posts">${list.split("</li>").slice(0, 5).join("</li>")}</ul>` : ""}`) });
  site.removed = [...removed];
  return site;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const PLAIN_CSS = `*{box-sizing:border-box}body{margin:0;font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d241f;background:#fff}
header.site{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;align-items:baseline;padding:1rem max(1rem,calc(50% - 22rem));border-bottom:1px solid #e3e7e3}
header.site .name{font-weight:700;font-size:1.15rem;color:inherit;text-decoration:none;margin-right:auto}header.site nav{display:flex;flex-wrap:wrap;gap:.25rem 1rem}
header.site nav a{color:#2f5d3a;text-decoration:none}main{max-width:44rem;margin:0 auto;padding:1.5rem 1rem 3rem}img,video,iframe{max-width:100%;height:auto}
h1{line-height:1.2;font-size:2rem}a{color:#2f5d3a}.date{color:#5b6b5e;font-size:.9rem}ul.posts{list-style:none;padding:0}ul.posts li{margin:0 0 1.25rem}
figure{margin:1.5rem 0}figcaption{color:#5b6b5e;font-size:.9rem}blockquote{margin:1.5rem 0;padding-left:1rem;border-left:3px solid #c9d4ca}
.grove-form{padding:1rem;border:1px dashed #9aa79c;border-radius:8px;color:#5b6b5e}
@media (prefers-color-scheme:dark){body{background:#141814;color:#e4ebe4}header.site{border-color:#2a332b}a,header.site nav a{color:#9fd3aa}}`;

// --- Pictures and stylesheets ---

const IMAGE_MAGIC: [string, (b: Uint8Array) => boolean][] = [
  ["image/png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  ["image/webp", (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45],
];
export const imageType = (b: Uint8Array) => IMAGE_MAGIC.find(([, ok]) => b.length > 12 && ok(b))?.[0];

/**
 * Fetches the stylesheets (and the ones they import), then copies pictures into the file store with
 * `keep`, until the limits. Anything not copied keeps pointing at the old site.
 */
export async function gather(site: Site & { reg: Registry }, limits: Limits, keep: (name: string, type: string, bytes: Uint8Array) => Promise<string>, progress?: Progress) {
  const { reg } = site;
  const deadline = Date.now() + limits.seconds * 1000;
  let room = limits.codeBudget - (site.used ?? 0);
  for (let i = 0; i < reg.list.length && i < 400; i++) {
    const a = reg.list[i];
    if (a.kind !== "style") continue;
    try {
      const r = await get(a.url, { maxBytes: 1_500_000, timeoutMs: 12_000 });
      if (r.status !== 200 || !/css|text\/plain|^$/.test(r.type)) continue;
      const css = cssUrls(r.text(), new URL(r.url), reg);
      // Past the app's room, a stylesheet stays where it is and the page loads it from the old site.
      if (css.length > room) continue;
      room -= css.length;
      const id = createHash("sha256").update(css).digest("hex").slice(0, 12);
      site.css[id] = css;
      a.final = `/imported-styles/${id}.css`;
    } catch {}
  }
  const images = reg.list.filter((a) => a.kind === "image");
  let kept = 0, bytes = 0;
  await eachLimited(images, 6, async (a) => {
    if (kept >= limits.images || bytes >= limits.imageBytes || Date.now() > deadline) return;
    try {
      const r = await get(a.url, { maxBytes: 4_000_000, timeoutMs: 15_000 });
      const type = r.status === 200 ? imageType(r.body) : undefined;
      if (!type || bytes + r.body.length > limits.imageBytes) return;
      bytes += r.body.length;
      const name = (decodeURIComponent(new URL(r.url).pathname.split("/").pop() || "picture").replace(/[^\w.-]+/g, "-").replace(/\.[a-z0-9]+$/i, "").slice(0, 60) || "picture") + "." + type.split("/")[1].replace("jpeg", "jpg");
      a.final = await keep(name, type, r.body);
      kept++;
      if (kept % 20 === 0) await progress?.({ stage: "copying pictures", images: kept });
    } catch {}
  });
  site.images = { kept, leftAtSource: images.length - kept, bytes };
}

const placed = (reg: Registry, s: string) => s.replace(ASSET_RE, (_, n) => reg.list[Number(n)]?.final ?? reg.list[Number(n)]?.url ?? "");

// --- Writing the app's files ---

const chunks = <T>(items: T[], size: (t: T) => number, max: number) => {
  const out: T[][] = [[]];
  let n = 0;
  for (const it of items) {
    const s = size(it);
    if (n + s > max && out[out.length - 1].length) out.push([]), (n = 0);
    out[out.length - 1].push(it);
    n += s;
  }
  return out.filter((c) => c.length);
};
const asData = (name: string, type: string, value: unknown) => `export const ${name}: ${type} = ${JSON.stringify(value)};\n`;
const CHUNK = 170_000;

/** The app files for an imported site: its pages, styles, forms, posts and the renderer that serves them. */
export function siteFiles(site: Site & { reg: Registry }, at = new Date()): Files {
  const { reg } = site;
  // Paths the kit uses move under /site, and links to them follow.
  const moved = new Map<string, string>();
  for (const p of site.pages) if (kitOwned(p.path)) moved.set(p.path, `/site${p.path}`);
  const relink = (html: string) => (moved.size ? html.replace(/href="([^"#?]*)([#?][^"]*)?"/g, (w, p, rest) => (moved.has(p) ? `href="${moved.get(p)}${rest ?? ""}"` : w)) : html);
  const pages: Page[] = site.pages.map((p) => ({
    ...p,
    path: moved.get(p.path) ?? p.path,
    image: p.image && placed(reg, p.image),
    styles: p.styles.map((s) => (s.startsWith("inline:") ? `/imported-styles/${s.slice(7)}.css` : placed(reg, s))).filter((s) => s && !s.startsWith("grove-asset")),
    body: relink(placed(reg, p.body)),
  }));
  const css: Record<string, string> = {};
  for (const [id, c] of Object.entries(site.css)) css[id] = placed(reg, c);
  const files: Files = {};
  // A page too big for one file is kept in parts, put back together in site.ts.
  const pieces: Page[] = pages.flatMap((p) => {
    if (p.body.length <= CHUNK - 20_000) return [p];
    const parts: Page[] = [];
    for (let i = 0, at = 0; at < p.body.length; i++, at += CHUNK - 20_000) parts.push(i === 0 ? { ...p, body: p.body.slice(0, CHUNK - 20_000) } : { path: p.path, title: "", description: "", styles: [], body: p.body.slice(at, at + CHUNK - 20_000), part: i });
    return parts;
  });
  const pageChunks = chunks(pieces, (p) => JSON.stringify(p).length + 50, CHUNK);
  pageChunks.forEach((c, i) => (files[`src/imported/pages-${i + 1}.ts`] = `// Pages copied from ${site.source}. Edit freely: this is the app's own copy.\nimport type { Page } from "./render.ts";\n${asData("pages", "Page[]", c)}`));
  const cssChunks = chunks(Object.entries(css), ([, c]) => c.length + 50, CHUNK);
  cssChunks.forEach((c, i) => (files[`src/imported/styles-${i + 1}.ts`] = `// Stylesheets copied from ${site.source}, served at /imported-styles/<id>.css.\n${asData("styles", "Record<string, string>", Object.fromEntries(c))}`));
  if (site.posts.length) {
    const posts = site.posts.map((p) => ({ ...p, path: moved.get(p.path) ?? p.path, content: p.content && relink(placed(reg, p.content)) }));
    chunks(posts, (p) => JSON.stringify(p).length + 50, CHUNK).forEach((c, i) => (files[`src/imported/posts-${i + 1}.ts`] = `// Posts copied from ${site.source}, as data: turn them into a table, a blog page or both.\nexport type Post = { title: string; slug: string; path: string; date: string; categories: string[]; excerpt: string; content?: string };\n${asData("posts", "Post[]", c)}`));
  }
  files["src/imported/forms.ts"] = `// The forms the old site had. Imported pages show a placeholder where each one was ([Form n]).
// Rebuild each as a real form: a table for what it collects, a route that checks and saves it, and the
// form's HTML in the page in place of the placeholder (data-grove-form="n").
export const forms = ${JSON.stringify(site.forms.map((f) => ({ ...f, path: moved.get(f.path) ?? f.path })), null, 2)};\n`;
  const pageImports = pageChunks.map((_, i) => `import { pages as p${i + 1} } from "./pages-${i + 1}.ts";`).join("\n");
  const styleImports = cssChunks.map((_, i) => `import { styles as s${i + 1} } from "./styles-${i + 1}.ts";`).join("\n");
  files["src/imported/site.ts"] = `// A copy of ${site.source}, imported by Grove on ${at.toISOString().slice(0, 10)}${site.platform ? ` (it was made with ${site.platform})` : ""}.
// The pages are data in pages-*.ts and the stylesheets in styles-*.ts; render.ts serves them.
${pageImports}
${styleImports}
import type { Page } from "./render.ts";

/** Where these pages came from. Grove asks the maker to show they run this site before it goes live. */
export const SOURCE = ${JSON.stringify(site.source)};
const all: Page[] = [${pageChunks.map((_, i) => `...p${i + 1}`).join(", ")}];
export const pages: Page[] = all.filter((p) => !p.part).map((p) => ({ ...p, body: p.body + all.filter((x) => x.part && x.path === p.path).sort((a, b) => (a.part ?? 0) - (b.part ?? 0)).map((x) => x.body).join("") }));
export const styles: Record<string, string> = Object.assign({}, ${cssChunks.map((_, i) => `s${i + 1}`).join(", ") || "{}"});
`;
  files["src/imported/render.ts"] = RENDER;
  return files;
}

/** The renderer every imported site uses. Kept as plain code so the maker can change how pages look. */
export const RENDER = `// Serves pages imported by Grove: each at its old path, with its own stylesheets, and with a policy
// that lets no script run. On a trial copy every page says it is a copy and asks search engines to stay away.
import type { Hono } from "hono";

export type Page = { path: string; title: string; description: string; lang?: string; bodyClass?: string; image?: string; styles: string[]; body: string; part?: number };

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => \`&#\${ch.charCodeAt(0)};\`);

/** Pictures may come from anywhere, scripts from nowhere, and embeds only from the usual video and map sites. */
export const POLICY = "default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; style-src 'self' 'unsafe-inline' https:; img-src * data:; font-src * data:; media-src *; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.google.com https://maps.google.com https://open.spotify.com https://w.soundcloud.com https://calendar.google.com https://docs.google.com";

/** A path as pages are kept: no trailing slash (except "/"), no ".html". */
export const keyOf = (path: string) => {
  let p = decodeURIComponent(path).replace(/\\/index\\.(html?|php)$/i, "/").replace(/\\.html?$/i, "");
  if (p.length > 1) p = p.replace(/\\/+$/, "");
  return p || "/";
};

export function pageHtml(p: Page, source: string) {
  const trial = Boolean(process.env.GROVE_TRIAL);
  const banner = trial ? \`<div role="note" style="position:sticky;top:0;z-index:2147483647;padding:8px 16px;background:#fff4c2;color:#3b2f00;font:14px/1.4 system-ui,sans-serif;text-align:center;border-bottom:1px solid #e0cf7a">A trial copy of \${esc(source)}, made with Grove. It isn't the live site.</div>\` : "";
  return \`<!doctype html>
<html\${p.lang ? \` lang="\${esc(p.lang)}"\` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="\${POLICY}">
<title>\${esc(p.title)}</title>
\${p.description ? \`<meta name="description" content="\${esc(p.description)}">\` : ""}
\${p.image ? \`<meta property="og:image" content="\${esc(p.image)}">\` : ""}
\${trial ? '<meta name="robots" content="noindex, nofollow">' : ""}
\${p.styles.map((s) => \`<link rel="stylesheet" href="\${esc(s)}">\`).join("\\n")}
</head>
<body\${p.bodyClass ? \` class="\${esc(p.bodyClass)}"\` : ""}>
\${banner}\${p.body}
</body>
</html>\`;
}

/** Adds the imported pages and their stylesheets to the app. Paths the app already serves win. */
export function siteRoutes(app: Hono, pages: Page[], styles: Record<string, string>, source: string) {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  app.get("/imported-styles/:file", (c) => {
    const css = styles[c.req.param("file").replace(/\\.css$/, "")];
    if (css === undefined) return c.notFound();
    return c.body(css, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" });
  });
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const p = byPath.get(keyOf(c.req.path));
    if (!p || p.path === "/") return next();
    return c.html(pageHtml(p, source), 200, { "content-security-policy": POLICY + "; frame-ancestors 'none'", "x-content-type-options": "nosniff" });
  });
}

/** The imported front page, for the app's \\\`home\\\`. */
export const homeOf = (pages: Page[], source: string) => {
  const p = pages.find((x) => x.path === "/");
  return p ? () => pageHtml(p, source) : undefined;
};
`;

/** Takes the old import's files out, so a fresh import replaces it rather than leaving stale pages behind. */
export const withoutOldSite = (files: Files) => Object.fromEntries(Object.entries(files).filter(([p]) => !/^src\/imported\/(pages|styles|posts)-\d+\.ts$|^src\/imported\/(site|forms)\.ts$/.test(p)));

/**
 * A site as a private preview served by Grove at base (e.g. /preview/<token>): its pages with links between
 * them pointing inside the preview, and its inline stylesheets at base/styles/<id>.css. Nothing else is
 * kept: pictures and the site's own stylesheets still load from where they are.
 */
export function previewOf(site: Site & { reg: Registry }, base: string) {
  const inside = (html: string) => html.replace(/(href|action)="(\/(?!\/)[^"]*)"/g, (_, attr, path) => `${attr}="${base}${path === "/" ? "/" : path}"`);
  const pages = site.pages.map((p) => ({
    path: p.path,
    title: p.title,
    description: p.description,
    lang: p.lang,
    bodyClass: p.bodyClass,
    styles: p.styles.map((s) => (s.startsWith("inline:") ? `${base}/styles/${s.slice(7)}.css` : placed(site.reg, s))).filter((s) => s && !s.startsWith("grove-asset")),
    body: inside(placed(site.reg, p.body)),
  }));
  const css = Object.fromEntries(Object.entries(site.css).map(([id, c]) => [id, placed(site.reg, c)]));
  return { source: site.source, platform: site.platform, title: site.title, pages, css, forms: site.forms.reduce((n, f) => n + f.forms.length, 0) };
}
export type Preview = ReturnType<typeof previewOf>;
