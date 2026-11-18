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

const versions = new Map(); // slug -> { at, version, paused }
async function about(slug) {
  const known = versions.get(slug);
  if (known && Date.now() - known.at < 15_000) return known;
  const { rows: [a] } = await admin.query("select version, paused from runner.apps where slug = $1", [slug]);
  const now = { at: Date.now(), version: a ? Number(a.version) : 0, paused: Boolean(a?.paused) };
  versions.set(slug, now);
  return now;
}

const mf = new Miniflare({
  modules: [{ type: "ESModule", path: "dispatcher.js", contents: readFileSync(new URL("dispatcher.js", import.meta.url), "utf8") }],
  compatibilityDate: "2026-06-01",
  compatibilityFlags: ["nodejs_compat"],
  workerLoaders: { LOADER: {} },
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
await mf.ready;

/** Runs a request in the app's box. */
export async function run(slug, request) {
  const a = await about(slug);
  if (!a.version) return new Response("There is no app at this address.", { status: 404 });
  if (a.paused) return new Response("This app is paused.", { status: 503 });
  admin.query("insert into runner.usage (slug, requests) values ($1, 1) on conflict (slug, day) do update set requests = runner.usage.requests + 1", [slug]).catch(() => {});
  const headers = new Headers(request.headers);
  headers.set("x-runner-app", slug);
  headers.set("x-runner-version", String(a.version));
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  return mf.dispatchFetch(request.url, { method: request.method, headers, body, redirect: "manual" });
}
export const stop = () => mf.dispose();
