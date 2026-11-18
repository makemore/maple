// Outreach previews: a business's public pages copied into a private preview that keeps nothing of the
// site's files, links within itself, says it isn't live, runs no scripts, and keeps out of search engines.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { crawl, previewOf } from "../grove/src/importer.ts";
import { allowLocalForTests } from "../grove/src/fetcher.ts";
import { emailFor, PREVIEW_HEADERS, PREVIEW_LIMITS, previewPage, newToken } from "../grove/src/prospects.ts";

let server: Server, base = "";
const SITE: Record<string, [string, string]> = {
  "/": ["text/html", `<!doctype html><html lang="en-GB"><head><title>Crumb Bakery</title><link rel="stylesheet" href="/s/site.css"><style>.hero{color:brown}</style><script>track()</script>
    <meta name="generator" content="Squarespace"></head><body><nav><a href="/menu">Menu</a> <a href="/secret">Secret</a></nav><h1 class="hero">Fresh bread</h1>
    <img src="/i/loaf.jpg" alt="A loaf"><form action="/order" method="post"><input name="email"><button>Order</button></form></body></html>`],
  "/menu": ["text/html", `<html><head><title>Menu</title></head><body><p>Sourdough £4</p><a href="/">Home</a></body></html>`],
  "/secret": ["text/html", `<html><body>Hidden</body></html>`],
  "/robots.txt": ["text/plain", "User-agent: *\nDisallow: /secret\n"],
  "/s/site.css": ["text/css", "h1{font-weight:700}"],
};

before(async () => {
  allowLocalForTests();
  server = createServer((req, res) => {
    const page = SITE[(req.url ?? "/").split("?")[0]];
    if (!page) return res.writeHead(404).end("missing");
    res.writeHead(200, { "content-type": page[0] }).end(page[1]);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => {
  allowLocalForTests(false);
  server?.close();
});

test("preview: pages link inside the preview, pictures and the site's stylesheets stay where they are, inline styles are served by Grove", async () => {
  const site = await crawl(base + "/", PREVIEW_LIMITS, { owner: false });
  const token = newToken();
  const p = previewOf(site, `/preview/${token}`);
  assert.deepEqual(p.pages.map((x) => x.path).sort(), ["/", "/menu"], "robots.txt is respected");
  assert.equal(p.platform, "Squarespace");
  const home = p.pages.find((x) => x.path === "/")!;
  assert.match(home.body, new RegExp(`href="/preview/${token}/menu"`));
  assert.match(home.body, new RegExp(`src="${base}/i/loaf.jpg"`), "pictures load from the business's own site");
  assert.ok(home.styles.includes(`${base}/s/site.css`));
  const inline = home.styles.find((s) => s.includes("/styles/"))!;
  assert.match(inline, new RegExp(`^/preview/${token}/styles/[a-f0-9]+\\.css$`));
  assert.equal(p.css[inline.split("/").pop()!.replace(".css", "")], ".hero{color:brown}");
  assert.doesNotMatch(home.body, /<script|<form|track\(\)/);
  assert.equal(p.forms, 1);

  const row = { host: "crumb.example", business: "Crumb Bakery Ltd", expires_at: new Date("2026-12-02T00:00:00Z"), preview: p };
  const html = previewPage(row, `/preview/${token}`, "/")!;
  assert.match(html, /A private preview of <strong>crumb\.example<\/strong>, made by Grove for Crumb Bakery Ltd\. It isn't live/);
  assert.match(html, /deletes itself on 2026-12-02/);
  assert.match(html, new RegExp(`href="/preview/${token}/no"`));
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.ok(previewPage(row, `/preview/${token}`, "/menu/"), "a trailing slash finds the page");
  assert.equal(previewPage(row, `/preview/${token}`, "/secret"), undefined);
  assert.match(PREVIEW_HEADERS["content-security-policy"], /script-src 'none'/);
  assert.match(PREVIEW_HEADERS["content-security-policy"], /form-action 'none'/);
  assert.equal(PREVIEW_HEADERS["referrer-policy"], "no-referrer", "the private link doesn't leak to the sites pictures come from");
});

test("the email: says who's writing, what it'd save, that nothing changed, and how to say no", () => {
  const mail = emailFor(
    { business: "Crumb Bakery", host: "crumb.example", platform: "Squarespace", expires_at: new Date("2026-12-02T00:00:00Z") },
    { preview: "https://grove.test/preview/abc/", no: "https://grove.test/preview/abc/no" },
    { name: "Chris", legal: "Grove Ltd", contact: "hello@grove.test" },
  );
  assert.equal(mail.subject, "A free copy of the Crumb Bakery website");
  assert.match(mail.body, /Squarespace plans cost from about £12 a month/);
  assert.match(mail.body, /Nothing has changed on your current site/);
  assert.match(mail.body, /https:\/\/grove\.test\/preview\/abc\/no/);
  assert.match(mail.body, /deletes itself on 2026-12-02/);
  assert.match(mail.body, /Grove Ltd · hello@grove\.test$/);
  const unknown = emailFor({ business: "X", host: "x.example", platform: null, expires_at: new Date() }, { preview: "p", no: "n" }, { name: "Chris" });
  assert.doesNotMatch(unknown.body, /from about £/, "no figure when the platform's cost isn't known");
});
