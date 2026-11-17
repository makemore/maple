// Keeping Grove safe: limits, the code check, reports, the paused page and the line free apps carry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { groveBadge, withBadge } from "../kit/pages.ts";
import { appNamed, blockedWhy, buildsPerHour, concerns, mayNotify, pausedArchive, report, reportPage, underBuildLimit } from "../grove/src/guard.ts";

const answering = (...answers: any[]) => {
  const asked: { sql: string; args: any[] }[] = [];
  return { asked, query: async (sql: string, args: any[] = []) => (asked.push({ sql, args }), answers.shift() ?? { rows: [], rowCount: 0 }) } as any;
};

test("build limit: fine under it, refused at it, and higher on the paid plan", async () => {
  assert.equal(buildsPerHour(false), 30);
  assert.equal(buildsPerHour(true), 120);
  await underBuildLimit(answering({ rows: [{ n: 29 }] }), "a@b.c", false);
  await assert.rejects(underBuildLimit(answering({ rows: [{ n: 30 }] }), "a@b.c", false), /limit on the free plan/);
  await underBuildLimit(answering({ rows: [{ n: 30 }] }), "a@b.c", true);
  await assert.rejects(underBuildLimit(answering({ rows: [{ n: 120 }] }), "a@b.c", true), /limit\./);
});

test("email limit: an app's emails are counted per day and stop at the limit", async () => {
  assert.equal(await mayNotify(answering({ rows: [{ n: 0 }] }), "club"), true);
  assert.equal(await mayNotify(answering({ rows: [{ n: 49 }] }), "club"), true);
  assert.equal(await mayNotify(answering({ rows: [{ n: 50 }] }), "club"), false);
});

test("blocked people: the reason comes back, and nothing for everyone else", async () => {
  assert.equal(await blockedWhy(answering({ rows: [{ why: "sending spam" }] }), "a@b.c"), "sending spam");
  assert.equal(await blockedWhy(answering({ rows: [] }), "a@b.c"), undefined);
});

test("code check: ordinary app code raises nothing", () => {
  assert.deepEqual(concerns({ "src/app.ts": "export const schema = `create table if not exists fees (id serial, paid boolean)`;\n// card games night, account for who paid", "README.md": "# Club Helper" }), []);
});

test("code check: password boxes, card forms and wallet phrases are flagged, with the file", () => {
  const password = concerns({ "src/pages.ts": 'export const p = `<form><input type="password" name="p"></form>`;' });
  assert.equal(password.length, 1);
  assert.match(password[0], /src\/pages\.ts has a password box/);
  assert.match(concerns({ "src/pay.ts": "`<form><label>Card number</label><input name=c><label>CVV</label><input name=v></form>`" })[0], /card or bank details/);
  assert.match(concerns({ "src/w.ts": "`<p>Enter your seed phrase</p><textarea></textarea>`" })[0], /recovery phrase/);
});

test("code check: a password box beside a well-known company's name is flagged as that", () => {
  const found = concerns({ "src/login.ts": "`<h1>Sign in to PayPal</h1><input type='password'>`" });
  assert.ok(found.some((f) => /well-known company \(PayPal\)/.test(f)), found.join("; "));
});

test("code check: the kit's own files are not looked at", () => {
  assert.deepEqual(concerns({ "src/maple/pages.ts": '<input type="password">' }), []);
});

test("reports: a new one is recorded, cut to size, and the same open one is not recorded twice", async () => {
  const pool = answering({ rows: [{ n: 0 }] }, { rowCount: 1 });
  assert.equal(await report(pool, "club", "x".repeat(5000), "ana@example.com"), true);
  assert.equal(pool.asked[1].args[1].length, 2000);
  assert.match(pool.asked[1].sql, /where not exists/);
  assert.equal(await report(answering({ rows: [{ n: 0 }] }, { rowCount: 0 }), "club", "same again"), false);
});

test("reports: the public can't flood them, and Grove's own check is never held back", async () => {
  const full = answering({ rows: [{ n: 100 }] });
  assert.equal(await report(full, "club", "spam spam", "x@y.z"), false);
  assert.equal(full.asked.length, 1, "nothing was written");
  assert.equal(await report(answering({ rows: [{ n: 100 }] }, { rowCount: 1 }), "club", "has a password box", "Grove check"), true);
});

test("reports: the app is found from a name, an address or a link", () => {
  for (const typed of ["club-helper", " Club-Helper ", "club-helper.grovehelper.com", "https://club-helper.grovehelper.com/auth/sign-in?x=1"]) assert.equal(appNamed(typed), "club-helper", typed);
});

test("report page: a sound form, and what someone typed can't inject HTML", () => {
  const html = reportPage('"><script>alert(1)</script>', "<b>hi</b>");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<form method="post" action="\/report">/);
  for (const id of ["app", "what", "email"]) assert.match(html, new RegExp(`<label for="${id}">`), id);
  assert.doesNotMatch(html, /<script>alert|<b>hi<\/b>/);
});

test("paused page: runs as a function and answers 503 without the app's code", async () => {
  const archive = pausedArchive("Club <Helper>", "https://grove.example");
  assert.deepEqual(Object.keys(archive), ["index.mjs"]);
  const mod = await import("data:text/javascript;base64," + Buffer.from(archive["index.mjs"]).toString("base64"));
  const res: Response = mod.default.fetch(new Request("https://club.example/anything"));
  assert.equal(res.status, 503);
  assert.match(res.headers.get("content-type")!, /text\/html/);
  const html = await res.text();
  assert.match(html, /This app is paused/);
  assert.doesNotMatch(html, /Club <Helper>/, "the title is escaped");
});

test("badge: says what Grove is, links back with the app's name, and offers a way to report", () => {
  const badge = groveBadge("https://grove.example", "club-helper");
  assert.match(badge, /Made with <a href="https:\/\/grove\.example\/\?from=club-helper"/);
  assert.match(badge, /href="https:\/\/grove\.example\/report\?app=club-helper"[^>]*>Report this app</);
});

test("badge: goes at the end of a page's body, or after a page that has none", () => {
  assert.equal(withBadge("<html><body><p>hi</p></body></html>", "[B]"), "<html><body><p>hi</p>[B]\n</body></html>");
  assert.equal(withBadge("<p>hi</p>", "[B]"), "<p>hi</p>[B]");
});
