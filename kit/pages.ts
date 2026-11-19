// Web pages every MAPLE app serves: home (sign-in, then how to connect an AI assistant and the requests),
// plus the sign-in and consent pages an assistant's OAuth flow sends people to.
// Scripts live in template strings: no backticks or ${} inside them.

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#fffdf7"/><rect x="1" y="1" width="62" height="62" rx="13" fill="none" stroke="#d8dfd9" stroke-width="2"/><path fill="#d80621" d="M32 8l4 10 7-4-2 11 9-3-4 9 8 2-11 7 2 6-11-3v13h-4V43l-11 3 2-6-11-7 8-2-4-9 9 3-2-11 7 4z"/></svg>`;

const shell = (title: string, authUrl: string, body: string, script: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<meta name="theme-color" content="#1f5135">
<style>
  :root { --ink: #1c2a1e; --muted: #5b6b5e; --line: #d8dfd9; --bg: #f5f7f4; --card: #fff; --brand: #1f5135; --accent: #b86b00; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e8eee9; --muted: #a3b2a6; --line: #34433a; --bg: #121a15; --card: #1a241e; --brand: #6fbf8f; --accent: #f2a541; } }
  body { font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--ink); margin: 0; padding: 16px; }
  main { max-width: 640px; margin: 6vh auto; background: var(--card); padding: 24px; border-radius: 14px; border: 1px solid var(--line); }
  main.narrow { max-width: 380px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  header img { width: 40px; height: 40px; }
  h1 { font-size: 1.3rem; margin: 0; }
  h2 { font-size: 1.05rem; margin: 24px 0 8px; }
  label { display: block; margin: 12px 0 4px; }
  input, button { font: inherit; width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--ink); }
  button { margin-top: 14px; background: var(--brand); color: #fff; border: 0; cursor: pointer; }
  button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  button:disabled { opacity: .6; cursor: default; }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row button { width: auto; margin: 0; white-space: nowrap; }
  code { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; display: block; overflow-wrap: anywhere; flex: 1; }
  ol { padding-left: 20px; }
  .muted { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: .95rem; }
  td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
  #msg { margin-top: 12px; min-height: 1.5em; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
${body}
<script type="module">
import { createAuthClient } from "https://esm.sh/@neon/auth@0.8.2";
const auth = createAuthClient(${JSON.stringify(authUrl)});
const $ = (id) => document.getElementById(id);
const say = (text) => { $("msg").textContent = text; };
${script}
</script>
</body>
</html>`;

const head = (title: string) => `<header><img src="/icon.svg" alt=""><h1>${esc(title)}</h1></header>`;

const SIGN_IN_FORMS = `<form id="email-form">
  <label for="email">Email</label>
  <input id="email" type="email" autocomplete="email" required>
  <button>Email me a code</button>
</form>
<form id="code-form" hidden>
  <label for="code">Code from your email</label>
  <input id="code" inputmode="numeric" autocomplete="one-time-code" required>
  <button>Sign in</button>
  <button type="button" id="resend" class="secondary" disabled>Send a new code</button>
</form>
<p id="msg" role="status" aria-live="polite"></p>`;

// Expects the page to define signedIn(), run once the person has a session.
const SIGN_IN_SCRIPT = `
let email, timer;
const waitToResend = () => {
  let left = 60;
  const b = $("resend");
  b.disabled = true;
  clearInterval(timer);
  const tick = () => {
    b.textContent = left > 0 ? "Send a new code in " + left + "s" : "Send a new code";
    if (left-- <= 0) { b.disabled = false; clearInterval(timer); }
  };
  tick();
  timer = setInterval(tick, 1000);
};
const sendCode = async (button) => {
  button.disabled = true;
  say("Sending...");
  const { error } = await auth.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
  button.disabled = false;
  if (error) {
    say(error.status === 429 ? "Too many codes asked for. Wait a minute, then try again." : error.message ?? "Could not send the code. Try again.");
    return false;
  }
  waitToResend();
  return true;
};
$("email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  email = $("email").value.trim();
  if (!(await sendCode(e.submitter ?? $("email-form").querySelector("button")))) return;
  $("email-form").hidden = true;
  $("code-form").hidden = false;
  $("code").focus();
  say("Check your email for a code.");
});
$("resend").addEventListener("click", async () => {
  if (await sendCode($("resend"))) say("New code sent. Use the newest one.");
});
$("code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  say("Checking...");
  const { data, error } = await auth.signIn.emailOtp({ email, otp: $("code").value.trim() });
  if (error) return say(error.message ?? "That code did not work. Try again.");
  if (!data?.redirect) await signedIn();
});
`;

/**
 * The line free apps made with Grove carry at the foot of their pages: what Grove is, and where to report a problem.
 * Styled inline so it looks the same on any page it is added to.
 */
export const groveBadge = (grove: string, slug: string) =>
  `<aside aria-label="About this app" style="margin:32px auto 16px;max-width:640px;padding:0 16px;text-align:center;font:14px/1.5 system-ui,sans-serif;color:#5b6b5e">Made with <a href="${esc(grove)}/?from=${encodeURIComponent(slug)}" style="color:inherit;font-weight:600">Grove</a>: little apps you make by asking your AI assistant. <a href="${esc(grove)}/report?app=${encodeURIComponent(slug)}" style="color:inherit">Report this app</a></aside>`;

/** Adds the badge to a page, before the end of its body. */
export const withBadge = (html: string, badge: string) => (html.includes("</body>") ? html.replace("</body>", badge + "\n</body>") : html + badge);

export const signInPage = (title: string, authUrl: string) =>
  shell(
    `Sign in to ${title}`,
    authUrl,
    `<main class="narrow">${head(title)}${SIGN_IN_FORMS}</main>`,
    `
const signedIn = async () => {
  const { error } = await auth.oauth2.continue({ selected: true });
  if (error) say("This sign-in link expired. Go back to your assistant and connect again.");
};
${SIGN_IN_SCRIPT}
if ((await auth.getSession()).data?.user) await signedIn();`,
  );

export const consentPage = (title: string, authUrl: string) =>
  shell(
    `Connect ${title}`,
    authUrl,
    `<main class="narrow">${head(title)}
<p><strong id="client">An app</strong> wants to use ${esc(title)} as you. It can do anything you can do in ${esc(title)}.</p>
<p id="where"></p>
<button id="allow">Allow</button>
<button id="deny" class="secondary">Deny</button>
<p id="msg" role="status" aria-live="polite"></p></main>`,
    `
const params = new URLSearchParams(location.search);
const { data: client } = await auth.oauth2.publicClient({ query: { client_id: params.get("client_id") ?? "" } });
if (client?.client_name) $("client").textContent = client.client_name;
const hosts = [...new Set((client?.redirect_uris ?? []).map((u) => new URL(u).hostname))];
if (hosts.length) {
  const local = hosts.every((h) => ["localhost", "127.0.0.1", "[::1]"].includes(h));
  $("where").textContent = local
    ? "It will send you back to a program on this computer. Only allow this if you just started connecting from an app here."
    : "It will send you back to: " + hosts.join(", ");
}
for (const [id, accept] of [["allow", true], ["deny", false]]) {
  $(id).addEventListener("click", async () => {
    const { error } = await auth.oauth2.consent({ accept });
    if (error) say(error.message ?? "Something went wrong. Go back to your assistant and connect again.");
  });
}`,
  );

export const homePage = (title: string, authUrl: string, mcpUrl: string) =>
  shell(
    title,
    authUrl,
    `<main class="narrow" id="card" hidden>${head(title)}${SIGN_IN_FORMS}</main>
<main id="app" hidden>${head(title)}
<p class="muted">Signed in as <span id="who"></span>. <a href="#" id="sign-out">Sign out</a></p>
<h2>Use ${esc(title)} from your AI assistant</h2>
<p>${esc(title)} works with Claude, ChatGPT, Gemini, Grok and any other assistant that can add a connector. You add it once:</p>
<ol>
  <li>Copy this address:</li>
</ol>
<div class="row"><code id="url">${esc(mcpUrl)}</code><button id="copy" type="button">Copy</button></div>
<ol start="2">
  <li>Add it as a connector, named ${esc(title)}:
    <ul>
      <li><strong>Claude</strong>: Settings, Connectors, Add custom connector.</li>
      <li><strong>ChatGPT</strong>: Settings, Apps &amp; Connectors, turn on Developer mode, then Create.</li>
      <li><strong>Gemini</strong>: Settings, Connected apps, Add a custom app.</li>
      <li><strong>Grok</strong>: Connectors, add a custom connector.</li>
      <li><strong>Anything else</strong>: wherever it adds a connector, custom app or MCP server.</li>
    </ul>
  </li>
  <li>Choose <strong>Connect</strong> and sign in with this email.</li>
  <li>Start a new chat and ask ${esc(title)} anything.</li>
</ol>
<h2>Requests</h2>
<p id="none" class="muted" hidden>Nothing asked yet. In your assistant, say what you'd like ${esc(title)} to do.</p>
<table id="requests" hidden><thead><tr><th>#</th><th>Asked</th><th>Status</th><th>Reply</th></tr></thead><tbody></tbody></table>
<p id="msg" role="status" aria-live="polite"></p></main>`,
    `
const show = (id, on) => { $(id).hidden = !on; };
const signedIn = async () => {
  const s = await auth.getSession();
  show("card", false); show("app", true);
  $("who").textContent = s.data?.user?.email ?? "";
  const res = await fetch("/api/home", { headers: { authorization: "Bearer " + (s.data?.session?.token ?? "") } });
  const d = await res.json().catch(() => ({ error: "The server sent something unexpected." }));
  if (!res.ok) return say(d.error ?? "Could not load.");
  const body = $("requests").querySelector("tbody");
  body.replaceChildren();
  for (const r of d.requests) {
    const tr = document.createElement("tr");
    for (const v of ["#" + r.id, r.message, r.status, r.reply ?? ""]) { const td = document.createElement("td"); td.textContent = v; tr.append(td); }
    body.append(tr);
  }
  show("requests", d.requests.length > 0); show("none", d.requests.length === 0);
};
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("url").textContent); $("copy").textContent = "Copied"; }
  catch { getSelection().selectAllChildren($("url")); }
});
$("sign-out").addEventListener("click", async (e) => { e.preventDefault(); await auth.signOut(); location.reload(); });
${SIGN_IN_SCRIPT}
if ((await auth.getSession()).data?.user) await signedIn(); else show("card", true);`,
  );

/**
 * For apps from brand-new accounts: links to other sites lose their address (the words stay), forms can't
 * send anywhere else, and the page asks search engines to stay away. Links within the app and to Grove work.
 */
export function withoutOutsideLinks(html: string, own: string[]) {
  const mine = (u: string) => {
    try {
      const host = new URL(u, "https://same.invalid").hostname;
      return host === "same.invalid" || own.some((o) => host === o || host.endsWith(`.${o}`));
    } catch {
      return false;
    }
  };
  const out = html
    .replace(/(<a\b[^>]*?)\shref\s*=\s*(["'])(.*?)\2/gi, (w, start, _q, href) => (/^\s*(#|mailto:|tel:)/i.test(href) || mine(href) ? w : `${start} data-link-off="new account" title="Links to other sites work once this app's maker has been on Grove a few days"`))
    .replace(/(<form\b[^>]*?)\saction\s*=\s*(["'])(.*?)\2/gi, (w, start, _q, action) => (mine(action) ? w : `${start} action="#"`))
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, "");
  return out.includes("</head>") ? out.replace("</head>", '<meta name="robots" content="noindex, nofollow">\n</head>') : out;
}
