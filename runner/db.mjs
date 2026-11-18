// The shared Postgres: one server, and for each app its own schema and its own login that can see
// nothing else. The runner keeps a short-lived pool per app; an app's code never holds a password.
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
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

export const NAME = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
const named = (slug) => {
  if (typeof slug !== "string" || !NAME.test(slug)) throw Object.assign(new Error("Not an app name."), { status: 400 });
  return slug;
};

/** Makes (or keeps) an app's schema and its own login. */
async function ensureLogin(c, slug) {
  const { role, password } = loginFor(named(slug));
  const { rowCount } = await c.query("select 1 from pg_roles where rolname = $1", [role]);
  if (!rowCount) await c.query(`create role "${role}" login password '${password}' connection limit 4`);
  await c.query(`grant "${role}" to current_user`).catch(() => {});
  await c.query(`create schema if not exists "${role}" authorization "${role}"`);
  await c.query(`alter role "${role}" set search_path = "${role}"`);
  await c.query(`alter role "${role}" set statement_timeout = '5s'`);
  await c.query(`alter role "${role}" set idle_in_transaction_session_timeout = '10s'`);
  return role;
}

async function locked(slug, f) {
  const c = await admin.connect();
  try {
    await c.query("select pg_advisory_lock(hashtext($1))", [slug]);
    return await f(c);
  } finally {
    await c.query("select pg_advisory_unlock(hashtext($1))", [slug]).catch(() => {});
    c.release();
  }
}

/** Stores an app's code, making its schema and login if it is new. Safe to run again for a new version. */
export const putApp = (slug, code, env = {}) =>
  locked(slug, async (c) => {
    const role = await ensureLogin(c, slug);
    const { rows: [a] } = await c.query(
      "insert into runner.apps (slug, code, env) values ($1, $2, $3) on conflict (slug) do update set code = $2, env = $3, version = runner.apps.version + 1, paused = false, updated_at = now() returning version",
      [slug, code, JSON.stringify(env)],
    );
    return { slug, version: Number(a.version), role };
  });

const urlAs = (slug) => {
  const { role, password } = loginFor(slug);
  const url = new URL(process.env.DATABASE_URL);
  url.username = role;
  url.password = password;
  return url.toString();
};

function tool(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${err.slice(-400)}`))));
    p.stdin.end(input ?? "");
  });
}

/** An app's tables and everything in them, as SQL. With `as`, written for a schema of that name instead of its own. */
export async function dumpApp(slug, as) {
  const { role } = loginFor(named(slug));
  const sql = await tool("pg_dump", ["--schema", role, "--no-owner", "--no-privileges", "--no-comments", process.env.DATABASE_URL]);
  // The login's name is a long random-looking word that appears nowhere else, so swapping it is safe.
  return sql.split("\n").filter((l) => !/^CREATE SCHEMA /.test(l) && !/^\\(un)?restrict /.test(l)).join("\n").replaceAll(`"${role}"`, `"${as ?? role}"`).replaceAll(role, as ?? role);
}

/** A trial copy: makes `target` with a copy of everything in `source`, as it is right now. */
export const copyApp = (source, target) =>
  locked(target, async (c) => {
    const role = await ensureLogin(c, target);
    await c.query(`drop schema "${role}" cascade`);
    await c.query(`create schema "${role}" authorization "${role}"`);
    const sql = await dumpApp(source, role);
    await tool("psql", ["--quiet", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", urlAs(target)], sql);
    return { copied: source, to: target };
  });

/** Removes an app for good: its tables, its login and its code. */
export const removeApp = (slug) =>
  locked(slug, async (c) => {
    const { role } = loginFor(named(slug));
    pools.get(slug)?.pool.end().catch(() => {});
    pools.delete(slug);
    await c.query("delete from runner.apps where slug = $1", [slug]);
    await c.query("delete from runner.usage where slug = $1", [slug]);
    await c.query(`drop schema if exists "${role}" cascade`);
    await c.query("select pg_terminate_backend(pid) from pg_stat_activity where usename = $1", [role]).catch(() => {});
    await c.query(`drop role if exists "${role}"`);
    return { removed: slug };
  });

export const pauseApp = (slug, paused) => admin.query("update runner.apps set paused = $2, updated_at = now() where slug = $1", [named(slug), Boolean(paused)]);

/** Runs statements as the app's own login, for Grove itself (e.g. changing who the maker is). */
export async function sqlAs(slug, statements) {
  const c = new pg.Client({ connectionString: urlAs(named(slug)) });
  await c.connect();
  try {
    const out = [];
    for (const st of statements) out.push((await c.query(st.text, st.values ?? [])).rowCount ?? 0);
    return out;
  } finally {
    await c.end();
  }
}

// --- the database desk: runs an app's queries as that app's own login
const pools = new Map(); // slug -> { pool, used }
const IDLE_MS = 60_000;
function poolFor(slug) {
  let p = pools.get(slug);
  if (!p) {
    const pool = new pg.Pool({ connectionString: urlAs(slug), max: 3, idleTimeoutMillis: 20_000 });
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
  // Which columns are dates or raw bytes, so the app's side can turn them back into what "pg" would have given.
  const types = Object.fromEntries((r.fields ?? []).filter((f) => [17, 1082, 1114, 1184, 1115, 1182, 1185].includes(f.dataTypeID)).map((f) => [f.name, f.dataTypeID]));
  for (const [name, type] of Object.entries(types)) if (type === 17) for (const row of rows) if (row[name]) row[name] = Buffer.from(row[name]).toString("base64");
  const out = { rows, rowCount: r.rowCount ?? 0, ...(Object.keys(types).length && { types }) };
  if (JSON.stringify(out).length > MAX_BYTES) throw Object.assign(new Error("That query returned too much. Ask for fewer rows."), { code: "RUNNER" });
  return out;
}
