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
`;

const CSS = `
:root {
  --ink: #1c2a1e; --soft: #4d5e51; --line: #d8dfd9; --bg: #f6f4ec; --card: #fffdf7;
  --brand: #1f5135; --brand-ink: #fff; --leaf: #f2a541; --tint: #e7efe6;
}
@media (prefers-color-scheme: dark) {
  :root { --ink: #e8eee9; --soft: #a9b8ac; --line: #34433a; --bg: #121a15; --card: #1a241e; --brand: #7fcb9c; --brand-ink: #0f1a13; --tint: #1f2c24; }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body { margin: 0; font: 1.125rem/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
h1, h2, h3 { font-family: ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif; line-height: 1.2; text-wrap: balance; }
h1 { font-size: clamp(2rem, 6vw, 3.25rem); margin: 0 0 .5em; letter-spacing: -.01em; }
h2 { font-size: clamp(1.5rem, 4vw, 2rem); margin: 0 0 .6em; }
h3 { font-size: 1.15rem; margin: 0 0 .3em; }
p { margin: 0 0 1em; }
a { color: var(--brand); text-underline-offset: .2em; }
:focus-visible { outline: 3px solid var(--leaf); outline-offset: 3px; border-radius: 4px; }
.wrap { max-width: 60rem; margin-inline: auto; padding-inline: 1rem; }
.skip { position: absolute; left: -999px; }
.skip:focus { left: 1rem; top: 1rem; background: var(--card); padding: .5rem 1rem; z-index: 2; }
header.top { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; padding-block: 1rem; }
.logo { display: flex; align-items: center; gap: .6rem; font-weight: 700; font-size: 1.25rem; color: var(--ink); text-decoration: none; margin-right: auto; }
.logo svg { width: 2.25rem; height: 2.25rem; }
nav ul { display: flex; gap: 1.25rem; flex-wrap: wrap; list-style: none; margin: 0; padding: 0; font-size: 1rem; }
nav a { display: inline-block; padding: .4rem 0; }
section { padding-block: clamp(2.5rem, 7vw, 4.5rem); }
section.hero { padding-top: clamp(1rem, 4vw, 2.5rem); }
.hero { display: grid; gap: 2rem; align-items: center; }
@media (min-width: 52rem) { .hero { grid-template-columns: 1.1fr .9fr; } }
.lede { font-size: 1.25rem; color: var(--soft); max-width: 34rem; }
.actions { display: flex; gap: .75rem; flex-wrap: wrap; margin-top: 1.5rem; }
.btn { display: inline-block; font: inherit; font-weight: 600; padding: .8rem 1.3rem; border-radius: 999px; border: 2px solid var(--brand); background: var(--brand); color: var(--brand-ink); text-decoration: none; cursor: pointer; }
.btn.quiet { background: transparent; color: var(--brand); }
.btn:disabled { opacity: .6; cursor: default; }
.chat { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 1.25rem; padding: 1.25rem; }
.chat p { margin: 0 0 .75rem; padding: .7rem 1rem; border-radius: 1rem; max-width: 92%; font-size: 1rem; }
.chat .who { display: block; font-size: .8rem; font-weight: 700; color: var(--soft); }
.chat .you { background: var(--tint); margin-left: auto; }
.chat .app { border: 1px solid var(--line); }
.chat figcaption { font-size: .9rem; color: var(--soft); text-align: center; margin-top: .5rem; }
.band { background: var(--tint); }
.cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); list-style: none; padding: 0; margin: 1.5rem 0 0; }
.cards li { background: var(--card); border: 1px solid var(--line); border-radius: 1rem; padding: 1.25rem; }
.cards p { margin: 0; color: var(--soft); font-size: 1rem; }
.steps { counter-reset: step; }
.steps li { counter-increment: step; }
.steps h3::before { content: counter(step); display: inline-grid; place-items: center; width: 1.9rem; height: 1.9rem; margin-right: .5rem; border-radius: 50%; background: var(--brand); color: var(--brand-ink); font-size: 1rem; }
.letter { font-weight: 800; color: var(--brand); margin-right: .35rem; }
.price { background: var(--card); border: 1px solid var(--line); border-radius: 1.25rem; padding: 1.5rem; max-width: 34rem; }
.price .big { font-size: 2.25rem; font-weight: 800; font-family: ui-rounded, system-ui, sans-serif; margin: 0; }
.prices { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.prices .price { max-width: none; }
.price h3 { color: var(--soft); }
.price ul { padding-left: 1.2rem; margin: .5rem 0 1rem; }
form { display: grid; gap: .75rem; max-width: 30rem; }
label { font-weight: 600; }
label span { font-weight: 400; color: var(--soft); }
input, textarea { font: inherit; width: 100%; padding: .75rem .9rem; border-radius: .75rem; border: 1px solid var(--soft); background: var(--card); color: var(--ink); }
#invite-msg { min-height: 1.65em; margin: 0; }
code { background: var(--card); border: 1px solid var(--line); border-radius: .4rem; padding: .1rem .4rem; font-size: .95em; overflow-wrap: anywhere; }
.connect { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); margin-top: 1.5rem; }
.connect > div { background: var(--card); border: 1px solid var(--line); border-radius: 1rem; padding: 1.25rem; }
.connect ol { padding-left: 1.3rem; margin: 0 0 1rem; }
.connect li { margin-bottom: .4rem; }
.copy { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
.copy [role=status] { font-size: 1rem; color: var(--soft); }
.btn.small { padding: .45rem .9rem; font-size: 1rem; }
.note { color: var(--soft); font-size: 1rem; }
.doc { max-width: 44rem; padding-block: 2rem 4rem; }
.doc h2 { font-size: 1.3rem; margin-top: 2rem; }
.doc li { margin-bottom: .4rem; }
.draft { background: var(--tint); border: 1px solid var(--line); border-radius: .75rem; padding: .75rem 1rem; }
footer { padding-block: 2rem; color: var(--soft); font-size: 1rem; border-top: 1px solid var(--line); }
`;

/** A plain page in Grove's look, for the terms and privacy pages. */
export const shell = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
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

export const sitePage = (connect: string, free: number, paid?: PaidPlan) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grove: little apps you make by asking</title>
<meta name="description" content="Grove makes small apps you use by chatting with your AI assistant. Say what you need, and it's made: its own database, sign-in, and a way to ask for changes.">
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
        <li><a href="#connect">Add Grove</a></li>
        <li><a href="#get">What you get</a></li>
        <li><a href="#price">Price</a></li>
        <li><a href="/account">Sign in</a></li>
      </ul>
    </nav>
  </header>
</div>

<main id="main">
  <section class="wrap hero">
    <div>
      <h1>Say what you need. Get a little app that does it.</h1>
      <p class="lede">Grove makes small apps you use by chatting with your AI assistant. For your shop, your club, your team. Nothing to install, no screens to learn. You just ask.</p>
      <div class="actions">
        <a class="btn" href="${claudeLink(connect)}">Add Grove to Claude</a>
        <a class="btn" href="#chatgpt">Add Grove to ChatGPT</a>
      </div>
      <p class="note" style="margin-top:1rem">Grove is invite-only while it's new. <a href="#invite">Ask for an invite</a> first.</p>
    </div>
    <figure class="chat">
      <p class="you"><span class="who">You</span>Make me something to keep track of who has paid their rowing club fees.</p>
      <p class="app"><span class="who">Grove</span>Done. It's called Club Helper. Who should be able to use it?</p>
      <p class="you"><span class="who">You, a week later</span>Who still owes for spring?</p>
      <p class="app"><span class="who">Club Helper</span>Three people: Ana, Tom and Priya. Shall I write them a reminder?</p>
      <figcaption>An example of how it goes.</figcaption>
    </figure>
  </section>

  <section class="band" id="how">
    <div class="wrap">
      <h2>How it works</h2>
      <ol class="cards steps">
        <li><h3>Say what you need</h3><p>Add Grove to your assistant once. Then describe the job in a sentence or two, the way you'd tell a person.</p></li>
        <li><h3>Grove makes it</h3><p>You get a real app with its own place to keep your information, private to the people you choose.</p></li>
        <li><h3>Use it, and grow it</h3><p>Ask it questions. When you want it to do more, say so in the chat. Try each change before it goes live, and undo it if you change your mind.</p></li>
      </ol>
    </div>
  </section>

  <section class="wrap" id="connect">
    <h2>Add Grove to your assistant</h2>
    <p>You do this once. After that, you make and use your apps by chatting.</p>
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
  </section>

  <section class="wrap">
    <h2>Things people make</h2>
    <p>Anything that is mostly "keep track of this, and tell me when I ask".</p>
    <ul class="cards">
      <li><h3>A shop helper</h3><p>What's running low, what to reorder, what sold this week.</p></li>
      <li><h3>A club helper</h3><p>Members, fees, who has paid, who needs a nudge.</p></li>
      <li><h3>A team helper</h3><p>Jobs, who is on them, what is due, what is stuck.</p></li>
      <li><h3>A bookings helper</h3><p>Who is coming tomorrow, and who hasn't confirmed.</p></li>
    </ul>
  </section>

  <section class="band" id="get">
    <div class="wrap">
      <h2>What every app gets</h2>
      <p>Grove apps are built on MAPLE, an open format with five parts.</p>
      <ul class="cards">
        <li><h3><span class="letter">M</span>Lives in your assistant</h3><p>You use the app by chatting. The people you share it with do the same.</p></li>
        <li><h3><span class="letter">A</span>Sign-in without passwords</h3><p>A code arrives by email. Only the people you name get in.</p></li>
        <li><h3><span class="letter">P</span>Its own database</h3><p>Your information is kept in one place that belongs to that app alone.</p></li>
        <li><h3><span class="letter">L</span>A way to ask for more</h3><p>Anyone using the app can ask its maker for a change, right in the chat.</p></li>
        <li><h3><span class="letter">E</span>Email built in</h3><p>For sign-in codes and for those requests. Nothing to set up.</p></li>
      </ul>
      <h3 style="margin-top:2rem">Real code, in the open</h3>
      <p>Each app is ordinary code with its own database, in an open format. It isn't locked inside Grove, so it can move somewhere else if you ever want it to. You can download an app's code and take a copy of its data whenever you like. <a href="#get">What every app gets</a>.</p>
    </div>
  </section>

  <section class="wrap" id="price">
    <h2>Price</h2>
    <div class="prices">
      <div class="price">
        <h3>Free</h3>
        <p class="big">£0</p>
        <ul>
          <li>Up to ${free} small apps</li>
          <li>Share each one with the people you choose</li>
          <li>Previews, undo and requests included</li>
        </ul>
        <p>No card needed.</p>
      </div>
      ${paid ? `<div class="price">
        <h3>Plus</h3>
        <p class="big">${paid.price}</p>
        <ul>
          <li>Up to ${paid.apps} small apps</li>
          <li>Everything in Free</li>
          <li>Cancel whenever you like</li>
        </ul>
        <p>To move up, ask Grove in your chat: "upgrade my plan". It gives you a link to pay safely with Stripe.</p>
      </div>` : `<div class="price">
        <h3>Later</h3>
        <p>Paid plans for more apps will come later. We'll tell you well before anything changes.</p>
      </div>`}
    </div>
    <h3 style="margin-top:2rem">What you need</h3>
    <p>An AI assistant that can connect to outside apps, such as Claude or ChatGPT. <a href="#connect">Add Grove to yours</a>.</p>
  </section>

  <section class="band" id="invite">
    <div class="wrap">
      <h2>Ask for an invite</h2>
      <p>Grove is invite-only while it's new. Leave your email and we'll be in touch.</p>
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
    <p>Grove makes MAPLE apps. This site is one too. <a href="#get">About MAPLE</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/account">Sign in</a></p>
  </div>
</footer>
<script type="module">${SCRIPT}</script>
</body>
</html>`;
