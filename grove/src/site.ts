// Grove's front page: what Grove and MAPLE are, for people who don't write software.
// Served by Grove itself at "/", so the site that explains MAPLE apps is one.
// The script lives in a template string: no backticks or ${} inside it.
import { ICON_SVG } from "../../kit/pages.ts";

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
// The example at the top: one story in four parts. Without this script all four simply show one after another.
const demo = document.getElementById("demo");
const tabs = [...demo.querySelectorAll("[role=tab]")];
const show = (tab, focus) => {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  }
  if (focus) tab.focus();
};
demo.classList.add("live");
demo.querySelector("[role=tablist]").hidden = false;
for (const t of tabs) {
  t.addEventListener("click", () => show(t));
  t.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(t);
    if (e.key === "ArrowRight") show(tabs[(i + 1) % tabs.length], true);
    if (e.key === "ArrowLeft") show(tabs[(i + tabs.length - 1) % tabs.length], true);
  });
}
show(tabs[0]);
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
nav a:hover { color: var(--brand); text-decoration: underline; }
section { padding-block: clamp(3rem, 8vw, 5.5rem); }
.kicker { font-size: .95rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--brand); margin: 0 0 .6rem; }
.intro { font-size: 1.2rem; color: var(--soft); max-width: 42rem; margin-bottom: 0; }
.hero { padding-top: clamp(1.5rem, 5vw, 3.5rem); display: grid; gap: 2.5rem; align-items: center; }
@media (min-width: 60rem) { .hero { grid-template-columns: 1.05fr .95fr; } }
.lede { font-size: 1.3rem; color: var(--soft); max-width: 36rem; }
.actions { display: flex; gap: .75rem; flex-wrap: wrap; margin-top: 1.5rem; align-items: center; }
.btn { display: inline-block; font: inherit; font-weight: 600; padding: .8rem 1.35rem; border-radius: 999px; border: 2px solid var(--brand); background: var(--brand); color: var(--brand-ink); text-decoration: none; cursor: pointer; }
.btn:hover { filter: brightness(1.08); }
.btn.quiet { background: transparent; color: var(--brand); }
.btn.small { padding: .45rem .9rem; font-size: 1rem; }
.btn:disabled { opacity: .6; cursor: default; }
.already { margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line); font-size: 1rem; color: var(--soft); }
.already .actions { margin-top: .6rem; }
.note { color: var(--soft); font-size: 1rem; }

.demo { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 1.5rem; padding: 1rem; box-shadow: 0 1.5rem 3rem -1.5rem rgb(31 81 53 / .35); }
.demo [role=tablist] { display: flex; gap: .35rem; flex-wrap: wrap; margin-bottom: .75rem; }
.demo [role=tab] { font: inherit; font-size: .95rem; font-weight: 600; padding: .4rem .85rem; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--soft); cursor: pointer; }
.demo [role=tab][aria-selected=true] { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); }
.demo h3 { font-size: .85rem; letter-spacing: .06em; text-transform: uppercase; color: var(--soft); margin: 1rem .25rem .5rem; }
.demo.live h3 { position: absolute; left: -999px; }
.demo .talk { min-height: 17.5rem; display: flex; flex-direction: column; gap: .6rem; justify-content: flex-end; }
.demo p { margin: 0; padding: .7rem 1rem; border-radius: 1.1rem; max-width: 90%; font-size: 1rem; line-height: 1.5; }
.demo .who { display: block; font-size: .78rem; font-weight: 700; color: var(--soft); }
.demo .you { background: var(--tint); align-self: flex-end; border-bottom-right-radius: .3rem; }
.demo .app { border: 1px solid var(--line); align-self: flex-start; border-bottom-left-radius: .3rem; }
.demo figcaption { font-size: .9rem; color: var(--soft); text-align: center; margin-top: .75rem; }

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

const claudeLink = (connect: string) => `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Grove&connectorUrl=${encodeURIComponent(connect)}`;

export type PaidPlan = { price: string; apps: number };

/** One part of the example at the top of the page: a short exchange between a person and their assistant. */
const part = (id: string, title: string, lines: [who: string, text: string][]) => `
      <div role="tabpanel" id="demo-${id}" aria-labelledby="tab-${id}">
        <h3>${title}</h3>
        <div class="talk">${lines.map(([who, text]) => `<p class="${who.startsWith("You") ? "you" : "app"}"><span class="who">${who}</span>${text}</p>`).join("")}</div>
      </div>`;

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
<title>Grove: little apps you make by asking</title>
<meta name="description" content="Describe a job in a sentence and Grove makes a small app for it that you use inside Claude or ChatGPT. Its own database, sign-in for your people, real code you can take away.">
<meta property="og:title" content="Grove: little apps you make by asking">
<meta property="og:description" content="Describe a job in a sentence. Get a small app you use inside your AI assistant, with its own database and sign-in for your people.">
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
        <li><a href="#yours">It's yours</a></li>
        <li><a href="#price">Price</a></li>
        <li><a href="#connect">Add Grove</a></li>
        <li><a href="/account">Sign in</a></li>
      </ul>
    </nav>
  </header>
</div>

<main id="main">
  <section class="wrap hero">
    <div>
      <p class="kicker">Apps without the app</p>
      <h1>Say what you need. Get a little app that does it.</h1>
      <p class="lede">Grove turns a sentence into a working app you use by chatting with Claude or ChatGPT. It remembers your information, signs in the people you choose, and grows when you ask it to. You never write code or learn a screen.</p>
      <div class="actions">
        <a class="btn" href="#invite">Ask for an invite</a>
        <a class="btn quiet" href="#how">See how it works</a>
      </div>
      <div class="already">
        Already invited? Add Grove to your assistant:
        <div class="actions">
          <a class="btn quiet small" href="${claudeLink(connect)}">Add Grove to Claude</a>
          <a class="btn quiet small" href="#chatgpt">Add Grove to ChatGPT</a>
        </div>
      </div>
    </div>
    <figure class="demo" id="demo">
      <div role="tablist" aria-label="An example, in four parts" hidden>
        <button role="tab" id="tab-make" aria-controls="demo-make" type="button">1. Make it</button>
        <button role="tab" id="tab-use" aria-controls="demo-use" type="button">2. Use it</button>
        <button role="tab" id="tab-grow" aria-controls="demo-grow" type="button">3. Grow it</button>
        <button role="tab" id="tab-share" aria-controls="demo-share" type="button">4. Share it</button>
      </div>${part("make", "1. Make it", [
        ["You", "Make me something to keep track of who has paid their rowing club fees."],
        ["Grove", "Done. It's called Club Helper and it's live. Who should be able to use it?"],
        ["You", "Me and Tom, the treasurer."],
        ["Grove", "Added you both. Here's how to add Club Helper to your assistant."],
      ])}${part("use", "2. Use it", [
        ["You, a week later", "Ana and Priya paid for spring today. Who still owes?"],
        ["Club Helper", "Noted for both. Three people still owe for spring: Tom B, Sam and Lucy. Shall I write them a reminder?"],
        ["You", "Yes, friendly but short."],
      ])}${part("grow", "3. Grow it", [
        ["You", "Can it also keep track of who has a boat key?"],
        ["Grove", "I've added that to a trial copy, with a copy of your information, so nothing live has changed. Try it here and tell me if it's right."],
        ["You", "Looks good. Make it live."],
        ["Grove", "It's live. If you change your mind, I can undo it."],
      ])}${part("share", "4. Share it", [
        ["Tom, in his own chat", "Has Lucy paid?"],
        ["Club Helper", "Not yet. She owes £40 for spring."],
        ["Tom", "It would help if it showed who pays by standing order."],
        ["Club Helper", "Good idea. I've sent that to the person who looks after this app."],
      ])}
      <figcaption>An example of how it goes.</figcaption>
    </figure>
  </section>

  <div class="wrap">
    <ul class="facts">
      <li><strong>About 20 seconds</strong><span>from your sentence to a live app</span></li>
      <li><strong>Its own database</strong><span>one per app, private to it</span></li>
      <li><strong>Real code you can keep</strong><span>download it whenever you like</span></li>
      <li><strong>Free for ${free} apps</strong><span>no card needed</span></li>
    </ul>
  </div>

  <section class="wrap" id="how">
    <p class="kicker">How it works</p>
    <h2>Three steps, all of them in a chat</h2>
    <p class="intro">You add Grove to your AI assistant once. After that, making an app is a conversation.</p>
    <ol class="cards steps">
      <li><h3>Say what you need</h3><p>Describe the job the way you'd tell a person: what to keep track of, and who it's for. A sentence or two is enough.</p></li>
      <li><h3>Grove makes it</h3><p>You get a real app with its own database and its own address. Each person you name can sign in to it and use it from their own assistant.</p></li>
      <li><h3>Use it, and grow it</h3><p>Ask it questions and tell it things. When you want more, say so. Every change is tried on a copy first, and can be undone after.</p></li>
    </ol>
  </section>

  <section class="band" id="make">
    <div class="wrap">
      <p class="kicker">What people make</p>
      <h2>The jobs nobody builds software for</h2>
      <p class="intro">Too small for a software project, too awkward for a spreadsheet. Anything that is mostly "remember this, and tell me when I ask".</p>
      <ul class="cards">
        <li><h3>A shop helper</h3><p class="say">"What's running low, and what did we sell most of this week?"</p><p>Stock, reorders and sales notes.</p></li>
        <li><h3>A club helper</h3><p class="say">"Who hasn't paid for spring? Write them a reminder."</p><p>Members, fees and who needs a nudge.</p></li>
        <li><h3>A team helper</h3><p class="say">"What's due this week, and what's stuck?"</p><p>Jobs, who is on them, and what's blocking them.</p></li>
        <li><h3>A bookings helper</h3><p class="say">"Who's coming tomorrow, and who hasn't confirmed?"</p><p>Appointments, confirmations and no-shows.</p></li>
        <li><h3>A lettings helper</h3><p class="say">"Which repairs are still open at Mill Street?"</p><p>Properties, tenants, repairs and renewals.</p></li>
        <li><h3>A family helper</h3><p class="say">"When is the car due its MOT, and who's doing school pickup?"</p><p>Dates, chores and things not to forget.</p></li>
      </ul>
      <div class="fit">
        <div>
          <h3>A good fit</h3>
          <ul>
            <li>Keeping track of things and asking about them</li>
            <li>A handful of people who trust each other</li>
            <li>Rules that change as you learn what you need</li>
          </ul>
        </div>
        <div class="no">
          <h3>Not what it's for</h3>
          <ul>
            <li>A public website or an online shop front</li>
            <li>Apps people use by tapping through screens</li>
            <li>Card payments, medical records, or anything where a mistake is serious</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="wrap" id="get">
    <p class="kicker">What every app gets</p>
    <h2>Five parts, already put together</h2>
    <p class="intro">Grove apps are built on MAPLE, an open format named after its five parts. You get all of them from the first minute.</p>
    <ul class="cards">
      <li><h3><span class="letter">M</span>Lives in your assistant</h3><p>You use the app by chatting. So do the people you share it with, each in their own assistant.</p></li>
      <li><h3><span class="letter">A</span>Sign-in without passwords</h3><p>A code arrives by email. Only the people you name get in.</p></li>
      <li><h3><span class="letter">P</span>Its own database</h3><p>Your information is kept in a proper database that belongs to that one app.</p></li>
      <li><h3><span class="letter">L</span>A way to ask for more</h3><p>Anyone using the app can ask its maker for a change, right in the chat.</p></li>
      <li><h3><span class="letter">E</span>Email built in</h3><p>For sign-in codes and for those requests. Nothing to set up.</p></li>
      <li><h3><span class="letter">+</span>Trial copies and undo</h3><p>Grove adds these on top: every change is tried first, and anything shipped can be taken back.</p></li>
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
        <li><h3>${repo ? "Open source" : "An open format"}</h3><p>${repo ? `Grove and MAPLE are open source under the MIT licence. Read the code, run your own Grove, or build on it. <a href="${repo}">See it on GitHub</a>.` : "MAPLE is an open format with a published set of rules, so an app made here isn't tied to this company or this site."}</p></li>
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
      <p class="intro">You do this once. After that, you make and use your apps by chatting. You need an invite first.</p>
      <div class="connect">
        <div>
          <h3>Claude</h3>
          <ol>
            <li>Press the button. Claude opens with Grove's name and address already filled in.</li>
            <li>Press <strong>Add</strong>, then <strong>Connect</strong>.</li>
            <li>Sign in with the email you were invited with. A code arrives by email.</li>
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
            <li>Press <strong>Create</strong>, name it Grove, paste the address, and sign in with the email you were invited with.</li>
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
        <details><summary>Where do I actually use my app?</summary><p>In your assistant's chat, the same place you made it. There's no separate app to install or open. Each app also has a simple web page for signing in.</p></details>
        <details><summary>Who can see my information?</summary><p>Only the people you name for that app, after they sign in with a code sent to their email. Each app's information is kept apart from every other app's. See the <a href="/privacy">privacy page</a> for the detail.</p></details>
        <details><summary>Does it use up my Claude or ChatGPT allowance?</summary><p>Yes. Making and changing apps is work your assistant does, so it counts against your plan with them. Using an app is light; building one is heavier. Grove keeps count, tells you how big a job is, and stops to ask before a day's work gets large.</p></details>
        <details><summary>What if Grove gets something wrong?</summary><p>It will sometimes. That's why every change goes to a trial copy first and can be undone after. Check that an app does what you meant before you rely on it.</p></details>
        <details><summary>Can I leave?</summary><p>Yes, with everything. You can download any app's code and take a copy of its information at any time, and the app runs without Grove.</p></details>
        <details><summary>Why is it invite-only?</summary><p>Grove is new, and each app is a real running program. We're letting people in gradually so it stays reliable for those already using it.</p></details>
      </div>
    </div>
  </section>

  <section class="deep" id="invite">
    <div class="wrap invite">
      <div>
        <p class="kicker">Get started</p>
        <h2>Ask for an invite</h2>
        <p class="intro">Leave your email and, if you like, the job you have in mind. We read every one, and it helps us decide who to let in next.</p>
      </div>
      <form id="invite-form">
        <div><label for="email">Your email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="200"></div>
        <div><label for="idea">What would you make? <span>(if you like)</span></label><textarea id="idea" name="idea" rows="3" maxlength="1000"></textarea></div>
        <div><button class="btn">Ask for an invite</button></div>
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
