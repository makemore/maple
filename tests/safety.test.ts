// The checks that stop abuse rather than flag it: names, throwaway addresses, new accounts, ship checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { aiReview, blocking, dangerousUrls, disposable, nameProblem, outsideUrls, publicText, trustOf } from "../grove/src/safety.ts";
import { withoutOutsideLinks } from "../kit/pages.ts";

test("throwaway email addresses are spotted; ordinary ones aren't", () => {
  for (const e of ["a@mailinator.com", "b@yopmail.com", "c@sub.guerrillamail.com", "d@10minutemail.com"]) assert.ok(disposable(e), e);
  for (const e of ["a@gmail.com", "b@riverrowing.club", "c@outlook.com"]) assert.ok(!disposable(e), e);
});

test("app names can't borrow a big brand to trick people, but ordinary names are fine", () => {
  for (const [n, t] of [["paypal", "PayPal"], ["paypal-login", "Account"], ["secure-hsbc", "HSBC"], ["netflix-billing", "Billing"], ["hmrc-refunds", "Tax refund"], ["natwest", "x"], ["club", "Monzo support"], ["my-bank-login", "Login"]]) assert.ok(nameProblem(n, t), `${n} / ${t}`);
  for (const [n, t] of [["apple-crumble-bakery", "Apple Crumble Bakery"], ["river-rowing", "River Rowing"], ["member-login", "Members"], ["amazon-rainforest-trust", "Amazon Rainforest Trust"], ["fees", "Club fees"]]) assert.equal(nameProblem(n, t), undefined, `${n} / ${t}`);
});

test("shipping is refused for passwords, card forms, wallet phrases and brand account checks", () => {
  assert.deepEqual(blocking({ "src/app.ts": "export const schema = `create table if not exists t (id serial)`;", "src/maple/pages.ts": '<input type="password">' }), []);
  assert.match(blocking({ "src/p.ts": '`<input type="password" name="p">`' })[0], /password box/);
  assert.match(blocking({ "src/p.ts": "`<form><label>Card number</label><input></form>`" })[0], /card or bank/);
  assert.match(blocking({ "src/p.ts": "`<textarea placeholder='Enter your recovery phrase'></textarea>`" })[0], /recovery phrase/);
  assert.match(blocking({ "src/p.ts": "`<p>Your PayPal account is suspended. Verify your account below.</p><form><input name=e></form>`" }).join(" "), /verify an account with PayPal/);
  assert.deepEqual(blocking({ "src/p.ts": "`<p>We take card payments and PayPal at the counter.</p><form><input name=email></form>`" }), []);
});

test("outside links are collected, without the app's own or Grove's", () => {
  const urls = outsideUrls({ "src/app.ts": "`<a href=\"https://evil.example/x?y=1\">x</a> https://grove.example/files/1 https://me.grovehelper.com/a`", "package.json": "https://registry.npmjs.org/x", "src/maple/kit.ts": "https://kit.example" }, ["grove.example", "grovehelper.com"]);
  assert.deepEqual(urls, ["https://evil.example/x?y=1"]);
});

test("Safe Browsing: matches come back; no key means no check", async () => {
  assert.deepEqual(await dangerousUrls(["https://a.example"], undefined), []);
  let sent: any;
  const fake = (async (_u: string, init: any) => ((sent = JSON.parse(init.body)), new Response(JSON.stringify({ matches: [{ threat: { url: "https://bad.example/" } }] })))) as any;
  assert.deepEqual(await dangerousUrls(["https://bad.example/", "https://ok.example/"], "k", fake), ["https://bad.example/"]);
  assert.equal(sent.threatInfo.threatEntries.length, 2);
});

test("AI review: off without a key, reads the verdict, and holds when the model declines", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(await aiReview("<p>hi</p>"), undefined);
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
  let asked: any;
  const client = (answer: any) => ({ beta: { messages: { create: async (req: any) => ((asked = req), answer) } } }) as any;
  assert.deepEqual(await aiReview("<p>Cakes</p>", client({ stop_reason: "end_turn", content: [{ type: "text", text: '{"verdict":"ok","why":"A bakery."}' }] })), { verdict: "ok", why: "A bakery." });
  assert.equal(asked.model, "claude-opus-5-5");
  assert.equal(asked.output_config.format.type, "json_schema");
  assert.equal(asked.fallbacks, "default");
  assert.equal((await aiReview("<form>", client({ stop_reason: "refusal", content: [] })))?.verdict, "hold");
});

test("public text: HTML in the app's code, without styling noise, cut to size", () => {
  const t = publicText({ "src/app.ts": 'export const home = () => `<html><style>.x{}</style><h1 class="big" style="color:red">Cakes</h1></html>`;', "src/db.ts": "export const q = 'select 1';" });
  assert.match(t, /--- src\/app\.ts ---/);
  assert.match(t, /<h1>Cakes<\/h1>/);
  assert.doesNotMatch(t, /db\.ts|style/);
  assert.ok(publicText({ "a.ts": "<p>" + "x".repeat(100) + "</p>" }, 50).endsWith("[cut short]"));
});

test("new accounts: links elsewhere switched off, pages kept out of search engines", () => {
  const html = '<html><head></head><body><a href="https://evil.example/">go</a><a href="/menu">menu</a><a href="https://club.grovehelper.com/x">mine</a><a href="mailto:a@b.c">mail</a><form action="https://evil.example/steal"></form><meta http-equiv="refresh" content="0;url=https://evil.example"></body></html>';
  const out = withoutOutsideLinks(html, ["club.grovehelper.com"]);
  assert.doesNotMatch(out, /evil\.example/);
  assert.match(out, /<a data-link-off="new account"[^>]*>go<\/a>/);
  assert.match(out, /href="\/menu"/);
  assert.match(out, /href="https:\/\/club\.grovehelper\.com\/x"/);
  assert.match(out, /href="mailto:a@b\.c"/);
  assert.match(out, /action="#"/);
  assert.match(out, /<meta name="robots" content="noindex, nofollow">\n<\/head>/);
});

test("trust: new accounts are limited; time, paying, owning a site or being Grove's maker lifts it; reports bring it back", async () => {
  const pool = (r: any) => ({ query: async () => ({ rows: [r] }) }) as any;
  const base = { days: 0.5, owns: false, grove_maker: false, reported: 0 };
  assert.equal((await trustOf(pool(base), "a@b.c", { paid: false })).trusted, false);
  assert.equal((await trustOf(pool({ ...base, days: 4 }), "a@b.c", { paid: false })).trusted, true);
  assert.equal((await trustOf(pool(base), "a@b.c", { paid: true })).trusted, true);
  assert.equal((await trustOf(pool({ ...base, owns: true }), "a@b.c", { paid: false })).trusted, true);
  assert.equal((await trustOf(pool({ ...base, grove_maker: true }), "a@b.c", { paid: false })).trusted, true);
  assert.equal((await trustOf(pool({ ...base, days: 30, reported: 1 }), "a@b.c", { paid: true })).trusted, false);
});
