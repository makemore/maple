// Personal tokens for Grove's command line (cli/grove.ts) and scripts: the same tools as the assistant
// gets, without OAuth. Only a hash is kept; the token is shown once, when it is made.
import { createHash, randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Pool } from "pg";
import { z, type Ctx } from "../../kit/kit.ts";

export const TOKENS_SCHEMA = `
create table if not exists cli_tokens (
  hash text primary key, email text not null, name text not null, created_at timestamptz not null default now(),
  last_used timestamptz, expires_at timestamptz not null default now() + interval '90 days');
create index if not exists cli_tokens_email on cli_tokens (email);`;

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
export const MAX_TOKENS = 5;

/** A new token for this person. */
export async function makeToken(pool: Pool, email: string, name: string, days = 90) {
  const token = `grove_${randomBytes(24).toString("base64url")}`;
  await pool.query("insert into cli_tokens (hash, email, name, expires_at) values ($1, $2, $3, now() + make_interval(days => $4))", [hashOf(token), email.toLowerCase(), name, days]);
  return token;
}

/** Whose token it is, while it hasn't run out. */
export async function tokenEmail(pool: Pool, token: string) {
  const { rows: [t] } = await pool.query("update cli_tokens set last_used = now() where hash = $1 and expires_at > now() returning email", [hashOf(token)]);
  return t?.email as string | undefined;
}

export function tokenTools(server: McpServer, d: { pool: Pool; ctx: Ctx; init: () => Promise<unknown>; mustAgree: () => Promise<void> }) {
  const { pool, ctx, init, mustAgree } = d;
  const { json, person } = ctx;

  server.registerTool(
    "make_cli_token",
    {
      title: "A token for Grove's command line",
      description:
        "Makes a personal token so the person (or their coding agent) can use Grove from a terminal with Grove's command line (cli/grove.ts in the MAPLE repo: node cli/grove.ts login <token>), with the same tools as here. It's shown once and lasts 90 days; anyone holding it can act as this person, so it goes only into their own terminal. cli_tokens lists them and revoke_cli_token ends one.",
      inputSchema: { name: z.string().min(1).max(60).describe("What it's for, e.g. 'laptop' or 'claude code'"), days: z.number().int().min(1).max(365).optional() },
    },
    async ({ name, days }) => {
      await init();
      await mustAgree();
      const { rows: [{ n }] } = await pool.query("select count(*)::int n from cli_tokens where email = $1 and expires_at > now()", [person.email]);
      if (n >= MAX_TOKENS) throw new Error(`There are already ${n} tokens: revoke_cli_token one first.`);
      const token = await makeToken(pool, person.email, name, days ?? 90);
      return json({ token, use: `node cli/grove.ts login ${token}`, note: "Shown once. Keep it like a password." });
    },
  );

  server.registerTool(
    "cli_tokens",
    { title: "Command-line tokens", annotations: { readOnlyHint: true }, description: "The person's command-line tokens: names, when made, last used and when they run out. Never the tokens themselves.", inputSchema: {} },
    async () => {
      await init();
      const { rows } = await pool.query("select name, created_at, last_used, expires_at from cli_tokens where email = $1 order by created_at desc", [person.email]);
      return json({ tokens: rows });
    },
  );

  server.registerTool(
    "revoke_cli_token",
    { title: "End a command-line token", description: "Stops a command-line token working, by its name.", inputSchema: { name: z.string() } },
    async ({ name }) => {
      await init();
      const r = await pool.query("delete from cli_tokens where email = $1 and name = $2", [person.email, name]);
      return json({ revoked: r.rowCount });
    },
  );
}
