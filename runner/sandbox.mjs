// The desk's side of running apps. App code itself runs in a separate service (boxes.mjs) that holds
// no credentials. Here the desk decides whether a request may run at all (is there such an app, is
// it paused, has it had its day's share), hands it to the sandbox with a short-lived pass for that
// one app, and answers what the sandbox asks for on the app's behalf: its code, its queries, and
// the sign-in service's public keys.
import { createHmac, timingSafeEqual } from "node:crypto";
import { admin, query } from "./db.mjs";
import { ISSUER, jwks } from "./signin.mjs";

const SANDBOX = () => process.env.SANDBOX_URL.replace(/\/$/, "");
const appEnv = (slug, stored) => ({
  ...stored,
  PUBLIC_URL: `https://${slug}.${process.env.APPS_DOMAIN}`,
  NEON_AUTH_BASE_URL: ISSUER(),
  AUTH_ISSUER: ISSUER(),
});

/** How many requests and database queries one app may make in a day before it is told to wait until tomorrow. */
const DAILY_REQUESTS = Number(process.env.APP_DAILY_REQUESTS ?? 20_000), DAILY_QUERIES = Number(process.env.APP_DAILY_QUERIES ?? 100_000);
const REQUEST_MS = Number(process.env.APP_REQUEST_MS ?? 60_000), MAX_BODY = 8_000_000;
/** How many requests one app may have going at once. */
const MAX_AT_ONCE = Number(process.env.APP_MAX_AT_ONCE ?? 12);
const going = new Map();

const versions = new Map(); // slug -> { at, version, paused, requests, queries }
async function about(slug) {
  const known = versions.get(slug);
  if (known && Date.now() - known.at < 15_000) return known;
  const { rows: [a] } = await admin.query("select a.version, a.paused, coalesce(u.requests, 0) requests, coalesce(u.queries, 0) queries from runner.apps a left join runner.usage u on u.slug = a.slug and u.day = current_date where a.slug = $1", [slug]);
  const now = { at: Date.now(), version: a ? Number(a.version) : 0, paused: Boolean(a?.paused), requests: Number(a?.requests ?? 0), queries: Number(a?.queries ?? 0) };
  versions.set(slug, now);
  return now;
}

// --- passes: "this is for app X, until time T", signed with a key only the desk has
const PASS_SECONDS = 150;
const sign = (what) => createHmac("sha256", `pass:${process.env.RUNNER_SECRET}`).update(what).digest("hex");
export const passFor = (slug, now = Date.now()) => {
  const until = Math.floor(now / 1000) + PASS_SECONDS;
  return `${slug}.${until}.${sign(`${slug}.${until}`)}`;
};
/** The app a pass is for, or undefined if it is forged or has run out. */
export function appOf(pass, now = Date.now()) {
  const [slug, until, sig] = String(pass ?? "").split(".");
  if (!slug || !until || !sig) return undefined;
  const want = sign(`${slug}.${until}`);
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want)) || Number(until) * 1000 < now) return undefined;
  return slug;
}

/** Runs a request in the app's box. */
export async function run(slug, request) {
  const a = await about(slug);
  if (!a.version) return new Response("There is no app at this address.", { status: 404 });
  if (a.paused) return new Response("This app is paused.", { status: 503 });
  if (a.requests > DAILY_REQUESTS) return new Response("This app has been used as much as it can be today. It will be back tomorrow.", { status: 429, headers: { "retry-after": "3600" } });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return new Response("That is too much to send in one go.", { status: 413 });
  admin.query("insert into runner.usage (slug, requests) values ($1, 1) on conflict (slug, day) do update set requests = runner.usage.requests + 1", [slug]).catch(() => {});
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  if (body && body.byteLength > MAX_BODY) return new Response("That is too much to send in one go.", { status: 413 });
  if ((going.get(slug) ?? 0) >= MAX_AT_ONCE) return new Response("This app is busy. Try again in a moment.", { status: 429, headers: { "retry-after": "2" } });
  going.set(slug, (going.get(slug) ?? 0) + 1);
  try {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const h of ["host", "content-length", "connection"]) headers.delete(h);
    headers.set("x-sandbox-token", process.env.SANDBOX_TOKEN);
    headers.set("x-runner-app", slug);
    headers.set("x-runner-version", String(a.version));
    headers.set("x-runner-host", url.host);
    headers.set("x-runner-pass", passFor(slug));
    return await fetch(`${SANDBOX()}${url.pathname}${url.search}`, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(REQUEST_MS + 5000) });
  } catch (e) {
    console.error(`app ${slug} failed:`, String(e?.message ?? e).slice(0, 300));
    return new Response(e?.name === "TimeoutError" ? "This app took too long to answer." : "This app hit a problem.", { status: e?.name === "TimeoutError" ? 504 : 502 });
  } finally {
    const n = (going.get(slug) ?? 1) - 1;
    n > 0 ? going.set(slug, n) : going.delete(slug);
  }
}

/** What the sandbox asks the desk for. Which app it is for comes from the pass, never from the request itself. */
export async function internal(path, pass, body) {
  const slug = appOf(pass);
  if (!slug) return Response.json({ error: "No pass, or it has run out.", code: "RUNNER" }, { status: 401 });
  if (path === "/code") {
    const { rows: [a] } = await admin.query("select code, env from runner.apps where slug = $1", [slug]);
    return a ? Response.json({ code: a.code, env: appEnv(slug, a.env) }) : Response.json({}, { status: 404 });
  }
  if (path === "/jwks") return jwks();
  if (path === "/query") {
    try {
      if ((await about(slug)).queries > DAILY_QUERIES) throw Object.assign(new Error("This app has used the database as much as it can today."), { code: "RUNNER" });
      const { text, values } = JSON.parse(body);
      admin.query("insert into runner.usage (slug, queries) values ($1, 1) on conflict (slug, day) do update set queries = runner.usage.queries + 1", [slug]).catch(() => {});
      return Response.json(await query(slug, text, values));
    } catch (e) {
      return Response.json({ error: e.message, code: e.code }, { status: 400 });
    }
  }
  return Response.json({ error: "No such thing." }, { status: 404 });
}

/** Forget what is remembered about an app, so a change shows straight away. */
export const forget = (slug) => versions.delete(slug);
/** Wakes the sandbox service too, when something is keeping the desk awake. */
export const nudge = () => void fetch(`${SANDBOX()}/runner/health`, { signal: AbortSignal.timeout(20_000) }).catch(() => {});
