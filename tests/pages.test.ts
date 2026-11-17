// The pages people see: Grove's front page, the terms and privacy pages, and the kit's sign-in pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { consentPage, homePage, signInPage } from "../kit/pages.ts";
import { TERMS_VERSION, agree, agreed, privacyPage, termsOn, termsPage } from "../grove/src/legal.ts";
import { sitePage } from "../grove/src/site.ts";

const MCP = "https://grove.example/mcp";
const sound = (html: string) => {
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /undefined|\[object Object\]|\$\{/, "nothing unfilled is left in the page");
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<title>[^<]+<\/title>/);
};
const legalOff = () => {
  delete process.env.GROVE_LEGAL_NAME;
  delete process.env.GROVE_CONTACT_EMAIL;
};
const legalOn = () => Object.assign(process.env, { GROVE_LEGAL_NAME: "Example Ltd", GROVE_CONTACT_EMAIL: "hello@grove.example" });

test("front page: sound HTML with one main heading and the sections the menu links to", () => {
  const html = sitePage(MCP, 5);
  sound(html);
  assert.equal(html.match(/<h1[ >]/g)?.length, 1);
  for (const id of ["main", "how", "make", "get", "yours", "safe", "connect", "chatgpt", "price", "faq", "invite"]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const [, target] of html.matchAll(/href="#([a-z-]+)"/g)) assert.match(html, new RegExp(`id="${target}"`), `#${target} goes somewhere`);
});

test("front page: the Claude button fills in Grove's name and address", () => {
  const link = sitePage(MCP, 5).match(/href="(https:\/\/claude\.ai[^"]+)"/)![1];
  const url = new URL(link);
  assert.equal(url.pathname, "/customize/connectors");
  assert.equal(url.searchParams.get("modal"), "add-custom-connector");
  assert.equal(url.searchParams.get("connectorName"), "Grove");
  assert.equal(url.searchParams.get("connectorUrl"), MCP);
});

test("front page: ChatGPT gets the address to copy", () => {
  assert.match(sitePage(MCP, 5), new RegExp(`data-copy="${MCP}"`));
});

test("front page: shows the paid plan only when there is one", () => {
  const free = sitePage(MCP, 3);
  assert.match(free, /Up to 3 small apps/);
  assert.doesNotMatch(free, /<h3>Plus<\/h3>/);
  const paid = sitePage(MCP, 3, { price: "£12 a month", apps: 25 });
  assert.match(paid, /<h3>Plus<\/h3>\s*<p class="big">£12 a month<\/p>/);
  assert.match(paid, /Up to 25 small apps/);
  sound(paid);
});

test("front page: the example at the top plays in steps, and every step up to the last has something to show", () => {
  const html = sitePage(MCP, 5);
  const last = Number(html.match(/id="demo" data-last="(\d+)"/)![1]);
  const steps = new Set([...html.matchAll(/data-step="(\d+)"/g)].map((m) => Number(m[1])));
  for (let n = 0; n <= last; n++) assert.ok(steps.has(n), `step ${n}`);
  assert.equal(Math.max(...steps), last);
  const chapters = [...html.matchAll(/data-go="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(chapters, [...chapters].sort((a, b) => a - b), "chapters go forwards");
  assert.equal(chapters[0], 0);
  assert.equal(chapters.at(-1), last);
  assert.match(html, /id="demo-play"/, "it can be paused");
});

test("front page: the example shows a database of linked tables, tools for the assistant and web addresses", () => {
  const html = sitePage(MCP, 5);
  const tables = [...html.matchAll(/<li data-step="\d+"(?: class="read")?><strong>([a-z_]+)<\/strong>/g)].map((m) => m[1]);
  assert.deepEqual(tables, ["customers", "products", "orders", "order_items", "stock"]);
  for (const [, target] of html.matchAll(/<em>[a-z_]+ → ([a-z_]+)<\/em>/g)) assert.ok(tables.includes(target), `${target} is a table shown`);
  assert.equal((html.match(/class="read"/g) ?? []).length, 4, "the last answer reads four tables, as it says");
  assert.match(html, /5 linked tables and 6 tools/);
  assert.equal(html.match(/<ul class="chips">(.*?)<\/ul>/s)![1].split("<li>").length - 1, 6);
  assert.match(html, /an MCP server/);
  assert.match(html, /POST \/hooks\/website-order/);
});

test("front page: only says open source when there is public code to point at", () => {
  const closed = sitePage(MCP, 5);
  assert.doesNotMatch(closed, /open source/i);
  assert.doesNotMatch(closed, /github/i);
  const open = sitePage(MCP, 5, undefined, "https://github.com/example/maple");
  assert.match(open, /MAPLE[^<]*MIT licence/);
  assert.match(open, /Grove itself is under the AGPL/);
  assert.equal(open.match(/href="https:\/\/github\.com\/example\/maple"/g)?.length, 3, "in the menu, the section and the footer");
  assert.match(open, /aria-label="Grove and MAPLE on GitHub"/, "the icon in the menu has a name");
  sound(open);
});

test("front page: says what a free app carries and what paying takes off", () => {
  const html = sitePage(MCP, 5, { price: "£12 a month", apps: 25 });
  assert.match(html, /"Made with Grove" line on each app's pages/);
  assert.match(html, /No Grove line on your apps' pages/);
});

test("front page: links to the terms and privacy pages", () => {
  const html = sitePage(MCP, 5);
  assert.match(html, /href="\/terms"/);
  assert.match(html, /href="\/privacy"/);
});

test("terms and privacy: drafts until who runs Grove is set, and nobody is asked to agree", async () => {
  legalOff();
  assert.equal(termsOn(), false);
  for (const html of [termsPage(), privacyPage()]) {
    sound(html);
    assert.match(html, /class="draft"/);
  }
  const pool = { query: async () => assert.fail("no need to look anyone up") } as any;
  assert.equal(await agreed(pool, "a@b.c"), true);
});

test("terms and privacy: final once set, naming who runs Grove and how to reach them", () => {
  legalOn();
  assert.equal(termsOn(), true);
  for (const html of [termsPage(), privacyPage()]) {
    sound(html);
    assert.doesNotMatch(html, /class="draft"/);
    assert.match(html, /Example Ltd/);
    assert.match(html, /mailto:hello@grove\.example/);
    assert.match(html, new RegExp(`Version ${TERMS_VERSION}`));
  }
  legalOff();
});

test("agreeing: recorded against the current version, and asked again for a new one", async () => {
  legalOn();
  const rows = new Set<string>();
  const pool = {
    query: async (sql: string, [email, version]: string[]) => {
      if (sql.startsWith("insert")) rows.add(`${email}|${version}`);
      return { rowCount: rows.has(`${email}|${version}`) ? 1 : 0 };
    },
  } as any;
  assert.equal(await agreed(pool, "a@b.c"), false);
  await agree(pool, "a@b.c");
  assert.equal(await agreed(pool, "a@b.c"), true);
  assert.equal(await agreed(pool, "someone@else.com"), false);
  assert.deepEqual([...rows], [`a@b.c|${TERMS_VERSION}`]);
  legalOff();
});

test("kit pages: sign-in, consent and the signed-in page are sound and carry the app's name", () => {
  for (const html of [signInPage("Club Helper", "https://auth.example"), consentPage("Club Helper", "https://auth.example"), homePage("Club Helper", "https://auth.example", "https://club.example/mcp")]) {
    sound(html);
    assert.match(html, /Club Helper/);
  }
  assert.match(homePage("Club Helper", "https://auth.example", "https://club.example/mcp"), /https:\/\/club\.example\/mcp/);
});

test("kit pages: an app's name can't inject HTML", () => {
  for (const html of [signInPage("<script>alert(1)</script>", "https://auth.example"), homePage("<img src=x onerror=1>", "https://auth.example", "https://x.example/mcp")]) {
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>|<img src=x/);
  }
});
