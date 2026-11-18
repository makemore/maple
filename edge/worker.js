// Grove's front door for apps, on Cloudflare: every <name>.<apps domain> request comes here and is
// passed to that app's own address. Being on Cloudflare is what lets traffic limits and attack
// protection apply before a request ever reaches the app. Neon's guidance for public functions.
//
// It asks Grove where an app lives (and the secret the app expects), and remembers the answer for a
// few minutes, and for much longer if Grove can't be reached, so apps stay up when Grove is down.

const FRESH_SECONDS = 300;
const KEEP_SECONDS = 60 * 60 * 24 * 7;
const memory = new Map(); // host -> { at, where }

async function where(host, env, ctx) {
  const now = Date.now();
  const mine = memory.get(host);
  if (mine && now - mine.at < FRESH_SECONDS * 1000) return mine.where;

  const key = new Request(`https://edge.invalid/where/${host}`);
  const kept = await caches.default.match(key);
  const old = kept ? await kept.json() : undefined;
  if (old && now - old.at < FRESH_SECONDS * 1000) return memory.set(host, old), old.where;

  try {
    const res = await fetch(`${env.GROVE_URL}/edge/where?host=${encodeURIComponent(host)}`, { headers: { "x-edge-secret": env.EDGE_SECRET } });
    if (res.status !== 200 && res.status !== 404) throw new Error(`Grove answered ${res.status}`);
    const entry = { at: now, where: res.status === 200 ? await res.json() : null };
    memory.set(host, entry);
    ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(entry), { headers: { "cache-control": `max-age=${KEEP_SECONDS}` } })));
    return entry.where;
  } catch (e) {
    // Grove is unreachable: carry on with what we last knew, however old.
    if (old) return memory.set(host, { at: now - (FRESH_SECONDS - 30) * 1000, where: old.where }), old.where;
    throw e;
  }
}

/** Passes a request to Grove's shared runner, saying which address it was for and proving it came through here. */
function toRunner(request, incoming, env) {
  const upstream = new URL(env.RUNNER_ORIGIN);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", incoming.hostname);
  headers.set("x-edge-secret", env.EDGE_SECRET);
  return fetch(upstream, { method: request.method, headers, body: request.body, redirect: "manual" });
}

export default {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);
    // Addresses served by Grove's shared runner (sign-in, and the apps that share it). The runner only
    // answers requests that carry the secret, so nobody can go round the front door.
    if (env.RUNNER_ORIGIN && (env.RUNNER_HOSTS ?? "").split(",").includes(incoming.hostname)) return toRunner(request, incoming, env);
    let to;
    try {
      to = await where(incoming.hostname, env, ctx);
    } catch {
      return new Response("This app can't be reached right now. Please try again in a minute.", { status: 502 });
    }
    if (!to) return new Response("There is no app at this address.", { status: 404 });
    if (to.runner) return toRunner(request, incoming, env);

    // The address to call is built from a fixed origin; only the path and query come from the request.
    const upstream = new URL(to.origin);
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("x-forwarded-host", incoming.hostname);
    if (to.secret) headers.set("x-secret", to.secret);
    return fetch(upstream, { method: request.method, headers, body: request.body, redirect: "manual" });
  },
};
