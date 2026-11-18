// Stands in for @neon/oauth/mcp: who signed the tokens this app accepts, and what address they are for.
// The public keys are fetched from the sign-in service through the runner (the app itself has no internet).
export const createMcpAuth = (o) => ({ ...o, issuer: process.env.AUTH_ISSUER });
