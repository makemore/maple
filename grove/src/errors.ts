// Sending Grove's errors to Sentry, when SENTRY_DSN is set. A few lines over Sentry's envelope API rather
// than its SDK, so it works the same inside a Neon function, the runner and a Cloudflare Worker.
// Every console.error in Grove is a real failure, so those are sent too, a few a minute at most.

type Extra = Record<string, unknown>;

export function parseDsn(dsn: string) {
  const u = new URL(dsn);
  const project = u.pathname.replace(/^\/+|\/+$/g, "");
  if (!u.username || !project) throw new Error("SENTRY_DSN doesn't look like a Sentry DSN.");
  return { key: u.username, url: `${u.protocol}//${u.host}/api/${project}/envelope/` };
}

const frames = (stack = "") =>
  stack.split("\n").slice(1, 40).reverse().map((line) => {
    const m = line.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    return m ? { function: m[1] ?? "?", filename: m[2], lineno: Number(m[3]), colno: Number(m[4]), in_app: !/node_modules|node:/.test(m[2]) } : { function: line.trim() };
  });

/** The event Sentry expects for one error. */
export function eventFor(error: unknown, o: { extra?: Extra; release?: string; server?: string; level?: "error" | "warning" } = {}) {
  const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : JSON.stringify(error));
  return {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: o.level ?? "error",
    server_name: o.server ?? "grove",
    release: o.release,
    environment: "production",
    exception: { values: [{ type: e.name, value: e.message.slice(0, 2000), stacktrace: { frames: frames(e.stack) } }] },
    extra: o.extra,
  };
}

let sent: number[] = [];
/** Sends one error. Never throws, and stops at 30 a minute so a loop of failures can't flood Sentry. */
export async function report(error: unknown, extra?: Extra, o: { dsn?: string; server?: string; fetcher?: typeof fetch } = {}) {
  const dsn = o.dsn ?? (typeof process !== "undefined" ? process.env.SENTRY_DSN : undefined);
  if (!dsn) return false;
  const now = Date.now();
  sent = sent.filter((t) => now - t < 60_000);
  if (sent.length >= 30) return false;
  sent.push(now);
  try {
    const { key, url } = parseDsn(dsn);
    const ev = eventFor(error, { extra, server: o.server, release: typeof process !== "undefined" ? process.env.MAPLE_COMMIT ?? process.env.GROVE_RELEASE : undefined });
    const body = `${JSON.stringify({ event_id: ev.event_id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(ev)}\n`;
    const res = await (o.fetcher ?? fetch)(url, { method: "POST", headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${key}, sentry_client=grove/1.0` }, body, signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Makes every console.error also go to Sentry. Call once at start-up. */
export function watchErrors(server = "grove", keepAlive?: (p: Promise<unknown>) => void) {
  if (typeof process === "undefined" || !process.env.SENTRY_DSN || (console.error as any).__grove) return;
  const original = console.error.bind(console);
  const patched = (...args: unknown[]) => {
    original(...args);
    const error = args.find((a) => a instanceof Error) ?? new Error(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 2000));
    const p = report(error, { message: args.filter((a) => typeof a === "string").join(" ").slice(0, 2000) }, { server });
    keepAlive?.(p);
  };
  (patched as any).__grove = true;
  console.error = patched;
}
