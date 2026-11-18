// Makes a command-line token for Grove's maker straight in Grove's database and saves it where cli/grove.ts
// looks (~/.config/grove/config.json, readable only by you). For first use, before the CLI can ask Grove.
// Run: DATABASE_URL=$(neon connection-string --project-id snowy-hat-06906890 --branch main) node scripts/cli-token.ts
import pg from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeToken } from "../grove/src/tokens.ts";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows: [m] } = await pool.query("select email from maple_people where role = 'maker' order by email limit 1");
await pool.query("delete from cli_tokens where email = $1 and name = 'claude code'", [m.email]);
const token = await makeToken(pool, m.email, "claude code", 90);
const dir = join(homedir(), ".config", "grove");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "config.json"), JSON.stringify({ url: "https://makewithgrove.com", token }, null, 2) + "\n", { mode: 0o600 });
console.log("token saved for the maker account");
await pool.end();
