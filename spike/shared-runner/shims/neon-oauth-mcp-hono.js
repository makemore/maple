// Stands in for @neon/oauth/mcp/hono: checks the signed token on /mcp and publishes where to sign in.
import { createLocalJWKSet, jwtVerify } from "jose";
export const honoMcpBearerAuth = (auth) => {
  const keys = createLocalJWKSet(auth.jwks);
  return async (c, next) => {
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer /i, "");
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: auth.issuer, audience: auth.resource });
      // The shared sign-in service puts the email it verified in the token, so the app never looks anyone up.
      c.set("auth", { sub: payload.sub, verifiedEmail: payload.email_verified ? payload.email : undefined });
    } catch {
      return c.json({ error: "invalid_token" }, 401, { "WWW-Authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", auth.resource)}"` });
    }
    return next();
  };
};
export const honoProtectedResourceMetadata = (app, auth) =>
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json({ resource: auth.resource, authorization_servers: [auth.issuer] }));
