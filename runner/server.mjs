// The runner's web server. One small service does two jobs: Grove's sign-in, and running the
// apps that share it. Which one a request is for is decided by the address it came in on.
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { bundleForRunner } from "./build.mjs";
import { admin, SCHEMA, copyApp, dumpApp, pauseApp, putApp, removeApp, sqlAs } from "./db.mjs";
import * as signin from "./signin.mjs";
import { forget, ready, run, stop } from "./sandbox.mjs";
import { watchErrors } from "./errors.mjs";

watchErrors();

const DOMAIN = process.env.APPS_DOMAIN;
const SIGNIN_HOST = new URL(process.env.SIGNIN_URL).host;
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The address the person used. Only Grove's front door on Cloudflare is believed about that. */
function hostOf(req) {
  const edge = process.env.EDGE_SECRET, given = String(req.headers["x-edge-secret"] ?? "");
  const viaEdge = Boolean(edge && edge.length >= 16 && same(given, edge));
  return { host: String((viaEdge && req.headers["x-forwarded-host"]) || req.headers.host || "").toLowerCase(), viaEdge };
}

/** What Grove asks of the runner: store an app, copy one for a trial, hand over its data, remove it. Grove's token only. */
async function adminCall(req, path) {
  const token = process.env.RUNNER_ADMIN_TOKEN ?? "", given = String(req.headers.authorization ?? "").replace(/^Bearer /i, "");
  if (token.length < 32 || !same(given, token)) return Response.json({ error: "Not allowed." }, { status: 401 });
  const [, name, action, other] = path.match(/^\/apps\/([a-z0-9-]+)(?:\/([a-z-]+))?(?:\/([a-z0-9-]+))?$/) ?? [];
  if (!name) return Response.json({ error: "No such thing." }, { status: 404 });
  const body = ["POST", "PUT"].includes(req.method) ? await new Response(Readable.toWeb(req)).json().catch(() => ({})) : {};
  try {
    if (req.method === "PUT" && !action) {
      const code = await bundleForRunner(body.files);
      const put = await putApp(name, code, body.env ?? {});
      await signin.addApp(name, `https://${name}.${DOMAIN}/mcp`, String(body.title ?? name).slice(0, 200));
      forget(name);
      return Response.json({ ...put, address: `https://${name}.${DOMAIN}`, bytes: code.length });
    }
    if (req.method === "POST" && action === "copy-from") return Response.json(await copyApp(other, name));
    if (req.method === "POST" && action === "pause") return (await pauseApp(name, body.paused), forget(name), Response.json({ paused: Boolean(body.paused) }));
    if (req.method === "POST" && action === "sql") return Response.json({ rowCounts: await sqlAs(name, body.statements ?? []) });
    if (req.method === "GET" && action === "dump") return new Response(await dumpApp(name, "public", req.url.includes("inserts=1")), { headers: { "content-type": "application/sql" } });
    if (req.method === "DELETE" && !action) return (await signin.removeApp(name), forget(name), Response.json(await removeApp(name)));
    return Response.json({ error: "No such thing." }, { status: 404 });
  } catch (e) {
    console.error(`admin ${req.method} ${path}:`, e);
    const problems = e?.errors?.map?.((x) => `${x.location?.file ?? ""}:${x.location?.line ?? ""} ${x.text}`);
    return Response.json({ error: String(e?.message ?? e).slice(0, 2000), ...(problems && { problems }) }, { status: e?.status ?? (problems ? 422 : 500) });
  }
}

async function answer(req) {
  const { host, viaEdge } = hostOf(req);
  if (req.url === "/runner/health") return Response.json({ ok: true });
  if (req.url.startsWith("/runner/admin/")) return adminCall(req, req.url.slice("/runner/admin".length).split("?")[0]);
  // In production everything comes through the front door, so traffic limits can't be skipped.
  if (process.env.EDGE_SECRET && !viaEdge) return new Response("Not here.", { status: 404 });
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (!/^(x-runner-|x-edge-secret$|x-forwarded-host$|x-client-ip$|host$|connection$)/.test(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  // The visitor's own address, as the front door saw it. Nobody else is believed about that.
  if (viaEdge && req.headers["cf-connecting-ip"]) headers.set("x-client-ip", String(req.headers["cf-connecting-ip"]));
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : Readable.toWeb(req);
  const request = new Request(`https://${host}${req.url}`, { method: req.method, headers, body, duplex: "half", redirect: "manual" });
  if (host === SIGNIN_HOST) return signin.handle(request);
  if (DOMAIN && host.endsWith(`.${DOMAIN}`)) return run(host.slice(0, -DOMAIN.length - 1), request);
  return new Response("There is nothing at this address.", { status: 404 });
}

// Start answering straight away. Getting the database and sign-in ready happens alongside, and a
// request only waits for the part it needs. Each part says how long it took, to keep start-up honest.
const began = performance.now();
const took = (what) => (v) => (console.log(`start-up: ${what} ready after ${Math.round(performance.now() - began)}ms (process up ${Math.round(process.uptime() * 1000)}ms)`), v);
const prepared = admin.query(SCHEMA).then(took("database"));
const signInReady = prepared.then(() => signin.ready()).then(took("sign-in"));
ready.then(took("sandbox"));
prepared.catch((e) => console.error("start-up failed:", e));
signInReady.catch((e) => console.error("sign-in start-up failed:", e));

const server = createServer(async (req, res) => {
  try {
    if (req.url !== "/runner/health") await (hostOf(req).host === SIGNIN_HOST || req.url.startsWith("/runner/admin/") ? signInReady : prepared);
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
// Only take requests once the sandbox is up, so a new copy of the runner is never sent visitors it can't serve yet.
await ready;
server.listen(port, () => console.log(`runner listening on ${port} after ${Math.round(performance.now() - began)}ms (process up ${Math.round(process.uptime() * 1000)}ms)`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => stop().finally(() => process.exit(0))));
