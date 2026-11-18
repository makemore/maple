// The sandbox service: the only place app code runs. It holds no database password, no sign-in keys
// and no way to manage apps. Everything an app needs from outside (its code, its queries, the
// sign-in service's public keys) it asks the runner's desk for, showing a short-lived pass that the
// desk issued for that one app. So even code that broke out of its sealed box would find nothing
// here but passes for the apps in use at that moment.
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { Miniflare } from "miniflare";

const DESK = process.env.DESK_URL.replace(/\/$/, "");
const REQUEST_MS = Number(process.env.APP_REQUEST_MS ?? 60_000);
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const desk = (path, pass, init = {}) => fetch(`${DESK}/runner/internal${path}`, { ...init, headers: { ...init.headers, "x-runner-pass": pass ?? "" } });

/** One sandbox runtime. Apps loaded into it stay in memory (about 14 MB each, measured), so it is replaced before it fills. */
const start = () => new Miniflare({
  modules: [{ type: "ESModule", path: "dispatcher.js", contents: readFileSync(new URL("dispatcher.js", import.meta.url), "utf8") }],
  compatibilityDate: "2026-06-01",
  compatibilityFlags: ["nodejs_compat"],
  workerLoaders: { LOADER: {} },
  bindings: { GROVE_ORIGIN: process.env.GROVE_URL ? new URL(process.env.GROVE_URL).origin : "", CPU_MS: String(process.env.APP_CPU_MS ?? 2000) },
  serviceBindings: {
    // Each of these passes on the app's pass; the desk decides what it allows.
    CODE: (request) => desk("/code", request.headers.get("x-runner-pass")),
    DBGW: async (request) => desk("/query", request.headers.get("x-runner-pass"), { method: "POST", body: await request.text() }),
    SIGNIN: (request) => desk("/jwks", request.headers.get("x-runner-pass")),
  },
});

// How many different apps one sandbox holds before a fresh one takes over. The old one finishes what
// it is doing and is then closed, which is what gives the memory back.
const MAX_WARM = Number(process.env.MAX_WARM_APPS ?? 40);
const fresh = async () => {
  const mf = start();
  await mf.ready;
  return { mf, warm: new Set(), busy: 0 };
};
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
const began = performance.now();
let now = await fresh(), turning;
async function sandboxFor(slug) {
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

async function answer(req) {
  if (req.url === "/runner/health") return Response.json({ ok: true, role: "sandbox" });
  // Only the desk may send work here.
  const token = process.env.SANDBOX_TOKEN ?? "";
  if (token.length < 32 || !same(String(req.headers["x-sandbox-token"] ?? ""), token)) return new Response("Not here.", { status: 404 });
  const slug = String(req.headers["x-runner-app"] ?? ""), host = String(req.headers["x-runner-host"] ?? "");
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (!/^(x-sandbox-token$|host$|connection$|content-length$)/.test(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await new Response(Readable.toWeb(req)).arrayBuffer();
  const box = await sandboxFor(slug);
  box.busy++;
  try {
    return await box.mf.dispatchFetch(`https://${host}${req.url}`, { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(REQUEST_MS) });
  } catch (e) {
    console.error(`app ${slug} failed:`, String(e?.message ?? e).slice(0, 300));
    return new Response(e?.name === "TimeoutError" ? "This app took too long to answer." : "This app hit a problem.", { status: e?.name === "TimeoutError" ? 504 : 500 });
  } finally {
    setTimeout(() => box.busy--, 2000).unref();
  }
}

const server = createServer(async (req, res) => {
  try {
    const out = await answer(req);
    const headers = {};
    out.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
    const cookies = out.headers.getSetCookie?.() ?? [];
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(out.status, headers);
    if (out.body) Readable.fromWeb(out.body).on("error", () => res.end()).pipe(res);
    else res.end();
  } catch (e) {
    console.error("request failed:", e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Something went wrong.");
  }
});
const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => console.log(`sandbox listening on ${port} after ${Math.round(performance.now() - began)}ms (process up ${Math.round(process.uptime() * 1000)}ms)`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => now.mf.dispose().finally(() => process.exit(0))));
