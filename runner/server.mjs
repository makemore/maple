// The runner's web server. One small service does two jobs: Grove's sign-in, and running the
// apps that share it. Which one a request is for is decided by the address it came in on.
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { admin, SCHEMA } from "./db.mjs";
import * as signin from "./signin.mjs";
import { run, stop } from "./sandbox.mjs";

const DOMAIN = process.env.APPS_DOMAIN;
const SIGNIN_HOST = new URL(process.env.SIGNIN_URL).host;
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The address the person used. Only Grove's front door on Cloudflare is believed about that. */
function hostOf(req) {
  const edge = process.env.EDGE_SECRET, given = String(req.headers["x-edge-secret"] ?? "");
  const viaEdge = Boolean(edge && edge.length >= 16 && same(given, edge));
  return { host: String((viaEdge && req.headers["x-forwarded-host"]) || req.headers.host || "").toLowerCase(), viaEdge };
}

async function answer(req) {
  const { host, viaEdge } = hostOf(req);
  if (req.url === "/runner/health") return Response.json({ ok: true });
  // In production everything comes through the front door, so traffic limits can't be skipped.
  if (process.env.EDGE_SECRET && !viaEdge) return new Response("Not here.", { status: 404 });
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (!/^(x-runner-|x-edge-secret$|x-forwarded-host$|host$|connection$)/.test(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : Readable.toWeb(req);
  const request = new Request(`https://${host}${req.url}`, { method: req.method, headers, body, duplex: "half", redirect: "manual" });
  if (host === SIGNIN_HOST) return signin.handle(request);
  if (DOMAIN && host.endsWith(`.${DOMAIN}`)) return run(host.slice(0, -DOMAIN.length - 1), request);
  return new Response("There is nothing at this address.", { status: 404 });
}

await admin.query(SCHEMA);
await signin.ready();

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
server.listen(port, () => console.log(`runner listening on ${port}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => stop().finally(() => process.exit(0))));
