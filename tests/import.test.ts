// Moving a site or a spreadsheet into an app: pages are cleaned of anything that runs, copied with their
// pictures and styles, written as code that passes Grove's own checks, and served at the same paths.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { buildAssets } from "../scripts/build-assets.ts";
import { TEMPLATE } from "../grove/src/template-files.ts";
import { readPage, ASSET_RE } from "../grove/src/html.ts";
import { crawl, fromExport, gather, paragraphs, sensitiveHost, siteFiles, withoutOldSite, imageType } from "../grove/src/importer.ts";
import { dataFiles, importedIndex, parseCsv, wire, columnName } from "../grove/src/datafile.ts";
import { allowLocalForTests, blockedBy, disallowed, privateAddress, publicUrl } from "../grove/src/fetcher.ts";
import { ownerCode, checkOwner } from "../grove/src/owner.ts";

let b: typeof import("../grove/src/build.ts");
let server: Server, base = "";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5b1d6ff0000000049454e44ae426082", "hex");
const SITE: Record<string, [string, string]> = {
  "/": ["text/html", `<!doctype html><html lang="en-GB"><head><title>River Rowing Club</title><meta name="description" content="Rowing on the river since 1902">
    <meta name="generator" content="WordPress 6.7"><link rel="stylesheet" href="/wp-content/themes/river/style.css"><style>.hero{color:navy}</style>
    <script>alert(1)</script></head><body class="home page">
    <nav><a href="/about/">About</a> <a href="/join">Join</a> <a href="/account">Members</a> <a href="https://elsewhere.example/x">Elsewhere</a> <a href="javascript:alert(1)">Bad</a></nav>
    <h1 class="hero" onclick="steal()">Welcome</h1><img src="/wp-content/uploads/boat.png" alt="A boat" onerror="x()">
    <iframe src="https://www.youtube.com/embed/abc"></iframe><iframe src="https://evil.example/frame"></iframe>
    <form action="/contact" method="post"><label for="e">Your email</label><input id="e" name="email" type="email" required><textarea name="msg" placeholder="Message"></textarea><button>Send</button></form>
    </body></html>`],
  "/about": ["text/html", `<html><head><title>About us</title></head><body><p>We row.</p><a href="/">Home</a><a href="/secret">Secret</a></body></html>`],
  "/join": ["text/html", `<html><head><title>Join</title></head><body><p>Join us</p><div style="background:url('/wp-content/uploads/boat.png')">x</div></body></html>`],
  "/account": ["text/html", `<html><head><title>Members</title></head><body><p>Members area</p></body></html>`],
  "/secret": ["text/html", `<html><body>Hidden</body></html>`],
  "/robots.txt": ["text/plain", "User-agent: *\nDisallow: /secret\n"],
  "/wp-content/themes/river/style.css": ["text/css", "body{background:url(../../uploads/boat.png)} h1{font-weight:700}"],
  "/wp-content/uploads/boat.png": ["image/png", PNG.toString("latin1")],
};

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-import-"));
  for (const [name, bytes] of Object.entries(await buildAssets())) {
    if (!name.startsWith("build/")) continue;
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  process.env.GROVE_BUILD_ASSETS = dir;
  b = await import("../grove/src/build.ts");
  allowLocalForTests();
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
    const page = SITE[path];
    if (!page) return res.writeHead(404).end("missing");
    res.writeHead(200, { "content-type": page[0] }).end(Buffer.from(page[1], "latin1"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => {
  allowLocalForTests(false);
  server?.close();
});

const assets = () => {
  const list: string[] = [];
  return { list, add: (u: string) => `grove-asset:${list.push(u) - 1}` };
};

test("a page is cleaned: no scripts, handlers, bad links or strange frames; forms are listed", () => {
  const a = assets(), css = new Map<string, string>();
  const r = readPage(SITE["/"][1], "https://river.example/", css, a);
  assert.equal(r.title, "River Rowing Club");
  assert.equal(r.description, "Rowing on the river since 1902");
  assert.equal(r.platform, "WordPress");
  assert.equal(r.lang, "en-GB");
  assert.equal(r.bodyClass, "home page");
  assert.doesNotMatch(r.body, /<script|onclick|onerror|javascript:|evil\.example|<form|<input|<textarea/i);
  assert.match(r.body, /href="\/about"/);
  assert.match(r.body, /href="https:\/\/elsewhere\.example\/x" rel="noopener"/);
  assert.match(r.body, /youtube\.com\/embed\/abc/);
  assert.match(r.body, /sandbox="allow-scripts/);
  assert.match(r.body, /data-grove-form="1"/);
  assert.deepEqual(r.forms[0].fields.map((f) => [f.name, f.type, f.label, f.required]), [["email", "email", "Your email", true], ["msg", "textarea", "Message", undefined]]);
  assert.deepEqual(r.links.sort(), ["/about", "/account", "/join"]);
  assert.ok(a.list.includes("https://river.example/wp-content/uploads/boat.png"));
  assert.ok(r.styles.some((s) => s.startsWith("inline:")) && r.styles.some((s) => ASSET_RE.test(s)));
  assert.deepEqual(r.removed.sort(), ["embeds", "forms", "scripts"]);
});

test("lazy pictures use their real address, and SVG loses its handlers", () => {
  const a = assets();
  const r = readPage(`<body><img src="data:image/gif;base64,R0lGOD" data-src="/pic.jpg"><svg onload="x()"><a href="javascript:y()"><circle r="2"/></a></svg></body>`, "https://s.example/", new Map(), a);
  assert.deepEqual(a.list, ["https://s.example/pic.jpg"]);
  assert.doesNotMatch(r.body, /onload|javascript:/);
});

test("addresses inside networks are refused; public ones are fine", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) assert.ok(privateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.ok(!privateAddress(ip), ip);
  const fake = (async (h: string) => (h === "inside.example" ? [{ address: "10.0.0.5" }] : [{ address: "93.184.216.34" }])) as any;
  await assert.rejects(publicUrl("http://inside.example/", fake), /isn't a public website/);
  await assert.rejects(publicUrl("file:///etc/passwd", fake), /Only web addresses/);
  await assert.rejects(publicUrl("http://a:b@ok.example/", fake), /names and passwords/);
  await assert.rejects(publicUrl("http://ok.example:8080/", fake), /usual web ports/);
  assert.equal((await publicUrl("https://ok.example/x", fake)).href, "https://ok.example/x");
});

test("robots.txt rules are read for everyone and for Grove", () => {
  const rules = disallowed("User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /private\nDisallow: /*.pdf$\n");
  assert.deepEqual(rules, ["/private", "/*.pdf$"]);
  assert.ok(blockedBy(rules, "/private/x"));
  assert.ok(blockedBy(rules, "/a/b.pdf"));
  assert.ok(!blockedBy(rules, "/g"));
});

test("banks, governments and big brands aren't copied", () => {
  for (const h of ["paypal.com", "www.hsbc.co.uk", "login.microsoftonline.com", "gov.uk", "tax.service.gov.uk", "secure-account.example", "monzo.com"]) assert.ok(sensitiveHost(h), h);
  for (const h of ["riverrowing.club", "joes-cafe.co.uk", "applecrumble.bakery"]) assert.equal(sensitiveHost(h), undefined, h);
});

let crawled: Awaited<ReturnType<typeof crawl>>;

test("a site is crawled: pages at their paths, robots.txt respected, pictures and styles gathered", async () => {
  crawled = await crawl(base + "/", { pages: 20, images: 10, imageBytes: 1_000_000, codeBudget: 1_000_000, seconds: 30 });
  const paths = crawled.pages.map((p) => p.path).sort();
  assert.deepEqual(paths, ["/", "/about", "/account", "/join"]);
  assert.ok(crawled.skipped.some((s) => s.url.endsWith("/secret") && /robots/.test(s.why)));
  assert.equal(crawled.forms.length, 1);
  const kept: string[] = [];
  await gather(crawled, { pages: 20, images: 10, imageBytes: 1_000_000, codeBudget: 1_000_000, seconds: 30 }, async (name, type, bytes) => {
    assert.equal(type, "image/png");
    assert.equal(imageType(bytes), "image/png");
    kept.push(name);
    return `https://grove.example/files/1/${name}`;
  });
  assert.deepEqual(kept, ["boat.png"], "the same picture is copied once");
  assert.equal(crawled.images.kept, 1);
  assert.ok(Object.values(crawled.css).some((c) => c.includes("font-weight:700") && c.includes("grove-asset:")), "the theme's stylesheet is kept");
});

test("the imported site becomes code that passes Grove's checks, wired into the template", async () => {
  const files = siteFiles(crawled, new Date("2026-11-18"));
  const all: Record<string, string> = { ...TEMPLATE, ...files };
  all["src/imported/index.ts"] = importedIndex(all);
  const w = wire(all["src/app.ts"], { home: true });
  all["src/app.ts"] = w.code;
  assert.deepEqual(w.todo, []);
  assert.equal(w.done.length, 4);
  const pages = Object.entries(files).filter(([p]) => p.startsWith("src/imported/pages-")).map(([, c]) => c).join("");
  assert.doesNotMatch(pages, /grove-asset:/, "every placeholder was replaced");
  assert.match(pages, /https:\/\/grove\.example\/files\/1\/boat\.png/);
  assert.match(pages, /"path":"\/site\/account"/, "the kit's /account moved");
  assert.match(pages, /href=\\"\/site\/account\\"/, "and links to it follow");
  assert.match(files["src/imported/site.ts"], /export const SOURCE = "127\.0\.0\.1"/);
  assert.deepEqual(await b.check(all), []);
  const out = await b.bundle(all);
  assert.ok(Object.keys(out).length);
  // A second import replaces the first one's pages.
  const again = withoutOldSite(all);
  assert.ok(!Object.keys(again).some((p) => /pages-\d|styles-\d|site\.ts/.test(p)));
  assert.ok("src/imported/render.ts" in again);
});

test("imported pages are served at their paths with no scripts allowed, and say when they're a trial copy", async () => {
  const dir = mkdtempSync(join(process.cwd(), "tests", ".tmp-import-"));
  try {
    const files = siteFiles(crawled);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    const { Hono } = await import("hono");
    const site = await import(join(dir, "src/imported/site.ts"));
    const render = await import(join(dir, "src/imported/render.ts"));
    const app = new Hono();
    app.get("/mine", (c) => c.text("the app's own"));
    render.siteRoutes(app, site.pages, site.styles, site.SOURCE);
    const about = await app.request("/about/");
    assert.equal(about.status, 200);
    assert.match(about.headers.get("content-security-policy") ?? "", /script-src 'none'/);
    const html = await about.text();
    assert.match(html, /<title>About us<\/title>/);
    assert.match(html, /We row\./);
    assert.doesNotMatch(html, /trial copy/);
    process.env.GROVE_TRIAL = "1";
    const trial = await (await app.request("/about")).text();
    delete process.env.GROVE_TRIAL;
    assert.match(trial, /A trial copy of 127\.0\.0\.1/);
    assert.match(trial, /noindex/);
    assert.equal(await (await app.request("/mine")).text(), "the app's own");
    assert.equal((await app.request("/nope")).status, 404);
    const front = render.homeOf(site.pages, site.SOURCE)!();
    const cssPath = front.match(/href="(\/imported-styles\/[^"]+)"/)?.[1];
    assert.ok(cssPath);
    const css = await app.request(cssPath!);
    assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
    assert.ok(render.homeOf(site.pages, site.SOURCE)?.().includes("Welcome"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WXR = `<?xml version="1.0"?><rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/">
<channel><title>Joe's Cafe</title><link>https://joes.example</link><description>Coffee and cake</description><generator>https://wordpress.org/?v=6.7</generator>
<wp:base_site_url>https://joes.example</wp:base_site_url><!-- http://wordpress.org/export/1.2/ -->
<item><title>Menu</title><link>https://joes.example/menu/</link><wp:post_type><![CDATA[page]]></wp:post_type><wp:status><![CDATA[publish]]></wp:status><wp:post_name>menu</wp:post_name><wp:post_date>2024-01-01 10:00:00</wp:post_date>
<content:encoded><![CDATA[Tea £2

Cake £3 <script>bad()</script>]]></content:encoded></item>
<item><title>We're open Sundays</title><link>https://joes.example/2024/05/sundays/</link><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><wp:post_name>sundays</wp:post_name><wp:post_date>2024-05-02 09:00:00</wp:post_date>
<category domain="category" nicename="news"><![CDATA[News]]></category><content:encoded><![CDATA[<!-- wp:paragraph --><p>From June.</p><!-- /wp:paragraph -->]]></content:encoded><excerpt:encoded><![CDATA[]]></excerpt:encoded></item>
<item><title>Draft</title><link>https://joes.example/?p=9</link><wp:post_type>post</wp:post_type><wp:status>draft</wp:status><content:encoded><![CDATA[secret]]></content:encoded></item>
</channel></rss>`;

test("a WordPress export becomes tidy pages, a blog and posts as data; drafts stay out", async () => {
  const s = fromExport(WXR, { pages: 50, images: 0, imageBytes: 0, codeBudget: 1_000_000, seconds: 10 });
  assert.equal(s.source, "joes.example");
  assert.deepEqual(s.pages.map((p) => p.path).sort(), ["/", "/2024/05/sundays", "/blog", "/menu"]);
  const menu = s.pages.find((p) => p.path === "/menu")!;
  assert.match(menu.body, /<p>Tea £2<\/p>/);
  assert.doesNotMatch(menu.body, /script|secret/);
  assert.equal(s.posts.length, 1);
  assert.deepEqual(s.posts[0].categories, ["News"]);
  assert.ok(!JSON.stringify(s).includes("secret"));
  assert.throws(() => fromExport("<html></html>", { pages: 1, images: 0, imageBytes: 0, codeBudget: 1, seconds: 1 }), /isn't a WordPress export/);
  const all: Record<string, string> = { ...TEMPLATE, ...siteFiles(s) };
  all["src/imported/index.ts"] = importedIndex(all);
  all["src/app.ts"] = wire(all["src/app.ts"], { home: true }).code;
  assert.ok(Object.keys(all).some((p) => p.startsWith("src/imported/posts-")));
  assert.deepEqual(await b.check(all), []);
});

test("paragraphs: WordPress's blank-line paragraphs get their tags; block content is left alone", () => {
  assert.equal(paragraphs("One\n\nTwo\nlines"), "<p>One</p>\n<p>Two<br>lines</p>");
  assert.equal(paragraphs("<p>Already</p>"), "<p>Already</p>");
});

test("CSV: quotes, line breaks, other separators", () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi""\nthere"\r\n'), [["a", "b"], ["x, y", 'say "hi"\nthere']]);
  assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("﻿a\tb\n1\t2\n\n"), [["a", "b"], ["1", "2"]]);
  assert.equal(columnName("Email Address", 0), "email_address");
  assert.equal(columnName("Order", 1), "order_");
  assert.equal(columnName("2024 total", 2), "c_2024_total");
  assert.equal(columnName("!!!", 3), "column_4");
});

test("a spreadsheet becomes a table whose rows load once, and passes Grove's checks", async () => {
  const csv = "Name,Email,Joined,Paid,Fee,Phone\nAnn O'Neil,ann@x.example,2024-01-05,yes,12.50,07700900001\nBo,bo@x.example,2024-02-01,no,1,07700900002\n";
  const d = dataFiles("members", csv);
  assert.equal(d.rows, 2);
  assert.deepEqual(d.columns.map((c) => [c.column, c.type]), [["name", "text"], ["email", "text"], ["joined", "date"], ["paid", "boolean"], ["fee", "numeric"], ["phone", "text"]]);
  const sql = JSON.parse(d.files["src/imported/data-members-1.ts"].match(/schema = (".*");/)![1]);
  assert.match(sql, /create table if not exists members/);
  assert.match(sql, /'Ann O''Neil'/);
  assert.match(sql, /'07700900001'/, "phone numbers keep their leading zero");
  assert.match(sql, /if not exists \(select 1 from imported_batches/);
  const tricky = JSON.parse(dataFiles("notes", "Text\n\"ends $grove$ early?\"\n").files["src/imported/data-notes-1.ts"].match(/schema = (".*");/)![1]);
  assert.match(tricky, /do \$grove1\$ begin[\s\S]*end \$grove1\$;/, "a cell can't end the block");
  assert.throws(() => dataFiles("maple_people", csv), /kit uses/);
  assert.throws(() => dataFiles("Bad Name", csv), /lowercase/);
  assert.throws(() => dataFiles("t", "only,a,header\n"), /at least one row/);
  const all: Record<string, string> = { ...TEMPLATE, ...d.files };
  all["src/imported/index.ts"] = importedIndex(all);
  const w = wire(all["src/app.ts"], { home: false });
  all["src/app.ts"] = w.code;
  assert.match(all["src/app.ts"], /export const schema = `\$\{importedSchema\}/);
  assert.deepEqual(await b.check(all), []);
});

test("wiring says what's left when app.ts has moved on from the template", () => {
  const w = wire(`import x from "y";\nexport const schema = "plain";\nexport const home = () => "mine";\n`, { home: true });
  assert.ok(w.done.includes("imported src/imported/index.ts"));
  assert.equal(w.todo.length, 3);
});

test("owner check: the code on a page or in DNS shows the site is theirs", async () => {
  const sign = (s: string) => "f".repeat(64) + s.length;
  const code = ownerCode("a@b.example", "www.River.Example", sign);
  assert.equal(code, ownerCode("a@b.example", "river.example", sign), "www. and case don't matter");
  assert.match(code, /^grove-verify=[0-9a-f]{32}$/);
  const recorded: any[] = [];
  const pool = { query: async (_sql: string, args: any[]) => (recorded.push(args), { rows: [] }) } as any;
  const dns = (async (name: string) => (name === "_grove.river.example" ? [[code]] : [])) as any;
  const r = await checkOwner(pool, "a@b.example", "river.example", sign, undefined, dns);
  assert.equal(r.verified, true);
  assert.equal(r.how, "DNS TXT record on _grove.river.example");
  assert.deepEqual(recorded[0], ["a@b.example", "river.example", "DNS TXT record on _grove.river.example"]);
});

test("a page too big for one file is kept in parts and put back together", async () => {
  const big = "<p>" + "Rowing news. ".repeat(30_000) + "</p>";
  const s: any = { source: "big.example", pages: [{ path: "/", title: "Big", description: "", styles: [], body: big }, { path: "/small", title: "Small", description: "", styles: [], body: "<p>hi</p>" }], css: {}, forms: [], posts: [], skipped: [], removed: [], images: { kept: 0, leftAtSource: 0, bytes: 0 }, reg: { list: [], index: new Map() } };
  const files = siteFiles(s);
  assert.ok(Object.values(files).every((c) => c.length < 200_000), "every file fits Grove's limit");
  assert.ok(Object.keys(files).filter((p) => p.startsWith("src/imported/pages-")).length >= 3);
  const dir = mkdtempSync(join(process.cwd(), "tests", ".tmp-import-"));
  try {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    const site = await import(join(dir, "src/imported/site.ts"));
    assert.equal(site.pages.length, 2);
    assert.equal(site.pages.find((p: any) => p.path === "/").body, big);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const all: Record<string, string> = { ...TEMPLATE, ...files };
  all["src/imported/index.ts"] = importedIndex(all);
  all["src/app.ts"] = wire(all["src/app.ts"], { home: true }).code;
  assert.deepEqual(await b.check(all), []);
});
