// The shared Postgres: one server, and for each app its own schema and its own login that can see
// nothing else. The runner keeps a short-lived pool per app; an app's code never holds a password.
import { createHmac } from "node:crypto";
import pg from "pg";

const secret = () => {
  if (!process.env.RUNNER_SECRET || process.env.RUNNER_SECRET.length < 32) throw new Error("RUNNER_SECRET is missing or too short.");
  return process.env.RUNNER_SECRET;
};
export const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
admin.on("error", (e) => console.error("admin pool:", e.message));

/** An app's login says nothing about the app: its name is a hash, and so is its password. */
export const loginFor = (slug) => {
  const h = (what) => createHmac("sha256", secret()).update(`${what}:${slug}`).digest("hex");
  return { role: `a_${h("role").slice(0, 24)}`, password: h("password") };
};

export const SCHEMA = `
create schema if not exists runner;
create table if not exists runner.apps (
  slug text primary key, version bigint not null default 1, code text not null, env jsonb not null default '{}',
  paused boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists runner.usage (slug text not null, day date not null default current_date, requests bigint not null default 0, queries bigint not null default 0, primary key (slug, day));
revoke all on schema public from public;`;

/** Makes (or keeps) an app's schema and login, and stores its code. Safe to run again for a new version. */
export async function putApp(slug, code, env = {}) {
  if (!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) throw new Error("Not an app name.");
  const { role, password } = loginFor(slug);
  const c = await admin.connect();
  try {
    await c.query("select pg_advisory_lock(hashtext($1))", [slug]);
    const { rowCount } = await c.query("select 1 from pg_roles where rolname = $1", [role]);
    if (!rowCount) await c.query(`create role "${role}" login password '${password}' connection limit 4`);
    await c.query(`grant "${role}" to current_user`).catch(() => {});
    await c.query(`create schema if not exists "${role}" authorization "${role}"`);
    await c.query(`alter role "${role}" set search_path = "${role}"`);
    await c.query(`alter role "${role}" set statement_timeout = '5s'`);
    await c.query(`alter role "${role}" set idle_in_transaction_session_timeout = '10s'`);
    const { rows: [a] } = await c.query(
      "insert into runner.apps (slug, code, env) values ($1, $2, $3) on conflict (slug) do update set code = $2, env = $3, version = runner.apps.version + 1, updated_at = now() returning version",
      [slug, code, JSON.stringify(env)],
    );
    return { slug, version: Number(a.version), role };
  } finally {
    await c.query("select pg_advisory_unlock(hashtext($1))", [slug]).catch(() => {});
    c.release();
  }
}

// --- the database desk: runs an app's queries as that app's own login
const pools = new Map(); // slug -> { pool, used }
const IDLE_MS = 60_000;
function poolFor(slug) {
  let p = pools.get(slug);
  if (!p) {
    const { role, password } = loginFor(slug);
    const url = new URL(process.env.DATABASE_URL);
    url.username = role;
    url.password = password;
    const pool = new pg.Pool({ connectionString: url.toString(), max: 3, idleTimeoutMillis: 20_000 });
    pool.on("error", () => {});
    pools.set(slug, (p = { pool, used: 0 }));
  }
  p.used = Date.now();
  return p.pool;
}
setInterval(() => {
  for (const [slug, p] of pools) if (Date.now() - p.used > IDLE_MS) (pools.delete(slug), p.pool.end().catch(() => {}));
}, 30_000).unref();

const MAX_ROWS = 5000, MAX_BYTES = 2_000_000;
export async function query(slug, text, values) {
  if (typeof text !== "string" || text.length > 100_000) throw Object.assign(new Error("That query is too long."), { code: "RUNNER" });
  // Several statements in one go are fine (the kit makes its tables that way): the app is held in by
  // its login, which can reach nothing but its own schema, not by what its SQL says.
  const res = await poolFor(slug).query(text, Array.isArray(values) && values.length ? values : undefined);
  const r = Array.isArray(res) ? res[res.length - 1] : res;
  const rows = (r.rows ?? []).slice(0, MAX_ROWS);
  const out = { rows, rowCount: r.rowCount ?? 0 };
  if (JSON.stringify(out).length > MAX_BYTES) throw Object.assign(new Error("That query returned too much. Ask for fewer rows."), { code: "RUNNER" });
  return out;
}
