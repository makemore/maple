// Stands in for @neon/oauth/mcp/hono on the shared runner: checks the signed token on /mcp against
// Grove's sign-in service, and publishes where to sign in. The token carries the person's verified
// email, so the app never looks anyone up.
import { createLocalJWKSet, jwtVerify } from "jose";

let keys, keysAt = 0;
async function signInKeys() {
  if (!keys || Date.now() - keysAt > 10 * 60_000) {
    const res = await fetch("http://signin.runner/jwks");
    if (!res.ok) throw new Error("sign-in keys unavailable");
    keys = createLocalJWKSet(await res.json());
    keysAt = Date.now();
  }
  return keys;
}

export const honoMcpBearerAuth = (auth) => async (c, next) => {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer /i, "");
  try {
    const { payload } = await jwtVerify(token, await signInKeys(), { issuer: auth.issuer, audience: auth.resource });
    c.set("auth", { sub: payload.sub, verifiedEmail: payload.email_verified ? payload.email : undefined });
  } catch {
    return c.json({ error: "invalid_token" }, 401, { "WWW-Authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", auth.resource)}"` });
  }
  return next();
};

export const honoProtectedResourceMetadata = (app, auth) =>
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json({ resource: auth.resource, authorization_servers: [auth.issuer], bearer_methods_supported: ["header"], scopes_supported: ["openid", "email", "offline_access"] }));
