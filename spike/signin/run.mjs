// Spike: one sign-in service shared by any number of apps, run by us (Better Auth, the open-source
// software Neon's sign-in is built on). This walks through what an assistant does when it connects
// to an app: register itself, send the person to sign in by email code, get their consent, and
// come away with a token that is good for that one app and carries the person's verified email.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { createLocalJWKSet, jwtVerify } from "jose";
import pg from "pg";

const BASE = "https://signin.grove.test";
const APPS = 2000;
const pool = new pg.Pool({ connectionString: "postgres://postgres:spike@localhost:54329/postgres", max: 5 });
await pool.query("drop schema if exists signin cascade; create schema signin");
const db = new pg.Pool({ connectionString: "postgres://postgres:spike@localhost:54329/postgres", max: 5, options: "-c search_path=signin" });

const sent = {}; // email -> code. For real: an email through Postmark.
const auth = betterAuth({
  baseURL: BASE,
  secret: randomBytes(32).toString("hex"),
  database: db,
  disabledPaths: ["/token"],
  plugins: [
    emailOTP({ sendVerificationOTP: async ({ email, otp }) => void (sent[email] = otp) }),
    jwt({ disableSettingJwtHeader: true }),
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/consent",
      scopes: ["openid", "email", "offline_access"],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Any assistant may ask for a token for any app; the app itself decides who is on its list.
      enforcePerClientResources: false,
      customAccessTokenClaims: async ({ user }) => ({ email: user?.email, email_verified: user?.emailVerified }),
    }),
  ],
});
const t0 = performance.now();
const ms = () => `${Math.round(performance.now() - t0)}ms`;
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
console.log(`[${ms()}] sign-in service ready, tables made`);

// A tiny browser: keeps cookies, follows nothing by itself.
const jar = new Map();
async function go(path, init = {}) {
  const url = path.startsWith("http") ? path : BASE + path;
  const headers = new Headers(init.headers);
  headers.set("origin", BASE);
  if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  if (init.json) { headers.set("content-type", "application/json"); init.body = JSON.stringify(init.json); }
  const res = await auth.handler(new Request(url, { ...init, headers, redirect: "manual" }));
  for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  return res;
}
const show = async (label, res) => console.log(`  ${label}: ${res.status} ${(res.headers.get("location") ?? (await res.clone().text())).slice(0, 260)}`);

try {
  // 1. thousands of apps, each an address the service will issue tokens for
  const tables = (await pool.query("select table_name from information_schema.tables where table_schema = 'signin' order by 1")).rows.map((r) => r.table_name);
  console.log(`[${ms()}] tables: ${tables.join(", ")}`);
  const cols = (await pool.query("select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'signin' and table_name = 'oauthResource' order by ordinal_position")).rows;
  console.log("  oauthResource columns:", cols.map((c) => `${c.column_name}${c.is_nullable === "NO" ? "*" : ""}`).join(", "));
  await pool.query(`insert into signin."oauthResource" (id, identifier, name, "createdAt", "updatedAt") select 'res-' || i, 'https://app' || i || '.apps.test/mcp', 'App ' || i, now(), now() from generate_series(1, $1) i`, [APPS]);
  console.log(`[${ms()}] ${APPS} apps added as rows`);
  const RESOURCE = "https://app1234.apps.test/mcp", REDIRECT = "https://assistant.example/callback";

  // 2. the assistant registers itself, with no account and no secret
  const reg = await go("/api/auth/oauth2/register", { method: "POST", json: { client_name: "An assistant", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "openid email offline_access" } });
  await show("register", reg);
  const client = await reg.json();

  // 3. it sends the person to sign in. They aren't signed in yet, so they land on the sign-in page.
  const verifier = randomBytes(32).toString("base64url");
  const ask = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, scope: "openid email offline_access", state: "xyz", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: RESOURCE });
  const first = await go(`/api/auth/oauth2/authorize?${ask}`);
  await show("authorize, not signed in", first);

  // 4. the person signs in with an emailed code
  await show("send code", await go("/api/auth/email-otp/send-verification-otp", { method: "POST", json: { email: "maker@example.com", type: "sign-in" } }));
  const signedIn = await go("/api/auth/sign-in/email-otp", { method: "POST", json: { email: "maker@example.com", otp: sent["maker@example.com"], oauth_query: new URL(first.headers.get("location"), BASE).search.slice(1) } });
  await show("sign in with the code", signedIn);
  // 5. they agree that the assistant may act for them in this app
  const consentQuery = new URL((await signedIn.json()).url, BASE).search.slice(1);
  const consent = await go("/api/auth/oauth2/consent", { method: "POST", json: { accept: true, oauth_query: consentQuery } });
  await show("consent", consent);
  const back = new URL((await consent.json()).url ?? consent.headers.get("location"));
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), "xyz");

  // 6. the assistant swaps the code for a token
  const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });
  jar.clear(); // the assistant is not the person's browser
  const tokenRes = await go("/api/auth/oauth2/token", form({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: RESOURCE }));
  const tokens = await tokenRes.json();
  console.log(`  token: ${tokenRes.status} ${Object.keys(tokens).join(", ")}`);

  // 7. the app checks the token the way any app would: against the service's public keys
  const keys = createLocalJWKSet(await (await go("/api/auth/jwks")).json());
  const meta = await (await go("/api/auth/.well-known/oauth-authorization-server")).json().catch(() => ({}));
  const { payload } = await jwtVerify(tokens.access_token, keys, { audience: RESOURCE });
  console.log(`  token says: for ${payload.aud}, person ${payload.email} (verified: ${payload.email_verified}), from ${payload.iss}, good for ${payload.exp - payload.iat}s`);
  assert.equal(payload.email, "maker@example.com");
  assert.equal(payload.email_verified, true);
  await assert.rejects(jwtVerify(tokens.access_token, keys, { audience: "https://app99.apps.test/mcp" }), /aud/, "no good at another app");

  // 8. what must not work
  const bad = await go(`/api/auth/oauth2/authorize?${new URLSearchParams({ ...Object.fromEntries(ask), resource: "https://not-an-app.example/mcp" })}`);
  console.log(`  a token for an address that isn't one of the apps: ${bad.status} ${(bad.headers.get("location") ?? await bad.text()).slice(0, 160)}`);
  // 8b. staying signed in: a fresh token without asking the person again
  if (tokens.refresh_token) {
    const fresh = await go("/api/auth/oauth2/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource: RESOURCE }));
    console.log(`  refresh: ${fresh.status} ${fresh.status === 200 ? '' : (await fresh.clone().text()).slice(0, 200)}`);
    assert.equal(fresh.status, 200);
  } else console.log("  refresh: no refresh token was given");
  // 9. a code can be used once; trying again is refused
  const again = await go("/api/auth/oauth2/token", form({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: RESOURCE }));
  console.log(`  using the same code twice: ${again.status}`);
  assert.notEqual(again.status, 200);

  console.log(`  metadata lists: ${Object.keys(meta).slice(0, 8).join(", ")}`);
  console.log(`\n[${ms()}] all good`);
} catch (e) { console.log("ERR", e); process.exitCode = 1; }
finally { await db.end(); await pool.end(); }
