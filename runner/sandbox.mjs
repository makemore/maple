// The sealed boxes: one runtime (workerd) that loads each app's code when it is first asked for
// and runs it with no database password and no internet. See dispatcher.js for what runs inside.
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { admin, query } from "./db.mjs";
import { ISSUER, jwks } from "./signin.mjs";

const appEnv = (slug, stored) => ({
  ...stored,
  PUBLIC_URL: `https://${slug}.${process.env.APPS_DOMAIN}`,
  NEON_AUTH_BASE_URL: ISSUER(),
  AUTH_ISSUER: ISSUER(),
});

/** How many requests and database queries one app may make in a day before it is told to wait until tomorrow. */
const DAILY_REQUESTS = Number(process.env.APP_DAILY_REQUESTS ?? 20_000), DAILY_QUERIES = Number(process.env.APP_DAILY_QUERIES ?? 100_000);
const REQUEST_MS = Number(process.env.APP_REQUEST_MS ?? 60_000), MAX_BODY = 8_000_000;

const versions = new Map(); // slug -> { at, version, paused, requests, queries }
async function about(slug) {
  const known = versions.get(slug);
  if (known && Date.now() - known.at < 15_000) return known;
  const { rows: [a] } = await admin.query("select a.version, a.paused, coalesce(u.requests, 0) requests, coalesce(u.queries, 0) queries from runner.apps a left join runner.usage u on u.slug = a.slug and u.day = current_date where a.slug = $1", [slug]);
  const now = { at: Date.now(), version: a ? Number(a.version) : 0, paused: Boolean(a?.paused), requests: Number(a?.requests ?? 0), queries: Number(a?.queries ?? 0) };
  versions.set(slug, now);
  return now;
}

/** One sandbox runtime. Apps loaded into it stay in memory (about 14 MB each, measured), so it is replaced before it fills. */
const start = () => new Miniflare({
  modules: [{ type: "ESModule", path: "dispatcher.js", contents: readFileSync(new URL("dispatcher.js", import.meta.url), "utf8") }],
  compatibilityDate: "2026-06-01",
  compatibilityFlags: ["nodejs_compat"],
  workerLoaders: { LOADER: {} },
  bindings: { GROVE_ORIGIN: process.env.GROVE_URL ? new URL(process.env.GROVE_URL).origin : "", CPU_MS: String(process.env.APP_CPU_MS ?? 2000) },
  serviceBindings: {
    // Where app code comes from.
    CODE: async (request) => {
      const url = new URL(request.url), slug = url.pathname.slice(1);
      if (url.searchParams.has("meta")) return Response.json({ version: (await about(slug)).version });
      const { rows: [a] } = await admin.query("select version, code, env from runner.apps where slug = $1", [slug]);
      return a ? Response.json({ code: a.code, env: appEnv(slug, a.env) }) : Response.json({});
    },
    // The database desk. Which app is asking comes from the runner, never from anything the app says.
    DBGW: async (request) => {
      const slug = request.headers.get("x-app");
      try {
        if ((await about(slug)).queries > DAILY_QUERIES) throw Object.assign(new Error("This app has used the database as much as it can today."), { code: "RUNNER" });
        const { text, values } = await request.json();
        admin.query("insert into runner.usage (slug, queries) values ($1, 1) on conflict (slug, day) do update set queries = runner.usage.queries + 1", [slug]).catch(() => {});
        return Response.json(await query(slug, text, values));
      } catch (e) {
        return Response.json({ error: e.message, code: e.code }, { status: 400 });
      }
    },
    // The sign-in service's public keys, so an app can check a token without reaching the internet.
    SIGNIN: () => jwks(),
  },
});

// How many different apps one sandbox holds before a fresh one takes over. The old one finishes what
// it is doing and is then closed, which is what gives the memory back. An app that is used again
// simply loads into the new one (well under a second).
const MAX_WARM = Number(process.env.MAX_WARM_APPS ?? 40);
const fresh = async () => {
  const mf = start();
  await mf.ready;
  return { mf, warm: new Set(), busy: 0 };
};
/** Closes a retired sandbox as soon as it has nothing left to do, or after a while regardless. */
function retire(old) {
  const since = Date.now();
  const check = setInterval(() => {
    if ((old.busy === 0 && Date.now() - since > 3000) || Date.now() - since > REQUEST_MS + 15_000) {
      clearInterval(check);
      old.mf.dispose().catch(() => {});
    }
  }, 1000);
  check.unref();
}
// The first sandbox starts while the server is already listening; a request for an app waits for it.
let now, turning;
export const ready = fresh().then((box) => (now = box));
async function sandboxFor(slug) {
  await ready;
  if (!now.warm.has(slug) && now.warm.size >= MAX_WARM) {
    turning ??= (async () => {
      const old = now;
      now = await fresh();
      console.log(`sandbox replaced after ${old.warm.size} apps`);
      retire(old);
    })().finally(() => (turning = undefined));
    await turning;
  }
  now.warm.add(slug);
  return now;
}

/** How many requests one app may have going at once. */
const MAX_AT_ONCE = Number(process.env.APP_MAX_AT_ONCE ?? 12);
const going = new Map();

/** Runs a request in the app's box. */
export async function run(slug, request) {
  const a = await about(slug);
  if (!a.version) return new Response("There is no app at this address.", { status: 404 });
  if (a.paused) return new Response("This app is paused.", { status: 503 });
  if (a.requests > DAILY_REQUESTS) return new Response("This app has been used as much as it can be today. It will be back tomorrow.", { status: 429, headers: { "retry-after": "3600" } });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return new Response("That is too much to send in one go.", { status: 413 });
  admin.query("insert into runner.usage (slug, requests) values ($1, 1) on conflict (slug, day) do update set requests = runner.usage.requests + 1", [slug]).catch(() => {});
  const headers = new Headers(request.headers);
  headers.set("x-runner-app", slug);
  headers.set("x-runner-version", String(a.version));
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  if (body && body.byteLength > MAX_BODY) return new Response("That is too much to send in one go.", { status: 413 });
  if ((going.get(slug) ?? 0) >= MAX_AT_ONCE) return new Response("This app is busy. Try again in a moment.", { status: 429, headers: { "retry-after": "2" } });
  going.set(slug, (going.get(slug) ?? 0) + 1);
  try {
    const box = await sandboxFor(slug);
    box.busy++;
    try {
      return await box.mf.dispatchFetch(request.url, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(REQUEST_MS) });
    } finally {
      // The answer may still be on its way out; give it a moment before this sandbox counts as idle.
      setTimeout(() => box.busy--, 2000).unref();
    }
  } catch (e) {
    console.error(`app ${slug} failed:`, String(e?.message ?? e).slice(0, 300));
    return new Response(e?.name === "TimeoutError" ? "This app took too long to answer." : "This app hit a problem.", { status: e?.name === "TimeoutError" ? 504 : 500 });
  } finally {
    const n = (going.get(slug) ?? 1) - 1;
    n > 0 ? going.set(slug, n) : going.delete(slug);
  }
}
/** Forget what is remembered about an app, so a change shows straight away. */
export const forget = (slug) => versions.delete(slug);
export const stop = () => ready.then(() => now.mf.dispose());
