// Grove's shared runner (../../runner): where free apps live. Not a Neon project each, but stored
// code and their own tables in a shared Postgres, run on demand. This is how Grove asks it to
// store an app, make a trial copy, hand over an app's data, pause it or remove it.
import type { Files } from "./build.ts";

export const runnerOn = () => Boolean(process.env.RUNNER_URL && process.env.RUNNER_ADMIN_TOKEN && process.env.APPS_DOMAIN);

/** A trial copy on the runner is an app of its own, named after the app and the change. Web addresses allow 63 characters. */
export const trialName = (slug: string, change: string) => {
  const name = `${slug}--${change}`;
  if (name.length > 63) throw new Error("That name for the change is too long for this app. Use a shorter one.");
  return name;
};
export const addressOf = (name: string) => `https://${name}.${process.env.APPS_DOMAIN}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${process.env.RUNNER_URL!.replace(/\/$/, "")}/runner/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.RUNNER_ADMIN_TOKEN}`, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (res.ok) return res;
  const out: any = await res.json().catch(() => ({}));
  throw new Error(out.problems?.length ? `The code could not be built for Grove's runner:\n${out.problems.slice(0, 20).join("\n")}` : `Grove's runner: ${out.error ?? res.status}`);
}

/** Stores a version of an app (or of a trial copy) and makes it the one that runs. */
export const put = (name: string, files: Files, env: Record<string, string>, title: string) =>
  call("PUT", `/apps/${name}`, { files, env, title }).then((r) => r.json() as Promise<{ version: number; address: string }>);
/** Makes `trial` with a copy of everything in the live app, as it is right now. */
export const copy = (from: string, trial: string) => call("POST", `/apps/${trial}/copy-from/${from}`).then(() => undefined);
export const remove = (name: string) => call("DELETE", `/apps/${name}`).then(() => undefined);
export const pause = (name: string, paused: boolean) => call("POST", `/apps/${name}/pause`, { paused }).then(() => undefined);
/** Runs statements in the app's own tables, as the app. */
export const sql = (name: string, statements: { text: string; values?: unknown[] }[]) => call("POST", `/apps/${name}/sql`, { statements }).then(() => undefined);
/** The app's tables and everything in them, as SQL that loads into any Postgres. */
export const dump = (name: string) => call("GET", `/apps/${name}/dump`).then((r) => r.text());
