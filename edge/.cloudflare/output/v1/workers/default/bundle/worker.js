var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var FRESH_SECONDS = 300;
var KEEP_SECONDS = 60 * 60 * 24 * 7;
var memory = /* @__PURE__ */ new Map();
async function where(host, env, ctx) {
  const now = Date.now();
  const mine = memory.get(host);
  if (mine && now - mine.at < FRESH_SECONDS * 1e3) return mine.where;
  const key = new Request(`https://edge.invalid/where/${host}`);
  const kept = await caches.default.match(key);
  const old = kept ? await kept.json() : void 0;
  if (old && now - old.at < FRESH_SECONDS * 1e3) return memory.set(host, old), old.where;
  try {
    const res = await fetch(`${env.GROVE_URL}/edge/where?host=${encodeURIComponent(host)}`, { headers: { "x-edge-secret": env.EDGE_SECRET } });
    if (res.status !== 200 && res.status !== 404) throw new Error(`Grove answered ${res.status}`);
    const entry = { at: now, where: res.status === 200 ? await res.json() : null };
    memory.set(host, entry);
    ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(entry), { headers: { "cache-control": `max-age=${KEEP_SECONDS}` } })));
    return entry.where;
  } catch (e) {
    if (old) return memory.set(host, { at: now - (FRESH_SECONDS - 30) * 1e3, where: old.where }), old.where;
    throw e;
  }
}
__name(where, "where");
var worker_default = {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);
    if (env.RUNNER_ORIGIN && (env.RUNNER_HOSTS ?? "").split(",").includes(incoming.hostname)) {
      const upstream2 = new URL(env.RUNNER_ORIGIN);
      upstream2.pathname = incoming.pathname;
      upstream2.search = incoming.search;
      const headers2 = new Headers(request.headers);
      headers2.delete("host");
      headers2.set("x-forwarded-host", incoming.hostname);
      headers2.set("x-edge-secret", env.EDGE_SECRET);
      return fetch(upstream2, { method: request.method, headers: headers2, body: request.body, redirect: "manual" });
    }
    let to;
    try {
      to = await where(incoming.hostname, env, ctx);
    } catch {
      return new Response("This app can't be reached right now. Please try again in a minute.", { status: 502 });
    }
    if (!to) return new Response("There is no app at this address.", { status: 404 });
    const upstream = new URL(to.origin);
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("x-forwarded-host", incoming.hostname);
    if (to.secret) headers.set("x-secret", to.secret);
    return fetch(upstream, { method: request.method, headers, body: request.body, redirect: "manual" });
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
