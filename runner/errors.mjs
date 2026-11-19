// Sends the runner's errors to Sentry when SENTRY_DSN is set: every console.error, a few a minute at most.
// The same small envelope sender as grove/src/errors.ts, kept here because the runner is built on its own.
let sent = [];
async function report(error, message) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  const now = Date.now();
  sent = sent.filter((t) => now - t < 60_000);
  if (sent.length >= 30) return;
  sent.push(now);
  try {
    const u = new URL(dsn), project = u.pathname.replace(/^\/+|\/+$/g, "");
    const e = error instanceof Error ? error : new Error(String(message ?? error));
    const id = crypto.randomUUID().replace(/-/g, "");
    const ev = { event_id: id, timestamp: now / 1000, platform: "node", level: "error", server_name: "grove-runner", environment: "production",
      exception: { values: [{ type: e.name, value: String(e.message).slice(0, 2000), stacktrace: { frames: (e.stack ?? "").split("\n").slice(1, 40).reverse().map((l) => ({ function: l.trim() })) } }] },
      extra: { message: String(message ?? "").slice(0, 2000) } };
    await fetch(`${u.protocol}//${u.host}/api/${project}/envelope/`, { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=grove-runner/1.0` },
      body: `${JSON.stringify({ event_id: id })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(ev)}\n` });
  } catch {}
}

export function watchErrors() {
  if (!process.env.SENTRY_DSN) return;
  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    // Node's own warnings are printed this way too, and aren't failures.
    if (typeof args[0] === "string" && /^\(node:\d+\) \[?[A-Z]*\d*\]? ?\w*Warning/.test(args[0])) return;
    void report(args.find((a) => a instanceof Error), args.filter((a) => typeof a === "string").join(" "));
  };
  process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));
}
