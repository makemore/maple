// Grove's own sign-in service, shared by every app on the runner: an emailed code to sign in, and
// the OAuth steps an AI assistant goes through to act for someone in one app. Built on Better Auth.
// Each app is a row (its /mcp address), so there is no limit on how many apps share it.
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP, jwt } from "better-auth/plugins";
import { oauthProvider, oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import pg from "pg";

export const SIGNIN_URL = () => process.env.SIGNIN_URL.replace(/\/$/, "");
export const ISSUER = () => `${SIGNIN_URL()}/api/auth`;

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, options: "-c search_path=signin" });
db.on("error", (e) => console.error("sign-in pool:", e.message));

async function sendCode(email, otp) {
  if (!process.env.POSTMARK_TOKEN) return void console.log(`sign-in code for ${email}: ${otp} (no email sender set)`);
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": process.env.POSTMARK_TOKEN },
    body: JSON.stringify({
      From: process.env.EMAIL_FROM ?? "Grove <grove@makewithgrove.com>", To: email, MessageStream: "outbound",
      Subject: `${otp} is your Grove sign-in code`,
      TextBody: `Your sign-in code is ${otp}\n\nIt works for five minutes. If you didn't ask for it, ignore this email: nobody can sign in without the code.`,
    }),
  });
  if (!res.ok) console.error("sign-in email failed:", res.status, (await res.text()).slice(0, 200));
}

export const auth = betterAuth({
  baseURL: SIGNIN_URL(),
  secret: process.env.RUNNER_SECRET,
  database: db,
  disabledPaths: ["/token"],
  trustedOrigins: [SIGNIN_URL()],
  rateLimit: { enabled: true, window: 60, max: 60 },
  plugins: [
    emailOTP({ sendVerificationOTP: ({ email, otp }) => sendCode(email, otp), otpLength: 6, expiresIn: 300 }),
    jwt({ disableSettingJwtHeader: true }),
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/consent",
      scopes: ["openid", "email", "offline_access"],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Any assistant may ask for a token for any app; each app decides who is on its own list.
      enforcePerClientResources: false,
      customAccessTokenClaims: async ({ user }) => ({ email: user?.email, email_verified: user?.emailVerified }),
    }),
  ],
});

export async function ready() {
  await db.query("create schema if not exists signin");
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/** Lets the sign-in service issue tokens for an app's address. */
export const addApp = (slug, mcpUrl, title) =>
  db.query(`insert into "oauthResource" (id, identifier, name, "createdAt", "updatedAt") values ($1, $2, $3, now(), now()) on conflict (id) do update set identifier = $2, name = $3, "updatedAt" = now()`, [`app-${slug}`, mcpUrl, title]);

export const jwks = () => auth.handler(new Request(`${ISSUER()}/jwks`));
const authServerMeta = oauthProviderAuthServerMetadata(auth), openIdMeta = oauthProviderOpenIdConfigMetadata(auth);

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const page = (title, body, script) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --ink: #1c2b22; --soft: #55665b; --bg: #f6f3ec; --card: #fffdf8; --line: #d9d5c8; --brand: #1f5135; }
@media (prefers-color-scheme: dark) { :root { --ink: #eef2ec; --soft: #a9b8ad; --bg: #141a16; --card: #1c241f; --line: #33402f; --brand: #7bc496; } }
body { margin: 0; font: 1.05rem/1.6 system-ui, sans-serif; background: var(--bg); color: var(--ink); }
main { max-width: 26rem; margin: 12vh auto; padding: 1.75rem; background: var(--card); border: 1px solid var(--line); border-radius: 1.1rem; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; } p { color: var(--soft); }
label { display: block; font-weight: 600; margin: 1rem 0 .3rem; }
input { width: 100%; box-sizing: border-box; font: inherit; padding: .65rem .75rem; border: 1px solid var(--line); border-radius: .6rem; background: var(--bg); color: var(--ink); }
button { font: inherit; font-weight: 600; margin-top: 1rem; padding: .65rem 1.1rem; border-radius: 999px; border: 2px solid var(--brand); background: var(--brand); color: var(--bg); cursor: pointer; }
button.quiet { background: transparent; color: var(--brand); margin-left: .5rem; }
#msg { min-height: 1.6em; }
@media (max-width: 30rem) { main { margin: 0; min-height: 100vh; border: 0; border-radius: 0; } }
</style></head><body><main>${body}<p id="msg" role="status" aria-live="polite"></p></main>
<script type="module">
const $ = (id) => document.getElementById(id), say = (t) => ($("msg").textContent = t);
const post = async (path, body) => { const r = await fetch("/api/auth" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" }); return { ok: r.ok, data: await r.json().catch(() => ({})) }; };
const query = location.search.slice(1);
const onward = (data) => { if (data?.url) location.href = data.url; else say("That worked, but there is nowhere to go on to. Go back to your assistant and connect again."); };
${script}
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "frame-ancestors 'none'", "referrer-policy": "no-referrer" } });

const signInPage = () => page("Sign in with Grove", `<h1>Sign in</h1><p>Enter your email and we'll send you a code. No password.</p>
<form id="ask"><label for="email">Your email</label><input id="email" type="email" autocomplete="email" required><button>Send me a code</button></form>
<form id="check" hidden><label for="code">The code from the email</label><input id="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="6"><button>Sign in</button><button type="button" class="quiet" id="again">Use another email</button></form>`, `
let email = "";
$("ask").addEventListener("submit", async (e) => {
  e.preventDefault(); email = $("email").value.trim(); say("Sending...");
  const { ok } = await post("/email-otp/send-verification-otp", { email, type: "sign-in" });
  if (!ok) return say("That didn't work. Check the address and try again in a minute.");
  $("ask").hidden = true; $("check").hidden = false; $("code").focus(); say("Sent. It can take a minute to arrive.");
});
$("again").addEventListener("click", () => { $("check").hidden = true; $("ask").hidden = false; say(""); });
$("check").addEventListener("submit", async (e) => {
  e.preventDefault(); say("Checking...");
  const { ok, data } = await post("/sign-in/email-otp", { email, otp: $("code").value.trim(), ...(query && { oauth_query: query }) });
  if (!ok) return say("That code isn't right, or it has run out. Try again.");
  onward(data);
});`);

const consentPage = (appName) => page("Allow access", `<h1>Allow access?</h1><p><strong id="client">An assistant</strong> wants to use <strong>${esc(appName)}</strong> as you. It will be able to do anything you can do there.</p><p id="where"></p>
<button id="allow">Allow</button><button id="deny" class="quiet">Don't allow</button>`, `
const back = new URLSearchParams(query).get("redirect_uri");
if (back) { const h = new URL(back).hostname; $("where").textContent = ["localhost", "127.0.0.1"].includes(h) ? "It will send you back to a program on this computer." : "It will send you back to " + h + "."; }
for (const [id, accept] of [["allow", true], ["deny", false]]) $(id).addEventListener("click", async () => {
  const { ok, data } = await post("/oauth2/consent", { accept, oauth_query: query });
  if (!ok) return say("This link has run out. Go back to your assistant and connect again.");
  onward(data);
});`);

/** Answers a request to the sign-in address. */
export async function handle(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/auth")) return auth.handler(request);
  if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) return authServerMeta(request);
  if (url.pathname.startsWith("/.well-known/openid-configuration") || url.pathname === "/api/auth/.well-known/openid-configuration") return openIdMeta(request);
  if (url.pathname === "/sign-in") return signInPage();
  if (url.pathname === "/consent") {
    const resource = url.searchParams.get("resource");
    const { rows: [r] } = resource ? await db.query(`select name from "oauthResource" where identifier = $1`, [resource]) : { rows: [] };
    return consentPage(r?.name ?? "an app");
  }
  if (url.pathname === "/") return page("Grove sign-in", `<h1>Grove sign-in</h1><p>This is where people sign in to apps made with Grove. There is nothing to do here by itself: connect to an app from your AI assistant and it will bring you here.</p>`, "");
  return new Response("Not found", { status: 404 });
}
