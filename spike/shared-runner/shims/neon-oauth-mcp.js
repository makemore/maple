// Stands in for @neon/oauth/mcp: who signed the tokens this app accepts, and what address they are for.
export const createMcpAuth = (o) => ({ ...o, jwks: JSON.parse(process.env.AUTH_JWKS), issuer: process.env.AUTH_ISSUER });
