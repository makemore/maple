// Grove's front page: what Grove and MAPLE are, for people who don't write software.
// Served by Grove itself at "/", so the site that explains MAPLE apps is one.
// The script lives in a template string: no backticks or ${} inside it.
import { ICON_SVG } from "../../kit/pages.ts";
import { SERVICE_LIST } from "../../kit/services.ts";

const SCRIPT = `
const form = document.getElementById("invite-form");
const msg = document.getElementById("invite-msg");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  msg.textContent = "Sending...";
  try {
    const res = await fetch("/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.email.value.trim(), idea: form.idea.value.trim() }),
    });
    const d = await res.json().catch(() => ({}));
    msg.textContent = d.message || (res.ok ? "Thanks. You're on the list." : "That didn't go through. Please try again.");
    if (res.ok) form.reset();
  } catch {
    msg.textContent = "That didn't go through. Check your connection and try again.";
  }
  button.disabled = false;
});
for (const b of document.querySelectorAll("[data-copy]")) {
  b.addEventListener("click", async () => {
    const said = b.parentElement.querySelector("[role=status]");
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      said.textContent = "Copied.";
    } catch {
      said.textContent = "Couldn't copy. Select the address and copy it by hand.";
    }
  });
}
// The example at the top plays through one story a step at a time. Without this script the finished state simply shows.
const demo = document.getElementById("demo");
const parts = [...demo.querySelectorAll("[data-step]")];
const chapters = [...demo.querySelectorAll("[data-go]")];
const play = document.getElementById("demo-play");
const LAST = Number(demo.dataset.last);
let now = 0, timer = 0;
const at = (n) => {
  now = n;
  for (const el of parts) {
    const on = n >= Number(el.dataset.step) && (!el.dataset.until || n < Number(el.dataset.until));
    el.classList.toggle("off", !on);
  }
  demo.classList.toggle("asking", n >= LAST);
  const current = chapters.filter((c) => Number(c.dataset.go) <= n).pop();
  for (const c of chapters) c.setAttribute("aria-current", String(c === current));
};
const stop = () => {
  clearInterval(timer);
  timer = 0;
  play.textContent = now >= LAST ? "Replay" : "Play";
};
const start = () => {
  if (now >= LAST) at(0);
  play.textContent = "Pause";
  timer = setInterval(() => {
    at(now + 1);
    if (now >= LAST) stop();
  }, 2400);
};
demo.classList.add("live");
demo.querySelector(".chapters").hidden = false;
play.addEventListener("click", () => (timer ? stop() : start()));
for (const c of chapters) c.addEventListener("click", () => { stop(); at(Number(c.dataset.go)); play.textContent = now >= LAST ? "Replay" : "Play"; });
if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  at(LAST);
  stop();
} else {
  at(0);
  start();
}
`;

const CSS = `
:root {
  --ink: #1c2a1e; --soft: #4d5e51; --line: #d8dfd9; --bg: #f6f4ec; --card: #fffdf7;
  --brand: #1f5135; --brand-ink: #fff; --leaf: #f2a541; --tint: #e7efe6; --deep: #173d28; --deep-ink: #eef5ef; --deep-soft: #b9cfc0;
}
@media (prefers-color-scheme: dark) {
  :root { --ink: #e8eee9; --soft: #a9b8ac; --line: #34433a; --bg: #121a15; --card: #1a241e; --brand: #7fcb9c; --brand-ink: #0f1a13; --tint: #1f2c24; --deep: #0c130f; --deep-ink: #e8eee9; --deep-soft: #a9b8ac; }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { scroll-behavior: smooth; scroll-padding-top: 1rem; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body { margin: 0; font: 1.125rem/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
h1, h2, h3 { font-family: ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif; line-height: 1.15; text-wrap: balance; }
h1 { font-size: clamp(2.25rem, 6.5vw, 3.75rem); margin: 0 0 .45em; letter-spacing: -.02em; }
h2 { font-size: clamp(1.6rem, 4.2vw, 2.4rem); margin: 0 0 .5em; letter-spacing: -.01em; }
h3 { font-size: 1.15rem; margin: 0 0 .3em; }
p { margin: 0 0 1em; }
a { color: var(--brand); text-underline-offset: .2em; }
:focus-visible { outline: 3px solid var(--leaf); outline-offset: 3px; border-radius: 4px; }
.wrap { max-width: 66rem; margin-inline: auto; padding-inline: 1rem; }
.skip { position: absolute; left: -999px; }
.skip:focus { left: 1rem; top: 1rem; background: var(--card); padding: .5rem 1rem; z-index: 2; }
header.top { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; padding-block: 1rem; }
.logo { display: flex; align-items: center; gap: .6rem; font-weight: 700; font-size: 1.3rem; color: var(--ink); text-decoration: none; margin-right: auto; }
.logo svg { width: 2.25rem; height: 2.25rem; }
nav ul { display: flex; gap: .25rem 1.25rem; flex-wrap: wrap; list-style: none; margin: 0; padding: 0; font-size: 1rem; }
nav a { display: inline-block; padding: .4rem 0; text-decoration: none; color: var(--soft); font-weight: 600; }
.gh { display: inline-flex !important; align-items: center; gap: .5rem; }
nav a.gh { color: var(--ink); }
nav a:hover { color: var(--brand); text-decoration: underline; }
section { padding-block: clamp(3rem, 8vw, 5.5rem); }
.kicker { font-size: .95rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--brand); margin: 0 0 .6rem; }
.intro { font-size: 1.2rem; color: var(--soft); max-width: 42rem; margin-bottom: 0; }
.hero { padding-top: clamp(1.5rem, 5vw, 3.5rem); padding-bottom: clamp(1.5rem, 4vw, 2.5rem); text-align: center; }
.hero .lede { margin-inline: auto; }
.hero .actions { justify-content: center; }
.lede { font-size: 1.3rem; color: var(--soft); max-width: 42rem; }
.actions { display: flex; gap: .75rem; flex-wrap: wrap; margin-top: 1.5rem; align-items: center; }
.btn { display: inline-block; font: inherit; font-weight: 600; padding: .8rem 1.35rem; border-radius: 999px; border: 2px solid var(--brand); background: var(--brand); color: var(--brand-ink); text-decoration: none; cursor: pointer; }
.btn:hover { filter: brightness(1.08); }
.btn.quiet { background: transparent; color: var(--brand); }
.btn.small { padding: .45rem .9rem; font-size: 1rem; }
.btn:disabled { opacity: .6; cursor: default; }
.already { margin-top: 1.25rem; font-size: 1rem; color: var(--soft); }
.already a { font-weight: 600; }
.note { color: var(--soft); font-size: 1rem; }

.stage { margin: 0 0 clamp(2rem, 5vw, 3rem); background: var(--card); border: 1px solid var(--line); border-radius: 1.5rem; padding: 1rem; box-shadow: 0 2rem 4rem -2rem rgb(31 81 53 / .4); text-align: left; }
.chapters { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; margin-bottom: 1rem; }
.chapters button { font: inherit; font-size: .95rem; font-weight: 600; padding: .4rem .85rem; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--soft); cursor: pointer; }
.chapters button[aria-current=true] { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); }
.chapters #demo-play { margin-left: auto; color: var(--brand); border-color: var(--brand); min-width: 5.5rem; }
.panes { display: grid; gap: 1rem; }
@media (min-width: 56rem) { .panes { grid-template-columns: .9fr 1.1fr; } }
.pane { border: 1px solid var(--line); border-radius: 1.1rem; overflow: hidden; display: flex; flex-direction: column; background: var(--bg); }
.bar { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; padding: .6rem .9rem; border-bottom: 1px solid var(--line); font-size: .9rem; font-weight: 700; background: var(--card); min-height: 2.9rem; }
.bar small { font-weight: 400; color: var(--soft); font-size: .85rem; }
.bar code { border: 0; background: transparent; padding: 0; font-size: .9rem; }
.pill { margin-left: auto; font-size: .8rem; font-weight: 700; padding: .15rem .6rem; border-radius: 999px; background: var(--tint); color: var(--soft); }
.pill.go { background: var(--brand); color: var(--brand-ink); }
.talk { display: flex; flex-direction: column; gap: .55rem; justify-content: flex-end; padding: .9rem; }
.stage.live .talk { flex: 1; min-height: 0; overflow: hidden; }
.stage.live .pane { height: 24rem; }
.stage.live .pane + .pane { height: auto; min-height: 34rem; }
@media (min-width: 56rem) { .stage.live .pane, .stage.live .pane + .pane { height: 46rem; min-height: 0; } }
.talk p { margin: 0; padding: .65rem .95rem; border-radius: 1.1rem; max-width: 92%; font-size: .98rem; line-height: 1.45; flex-shrink: 0; }
.talk .who { display: block; font-size: .75rem; font-weight: 700; color: var(--soft); }
.talk .you { background: var(--tint); align-self: flex-end; border-bottom-right-radius: .3rem; }
.talk .app { background: var(--card); border: 1px solid var(--line); align-self: flex-start; border-bottom-left-radius: .3rem; }
.made { padding: .9rem; display: grid; gap: .75rem; align-content: start; }
.stage.live .made { flex: 1; min-height: 0; overflow: hidden; }
.box { background: var(--card); border: 1px solid var(--line); border-radius: .9rem; padding: .75rem .85rem; }
.label { margin: 0 0 .5rem; font-size: .8rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--soft); }
.label small { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: .85rem; }
.tables { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); }
.tables li { border: 1px solid var(--line); border-radius: .6rem; padding: .45rem .6rem; font-size: .82rem; line-height: 1.45; color: var(--soft); font-family: ui-monospace, "SF Mono", Menlo, monospace; transition: border-color .4s, box-shadow .4s; }
.tables strong { display: block; color: var(--ink); font-size: .88rem; }
.tables em { font-style: normal; color: var(--brand); }
.stage.asking .tables .read { border-color: var(--leaf); box-shadow: 0 0 0 2px var(--leaf); }
.chips { list-style: none; margin: 0; padding: 0; display: flex; gap: .4rem; flex-wrap: wrap; }
.chips li { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .82rem; padding: .2rem .55rem; border-radius: .5rem; background: var(--tint); }
.routes { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; font-size: .9rem; color: var(--soft); }
.routes code { font-size: .82rem; margin-right: .4rem; }
.tag { font-size: .75rem; font-weight: 700; padding: .1rem .5rem; border-radius: 999px; border: 1px dashed var(--soft); color: var(--soft); white-space: nowrap; }
.services h3 .tag { margin-left: .5rem; vertical-align: middle; }
.tag.go { border: 0; background: var(--brand); color: var(--brand-ink); }
.reads { margin: 0; font-size: .9rem; color: var(--soft); border-left: 3px solid var(--leaf); padding-left: .7rem; }
.stage figcaption { font-size: .9rem; color: var(--soft); text-align: center; margin-top: .9rem; }
.stage.live .off, .stage:not(.live) .passing { display: none; }
@media (prefers-reduced-motion: no-preference) {
  .stage.live [data-step] { animation: arrive .45s ease-out; }
  @keyframes arrive { from { opacity: 0; transform: translateY(.5rem); } }
}
.inside { list-style: none; margin: 0 0 clamp(2rem, 5vw, 3rem); padding: 0; display: grid; gap: 1.25rem 2rem; grid-template-columns: repeat(auto-fit, minmax(12.5rem, 1fr)); }
.inside strong { display: block; font-family: ui-rounded, system-ui, sans-serif; font-size: 1.15rem; }
.inside span { color: var(--soft); font-size: 1rem; }

.facts { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); background: var(--line); border: 1px solid var(--line); border-radius: 1.25rem; overflow: hidden; }
.facts li { background: var(--card); padding: 1.1rem 1.25rem; }
.facts strong { display: block; font-family: ui-rounded, system-ui, sans-serif; font-size: 1.35rem; line-height: 1.2; }
.facts span { color: var(--soft); font-size: 1rem; }

.band { background: var(--tint); }
.deep { background: var(--deep); color: var(--deep-ink); }
.deep .kicker { color: var(--leaf); }
.deep .intro, .deep .cards p { color: var(--deep-soft); }
.deep a { color: var(--leaf); }
.deep .cards li { background: transparent; border-color: rgb(255 255 255 / .18); }
.cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); list-style: none; padding: 0; margin: 2rem 0 0; }
.cards li { background: var(--card); border: 1px solid var(--line); border-radius: 1.1rem; padding: 1.35rem; }
.cards p { margin: 0; color: var(--soft); font-size: 1rem; }
.cards p + p { margin-top: .6rem; }
.cards.two { grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); }
.steps { counter-reset: step; }
.steps li { counter-increment: step; }
.steps h3::before { content: counter(step); display: grid; place-items: center; width: 2.2rem; height: 2.2rem; margin-bottom: .75rem; border-radius: 50%; background: var(--brand); color: var(--brand-ink); font-size: 1.05rem; }
.say { font-style: italic; color: var(--ink) !important; }
.say::before { content: "You say: "; font-style: normal; font-weight: 700; font-size: .85rem; color: var(--soft); display: block; }
.letter { display: inline-grid; place-items: center; width: 2rem; height: 2rem; border-radius: .6rem; background: var(--brand); color: var(--brand-ink); font-weight: 800; margin-right: .5rem; font-size: 1rem; }
.fit { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); margin-top: 2rem; }
.fit > div { background: var(--card); border: 1px solid var(--line); border-radius: 1.1rem; padding: 1.35rem; }
.fit ul { margin: .5rem 0 0; padding-left: 1.2rem; }
.fit li { margin-bottom: .35rem; }
.fit .no { border-style: dashed; }

.prices { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); margin-top: 2rem; max-width: 46rem; }
.price { background: var(--card); border: 1px solid var(--line); border-radius: 1.25rem; padding: 1.5rem; }
.price.best { border: 2px solid var(--brand); }
.price h3 { color: var(--soft); }
.price .big { font-size: 2.25rem; font-weight: 800; font-family: ui-rounded, system-ui, sans-serif; margin: 0; }
.price ul { padding-left: 1.2rem; margin: .5rem 0 1rem; }
.price li { margin-bottom: .3rem; }
.price p:last-child { margin: 0; color: var(--soft); font-size: 1rem; }

.connect { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); margin-top: 2rem; }
.connect > div { background: var(--card); border: 1px solid var(--line); border-radius: 1.1rem; padding: 1.35rem; }
.connect ol { padding-left: 1.3rem; margin: 0 0 1rem; }
.connect li { margin-bottom: .4rem; }
.copy { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
.copy [role=status] { font-size: 1rem; color: var(--soft); }
code { background: var(--card); border: 1px solid var(--line); border-radius: .4rem; padding: .1rem .4rem; font-size: .95em; overflow-wrap: anywhere; }

.faq { max-width: 46rem; margin-top: 1.5rem; }
details { border-bottom: 1px solid var(--line); }
summary { cursor: pointer; font-weight: 700; padding: 1rem 2rem 1rem 0; list-style: none; position: relative; font-family: ui-rounded, system-ui, sans-serif; font-size: 1.1rem; }
summary::-webkit-details-marker { display: none; }
summary::after { content: "+"; position: absolute; right: .25rem; top: .8rem; font-size: 1.5rem; font-weight: 400; color: var(--brand); }
details[open] summary::after { content: "\\2212"; }
details p { color: var(--soft); max-width: 40rem; }

form { display: grid; gap: .75rem; max-width: 30rem; }
label { font-weight: 600; }
label span { font-weight: 400; color: var(--soft); }
input, textarea { font: inherit; width: 100%; padding: .75rem .9rem; border-radius: .75rem; border: 1px solid var(--soft); background: var(--card); color: var(--ink); }
#invite-msg { min-height: 1.65em; margin: 0; }
.invite { display: grid; gap: 2rem; align-items: start; }
@media (min-width: 52rem) { .invite { grid-template-columns: 1fr 1fr; } }
.deep input, .deep textarea { border-color: transparent; }
.deep .btn { background: var(--leaf); border-color: var(--leaf); color: #1c2a1e; }
.deep #invite-msg { color: var(--deep-soft); }

.doc { max-width: 44rem; padding-block: 2rem 4rem; }
.doc h2 { font-size: 1.3rem; margin-top: 2rem; }
.doc li { margin-bottom: .4rem; }
.draft { background: var(--tint); border: 1px solid var(--line); border-radius: .75rem; padding: .75rem 1rem; }
footer { padding-block: 2.5rem; color: var(--soft); font-size: 1rem; }
footer .wrap { display: flex; gap: 1rem 2rem; flex-wrap: wrap; justify-content: space-between; }
footer p { margin: 0; }
`;

/** A plain page in Grove's look, for the terms and privacy pages. */
export const shell = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)}</title>
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="top"><a class="logo" href="/">${ICON_SVG.replace("<svg ", '<svg aria-hidden="true" ')}Grove</a></header>
</div>
<main class="wrap doc">${body}</main>
</body>
</html>`;

// GitHub's mark, drawn in the text colour around it.
const GITHUB_SVG = `<svg aria-hidden="true" viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

const claudeLink = (connect: string) => `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Grove&connectorUrl=${encodeURIComponent(connect)}`;

const SERVICE_TITLES: Record<string, string> = { email: "Email", payments: "Payments", tasks: "Background work", files: "Files and photos", texts: "Text messages", ai: "AI inside the app", pdf: "PDFs" };

export type PaidPlan = { price: string; apps: number };

/** One line of the conversation in the example at the top: who says it, what, and the step it appears at. */
const says = (step: number, who: "you" | "app", text: string) =>
  `<p class="${who}" data-step="${step}"><span class="who">${who === "you" ? "You" : "Your assistant"}</span>${text}</p>`;

/** One table in the example's database: its name, its columns (an arrow marks a link to another table), the step it appears at, and whether the last question reads it. */
const table = (step: number, name: string, columns: string[], read = false) =>
  `<li data-step="${step}"${read ? ' class="read"' : ""}><strong>${name}</strong>${columns.map((c) => (c.includes("→") ? `<em>${c}</em>` : c)).join("<br>")}</li>`;

/**
 * The front page. connect is Grove's address for assistants, free is how many apps the free plan allows,
 * paid is the paid plan when there is one, and repo is where the code is public (the page only says
 * "open source" when it has somewhere to send people to read it).
 */
export const sitePage = (connect: string, free: number, paid?: PaidPlan, repo?: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grove: websites and apps you make by asking</title>
<meta name="description" content="Describe what you need in a sentence and Grove makes a website or app for it, from inside Claude or ChatGPT. Its own database, web pages, sign-in for your people, real code you can take away.">
<meta property="og:title" content="Grove: websites and apps you make by asking">
<meta property="og:description" content="Describe what you need in a sentence. Get a website or app with its own database, web pages and sign-in for your people, made from inside your AI assistant.">
<meta property="og:type" content="website">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<meta name="theme-color" content="#1f5135">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to the main part</a>
<div class="wrap">
  <header class="top">
    <a class="logo" href="/">${ICON_SVG.replace("<svg ", '<svg aria-hidden="true" ')}Grove</a>
    <nav aria-label="Main">
      <ul>
        <li><a href="#how">How it works</a></li>
        <li><a href="#make">What people make</a></li>
        <li><a href="#others">For others</a></li>
        <li><a href="#yours">It's yours</a></li>
        <li><a href="#price">Price</a></li>
        <li><a href="#connect">Add Grove</a></li>
        <li><a href="/account">Sign in</a></li>${repo ? `
        <li><a class="gh" href="${repo}" aria-label="Grove and MAPLE on GitHub">${GITHUB_SVG}</a></li>` : ""}
      </ul>
    </nav>
  </header>
</div>

<main id="main">
  <section class="wrap hero">
    <p class="kicker">Your own little app factory</p>
    <h1>Say what you need. Get a website or app that does it.</h1>
    <p class="lede">Grove turns a conversation with Claude, ChatGPT or any AI assistant into a real working website or app, with its own database, pages, tools and sign-in. Make them for yourself, or for the businesses and people around you. You never write code.</p>
    <div class="actions">
      <a class="btn" href="#connect">Start free</a>
      <a class="btn quiet" href="#how">See how it works</a>
      <a class="btn quiet" href="#others">Make them for others</a>
    </div>
    <p class="already">Open to everyone. <a href="${claudeLink(connect)}">Add Grove to Claude</a> or <a href="#chatgpt">add Grove to ChatGPT</a>.</p>
  </section>

  <div class="wrap">
    <figure class="stage" id="demo" data-last="9">
      <div class="chapters" hidden>
        <button type="button" data-go="0">1. Describe it</button>
        <button type="button" data-go="3">2. It's built</button>
        <button type="button" data-go="5">3. Extend it</button>
        <button type="button" data-go="9">4. Use it</button>
        <button type="button" id="demo-play">Pause</button>
      </div>
      <div class="panes">
        <div class="pane">
          <div class="bar">Your AI assistant <small>Claude, ChatGPT or another, with Grove added</small></div>
          <div class="talk">
            ${says(0, "you", "I run a small coffee roastery. I need to keep track of wholesale customers, their orders and our stock, and know what to roast each week.")}
            ${says(1, "app", "I'll build that with Grove. Setting up the database and the tools now.")}
            ${says(3, "app", "Done. Roastery Helper is live, with 5 linked tables and 6 tools. Who should be able to use it?")}
            ${says(4, "you", "Me and Dana. Also, orders come in from our website.")}
            ${says(5, "app", "I've added a web address your website can send orders to, and a public page for trade customers. It's on a trial copy with a copy of your data, so nothing live has changed. Want to try it?")}
            ${says(6, "you", "It works. Make it live.")}
            ${says(7, "app", "It's live. If you change your mind, I can undo it.")}
            ${says(8, "you", "What should we roast this week?")}
            ${says(9, "app", "From 14 open orders and what's in stock: Ethiopia 18 kg, Colombia 12 kg, Decaf 4 kg. Two customers haven't paid for last month. Shall I draft reminders?")}
          </div>
        </div>
        <div class="pane">
          <div class="bar">
            <span data-step="1">Roastery Helper</span>
            <code data-step="3">roastery.grovehelper.com</code>
            <span class="pill passing" data-step="1" data-until="3">Building</span>
            <span class="pill go" data-step="3">Live</span>
          </div>
          <div class="made">
            <div class="box" data-step="1">
              <p class="label">Database <small>its own Postgres</small></p>
              <ul class="tables">
                ${table(1, "customers", ["name", "email", "payment_terms"])}
                ${table(1, "products", ["name", "roast", "price_per_kg"], true)}
                ${table(2, "orders", ["customer → customers", "placed_at", "status"], true)}
                ${table(2, "order_items", ["order → orders", "product → products", "kg"], true)}
                ${table(2, "stock", ["product → products", "kg_on_hand"], true)}
              </ul>
            </div>
            <div class="box" data-step="3">
              <p class="label">Tools for your assistant <small>an MCP server, made for this app</small></p>
              <ul class="chips"><li>add_order</li><li>roast_plan</li><li>whats_low</li><li>unpaid_orders</li><li>customer_history</li><li>ask_the_maker</li></ul>
            </div>
            <div class="box" data-step="5">
              <p class="label">Web addresses <small>pages for people, an API for other software</small></p>
              <ul class="routes">
                <li><code>POST /hooks/website-order</code><span class="tag passing" data-step="5" data-until="6">trial copy</span><span class="tag go" data-step="6">live</span></li>
                <li><code>GET /api/stock</code>signed-in only</li>
                <li><code>GET /wholesale</code>a public page</li>
              </ul>
            </div>
            <p class="reads" data-step="9">Answered from four linked tables: orders, order_items, products and stock.</p>
          </div>
        </div>
      </div>
      <figcaption>An example of how it goes. The business and its numbers are made up.</figcaption>
    </figure>
    <ul class="inside">
      <li><strong>A real database</strong><span>Proper Postgres, with as many linked tables as the job needs. Not a spreadsheet behind a chat.</span></li>
      <li><strong>Its own tools</strong><span>Each app is an MCP server made for that one job, which any assistant that speaks MCP can use.</span></li>
      <li><strong>Web pages</strong><span>A front page, a form, a list that fills itself from the database. Public, or only for the people you name.</span></li>
      <li><strong>An API when you need one</strong><span>Web addresses other software can call, so your other tools can feed it.</span></li>
    </ul>
  </div>

  <div class="wrap">
    <ul class="facts">
      <li><strong>About 20 seconds</strong><span>from your sentence to something live</span></li>
      <li><strong>Its own database</strong><span>one per website or app, private to it</span></li>
      <li><strong>Real code you can keep</strong><span>download it whenever you like</span></li>
      <li><strong>Free for ${free} apps</strong><span>no card needed</span></li>
    </ul>
  </div>

  <section class="wrap" id="how">
    <p class="kicker">How it works</p>
    <h2>Three steps, all of them in a chat</h2>
    <p class="intro">You add Grove to your AI assistant once. After that, making a website or an app is a conversation.</p>
    <ol class="cards steps">
      <li><h3>Say what you need</h3><p>Describe the job the way you'd tell a person: what it should show or keep track of, and who it's for. A sentence or two is enough.</p></li>
      <li><h3>Grove makes it</h3><p>You get a real website or app with its own database and its own address. Anyone can visit the pages you make public, and each person you name can sign in and use it from their own assistant.</p></li>
      <li><h3>Use it, and grow it</h3><p>Ask it questions and tell it things. When you want more, say so. Every change is tried on a copy first, and can be undone after.</p></li>
    </ol>
  </section>

  <section class="band" id="make">
    <div class="wrap">
      <p class="kicker">What people make</p>
      <h2>The jobs nobody builds software for</h2>
      <p class="intro">Too small for a software project, too awkward for a spreadsheet. A simple website, a helper you talk to, or both at once on the same database.</p>
      <ul class="cards">
        <li><h3>A shop helper</h3><p class="say">"What's running low, and what did we sell most of this week?"</p><p>Stock, reorders and sales notes.</p></li>
        <li><h3>A club website</h3><p class="say">"Who hasn't paid for spring? Write them a reminder."</p><p>Fixtures and a sign-up form for everyone; members and fees for you.</p></li>
        <li><h3>A team helper</h3><p class="say">"What's due this week, and what's stuck?"</p><p>Jobs, who is on them, and what's blocking them.</p></li>
        <li><h3>A bookings website</h3><p class="say">"Who's coming tomorrow, and who hasn't confirmed?"</p><p>A page where customers ask for a slot, and a helper that keeps track of them.</p></li>
        <li><h3>A lettings helper</h3><p class="say">"Which repairs are still open at Mill Street?"</p><p>Properties, tenants, repairs and renewals.</p></li>
        <li><h3>A family helper</h3><p class="say">"When is the car due its MOT, and who's doing school pickup?"</p><p>Dates, chores and things not to forget.</p></li>
      </ul>
      <div class="fit">
        <div>
          <h3>A good fit</h3>
          <ul>
            <li>Keeping track of things and asking about them</li>
            <li>A simple website with a form, a list or a sign-up behind it</li>
            <li>Reminders and summaries that send themselves</li>
            <li>A handful of people who trust each other</li>
            <li>Rules that change as you learn what you need</li>
          </ul>
        </div>
        <div class="no">
          <h3>Not yet</h3>
          <ul>
            <li>Real card payments. You can build with pretend ones today</li>
            <li>Phone apps you get from an app store</li>
            <li>Medical records, or anything where a mistake could hurt someone</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="wrap" id="others">
    <p class="kicker">For other people too</p>
    <h2>Become a little app factory</h2>
    <p class="intro">You don't have to stop at your own jobs. Make websites and apps for the businesses, clubs and people around you, and look after them from your chat.</p>
    <ul class="cards two">
      <li><h3>Make it for them</h3><p>Hear what a business needs and build it in a conversation. Name their people, and they sign in and use it from their own assistant or its web pages.</p></li>
      <li><h3>They ask, you ship</h3><p>Anyone using it can ask you for a change, right from their chat. You try it on a copy, then make it live.</p></li>
      <li><h3>Charge what you like</h3><p>What you agree with them is your business. Grove takes no cut${paid ? `, and ${paid.price} covers up to ${paid.apps} of them with no Grove line on their pages` : ""}.</p></li>
      <li><h3>Hand it over whenever</h3><p>The code and the information can be downloaded and given to them. It runs without you, and without Grove.</p></li>
    </ul>
  </section>

  <section class="wrap" id="get">
    <p class="kicker">What every app gets</p>
    <h2>Five parts, already put together</h2>
    <p class="intro">Grove apps are built on MAPLE, an open format named after its five parts. You get all of them from the first minute.</p>
    <ul class="cards">
      <li><h3><span class="letter">M</span>Lives in your assistant</h3><p>You make it and run it by chatting. So do the people you share it with, each in their own assistant. Its web pages are there for everyone else.</p></li>
      <li><h3><span class="letter">A</span>Sign-in without passwords</h3><p>A code arrives by email. Only the people you name get in.</p></li>
      <li><h3><span class="letter">P</span>Its own database</h3><p>Your information is kept in a proper database that belongs to that one app.</p></li>
      <li><h3><span class="letter">L</span>A way to ask for more</h3><p>Anyone using the app can ask its maker for a change, right in the chat.</p></li>
      <li><h3><span class="letter">E</span>Email built in</h3><p>For sign-in codes and for those requests. Nothing to set up.</p></li>
      <li><h3><span class="letter">+</span>Trial copies and undo</h3><p>Grove adds these on top: every change is tried first, and anything shipped can be taken back.</p></li>
    </ul>
  </section>

  <section class="wrap" id="services">
    <p class="kicker">Built in</p>
    <h2>The awkward parts, already done</h2>
    <p class="intro">Normally these mean opening accounts, copying keys and reading manuals. In Grove your app just asks for them. Email and background work are real today. The rest can be built against now in a pretend mode that says clearly nothing real happened, and switch to the real thing as each arrives.</p>
    <ul class="cards services">
      ${SERVICE_LIST.map((x) => `<li><h3>${SERVICE_TITLES[x.name]}<span class="tag ${x.real ? "go" : "soon"}">${x.real ? "Ready" : "Pretend for now"}</span></h3><p>${x.what}</p></li>`).join("\n      ")}
    </ul>
  </section>

  <section class="deep" id="yours">
    <div class="wrap">
      <p class="kicker">It's yours</p>
      <h2>Real code, in an open format. No lock-in.</h2>
      <p class="intro">Most tools that make apps for you keep them. Grove makes ordinary code with an ordinary database, and hands you both whenever you ask.</p>
      <ul class="cards two">
        <li><h3>Take the code</h3><p>Ask Grove for a download and you get the whole app as files any developer can read and run.</p></li>
        <li><h3>Take the information</h3><p>Each app has its own database, and you can take a full copy of it at any time.</p></li>
        <li><h3>Run it elsewhere</h3><p>An app is a standard MAPLE app. It doesn't need Grove to keep working, so you can host it yourself.</p></li>
        <li><h3>${repo ? "Open source" : "An open format"}</h3><p>${repo ? `Both are open source. MAPLE, the part every app is made from, is under the MIT licence, so your apps are yours without conditions. Grove itself is under the AGPL: run your own, and share what you change.</p><p><a class="btn small gh" href="${repo}">${GITHUB_SVG} Grove and MAPLE on GitHub</a>` : "MAPLE is an open format with a published set of rules, so an app made here isn't tied to this company or this site."}</p></li>
      </ul>
    </div>
  </section>

  <section class="wrap" id="safe">
    <p class="kicker">Careful by design</p>
    <h2>Built so a mistake is easy to undo</h2>
    <p class="intro">Apps are written with the help of AI, and AI gets things wrong. Grove is made with that in mind.</p>
    <ul class="cards two">
      <li><h3>Try before it's live</h3><p>Every change goes to a trial copy of the app with a copy of your information. The live app only changes when you say so.</p></li>
      <li><h3>Undo</h3><p>Shipped something you regret? Go back to how it was before, in one sentence.</p></li>
      <li><h3>Checked before it's saved</h3><p>Code that doesn't hold together is refused before it gets anywhere near your app.</p></li>
      <li><h3>It tells you the cost</h3><p>Building uses your assistant's allowance. Grove keeps count, and stops to ask before a day's work gets large.</p></li>
    </ul>
  </section>

  <section class="band" id="connect">
    <div class="wrap">
      <p class="kicker">Add Grove</p>
      <h2>Add Grove to your assistant</h2>
      <p class="intro">You do this once. After that, you make and use your apps by chatting. Anyone can join, and it is free to start.</p>
      <div class="connect">
        <div>
          <h3>Claude</h3>
          <ol>
            <li>Press the button. Claude opens with Grove's name and address already filled in.</li>
            <li>Press <strong>Add</strong>, then <strong>Connect</strong>.</li>
            <li>Sign in with your email. A code arrives to confirm it is yours.</li>
          </ol>
          <p><a class="btn" href="${claudeLink(connect)}">Add Grove to Claude</a></p>
          <p class="note">Works on every Claude plan, in the browser and in the apps.</p>
        </div>
        <div id="chatgpt">
          <h3>ChatGPT</h3>
          <ol>
            <li>Copy Grove's address:
              <div class="copy"><code>${connect}</code><button class="btn quiet small" type="button" data-copy="${connect}">Copy</button><span role="status" aria-live="polite"></span></div>
            </li>
            <li>In ChatGPT, open <strong>Settings</strong>, then <strong>Apps &amp; Connectors</strong>. Under <strong>Advanced settings</strong>, turn on <strong>Developer mode</strong>.</li>
            <li>Press <strong>Create</strong>, name it Grove, paste the address, and sign in with your email.</li>
          </ol>
          <p><a class="btn" href="https://chatgpt.com/#settings/Connectors">Open ChatGPT's settings</a></p>
          <p class="note">ChatGPT has no one-press way to add an app yet, and needs a paid ChatGPT plan for this.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="wrap" id="price">
    <p class="kicker">Price</p>
    <h2>Free to start. One simple plan if you need more.</h2>
    <div class="prices">
      <div class="price">
        <h3>Free</h3>
        <p class="big">£0</p>
        <ul>
          <li>Up to ${free} small apps</li>
          <li>Share each one with the people you choose</li>
          <li>Trial copies, undo and requests included</li>
          <li>A small "Made with Grove" line on each app's pages</li>
        </ul>
        <p>No card needed.</p>
      </div>
      ${paid ? `<div class="price best">
        <h3>Plus</h3>
        <p class="big">${paid.price}</p>
        <ul>
          <li>Up to ${paid.apps} small apps</li>
          <li>Everything in Free</li>
          <li>No Grove line on your apps' pages</li>
          <li>Cancel whenever you like</li>
        </ul>
        <p>To move up, say "upgrade my plan" to Grove in your chat. It gives you a link to pay safely with Stripe.</p>
      </div>` : `<div class="price">
        <h3>Later</h3>
        <p>A paid plan for more apps will come later. We'll tell you well before anything changes.</p>
      </div>`}
    </div>
    <p class="note" style="margin-top:1.5rem">You also need an AI assistant that can connect to outside apps, such as Claude or ChatGPT. That is separate from Grove.</p>
  </section>

  <section class="band" id="faq">
    <div class="wrap">
      <p class="kicker">Questions</p>
      <h2>Things people ask</h2>
      <div class="faq">
        <details><summary>Do I need to know anything about code?</summary><p>No. You describe what you want and check that the result does it. The code is there if a developer ever needs it, and you never have to look at it.</p></details>
        <details><summary>Where do I actually use my app?</summary><p>In your assistant's chat, the same place you made it. There's nothing to install. It can also have web pages of its own at its own address: a front page, a form, a list. Those open in any browser.</p></details>
        <details><summary>Who can see my information?</summary><p>Only the people you name for that app, after they sign in with a code sent to their email. Each app's information is kept apart from every other app's. See the <a href="/privacy">privacy page</a> for the detail.</p></details>
        <details><summary>Does it use up my Claude or ChatGPT allowance?</summary><p>Yes. Making and changing apps is work your assistant does, so it counts against your plan with them. Using an app is light; building one is heavier. Grove keeps count, tells you how big a job is, and stops to ask before a day's work gets large.</p></details>
        <details><summary>What if Grove gets something wrong?</summary><p>It will sometimes. That's why every change goes to a trial copy first and can be undone after. Check that an app does what you meant before you rely on it.</p></details>
        <details><summary>Can I make things for other people or businesses?</summary><p>Yes, and we hope you do. You stay the maker: you name who can use it, they ask you for changes, and you can hand them the code and the information at any time. What you charge them is up to you.</p></details>
        <details><summary>Can I leave?</summary><p>Yes, with everything. You can download any app's code and take a copy of its information at any time, and the app runs without Grove.</p></details>
        <details><summary>Who can join?</summary><p>Anyone. Add Grove to your assistant and sign in with your email. It is new, so expect rough edges, and tell us when you hit one.</p></details>
      </div>
    </div>
  </section>

  <section class="deep" id="invite">
    <div class="wrap invite">
      <div>
        <p class="kicker">Keep in touch</p>
        <h2>Not ready yet? Tell us what you'd make</h2>
        <p class="intro">You can <a href="#connect">add Grove now</a>. Or leave your email and the job you have in mind. We read every one, and it shapes what we build next.</p>
      </div>
      <form id="invite-form">
        <div><label for="email">Your email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="200"></div>
        <div><label for="idea">What would you make? <span>(if you like)</span></label><textarea id="idea" name="idea" rows="3" maxlength="1000"></textarea></div>
        <div><button class="btn">Send</button></div>
        <p id="invite-msg" role="status" aria-live="polite"></p>
      </form>
    </div>
  </section>
</main>

<footer>
  <div class="wrap">
    <p>Grove makes MAPLE apps. This site is one too.</p>
    <p>${repo ? `<a href="${repo}">GitHub</a> · ` : ""}<a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/report">Report an app</a> · <a href="/account">Sign in</a></p>
  </div>
</footer>
<script type="module">${SCRIPT}</script>
</body>
</html>`;
