#!/usr/bin/env node
// Grove from a terminal: the same tools an assistant gets through the connector, called directly, plus
// pull and push for working on an app's code in an ordinary folder. Needs Node 22.18 or later.
//
//   grove login <token>              save a token (make one by asking Grove: "make me a CLI token")
//   grove tools                      list the tools
//   grove help <tool>                what a tool does and what it takes
//   grove <tool> [--name value ...]  call a tool; values are read as JSON when they parse (numbers, true, ["a"])
//   grove <tool> --json '{...}'      call a tool with its arguments as JSON
//   grove pull <app> [dir] [--change name]   copy an app's code into a folder (default ./<app>)
//   grove push [dir] --change name --message "what and why"   write the files changed since pull as a change (a preview)
//
// GROVE_TOKEN and GROVE_URL override the saved settings.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const CONFIG = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "grove", "config.json");
const STATE = ".grove.json";

type Config = { url: string; token?: string };
const config = (): Config => {
  const saved: Partial<Config> = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
  return { url: (process.env.GROVE_URL ?? saved.url ?? "https://makewithgrove.com").replace(/\/$/, ""), token: process.env.GROVE_TOKEN ?? saved.token };
};

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

let id = 0;
async function rpc(method: string, params: object) {
  const c = config();
  if (!c.token) fail("Not logged in. Ask Grove in your assistant to \"make me a CLI token\", then: grove login <token>");
  const res = await fetch(`${c.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${c.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  if (res.status === 401) fail("Grove didn't accept the token (it may have run out or been revoked). Make a new one and run grove login again.");
  if (!res.ok) fail(`Grove answered ${res.status}: ${text.slice(0, 500)}`);
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(line ? line.slice(5) : text);
  if (msg.error) fail(`Grove: ${msg.error.message}`);
  return msg.result;
}

/** Calls a tool. Returns its answer as JSON when it is JSON, or as text. */
async function call(name: string, args: object = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = (r.content ?? []).map((x: any) => x.text ?? "").join("\n");
  if (r.isError) fail(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const show = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** --name value pairs (and --flag on its own for true), each value read as JSON when it parses. */
function flags(argv: string[]) {
  const out: Record<string, unknown> = {}, rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const v = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
    let value: unknown = v;
    try {
      value = JSON.parse(v);
    } catch {}
    out[k] = value;
  }
  return { args: out, rest };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function walk(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === STATE || name === "node_modules" || name === ".git" || name === ".DS_Store") return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, root) : [relative(root, full).split(sep).join("/")];
  });
}

async function pull(app: string, dir: string, change?: string) {
  const listed = await call("list_files", { app, ...(change && { change }) });
  const paths: string[] = listed.files.map((f: any) => f.path);
  const hashes: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += 20) {
    const got = await call("read_files", { app, paths: paths.slice(i, i + 20), ...(change && { change }) });
    for (const f of got.files) {
      if (f.missing) continue;
      const to = resolve(dir, f.path);
      if (!to.startsWith(resolve(dir) + sep)) fail(`Refusing to write outside ${dir}: ${f.path}`);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, f.content);
      hashes[f.path] = sha(f.content);
    }
  }
  writeFileSync(join(dir, STATE), JSON.stringify({ app, change: change ?? null, hashes }, null, 2) + "\n");
  console.log(`Pulled ${Object.keys(hashes).length} files of ${app}${change ? ` (change ${change})` : ""} into ${dir}`);
}

async function push(dir: string, change: string | undefined, message: string | undefined) {
  const statePath = join(dir, STATE);
  if (!existsSync(statePath)) fail(`${dir} wasn't made by grove pull (no ${STATE}).`);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { app: string; change: string | null; hashes: Record<string, string> };
  change ??= state.change ?? undefined;
  if (!change) fail("Name the change: --change add-opening-hours");
  if (!message) fail('Say what it changes and why: --message "..."');
  const now = new Map(walk(dir).map((p) => [p, readFileSync(join(dir, p), "utf8")]));
  const files: { path: string; content: string | null }[] = [];
  for (const [p, content] of now) if (state.hashes[p] !== sha(content) && !p.startsWith("src/maple/")) files.push({ path: p, content });
  for (const p of Object.keys(state.hashes)) if (!now.has(p) && !p.startsWith("src/maple/")) files.push({ path: p, content: null });
  if (!files.length) return console.log("Nothing has changed since the pull.");
  console.log(`Writing ${files.length} file${files.length === 1 ? "" : "s"} to ${state.app}, change ${change}: ${files.map((f) => (f.content === null ? `-${f.path}` : f.path)).join(", ")}`);
  let result: any;
  for (let i = 0; i < files.length; i += 30) result = await call("write_files", { app: state.app, change, message: message!, files: files.slice(i, i + 30) });
  for (const f of files) {
    if (f.content === null) delete state.hashes[f.path];
    else state.hashes[f.path] = sha(f.content);
  }
  writeFileSync(statePath, JSON.stringify({ ...state, change }, null, 2) + "\n");
  show(result);
}

const [cmd, ...argv] = process.argv.slice(2);
const { args, rest } = flags(argv);

switch (cmd) {
  case undefined:
  case "-h":
  case "--help":
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 14).map((l) => l.slice(3)).join("\n"));
    break;
  case "login": {
    const token = rest[0] ?? fail("grove login <token>");
    if (!/^grove_[A-Za-z0-9_-]{20,}$/.test(token)) fail("That doesn't look like a Grove token (they start grove_).");
    mkdirSync(dirname(CONFIG), { recursive: true });
    writeFileSync(CONFIG, JSON.stringify({ url: (args.url as string) ?? config().url, token }, null, 2) + "\n", { mode: 0o600 });
    chmodSync(CONFIG, 0o600);
    const plan = await call("plan");
    console.log(`Logged in to ${config().url}. Plan: ${plan.plan}, ${plan.appsMade} of ${plan.appsAllowed} apps.`);
    break;
  }
  case "logout":
    if (existsSync(CONFIG)) rmSync(CONFIG);
    console.log("Logged out. (The token still works until it runs out or is revoked: revoke_cli_token.)");
    break;
  case "tools": {
    const { tools } = await rpc("tools/list", {});
    for (const t of tools) console.log(`${t.name.padEnd(22)} ${t.title ?? ""}`);
    break;
  }
  case "help": {
    const { tools } = await rpc("tools/list", {});
    const t = tools.find((x: any) => x.name === rest[0]) ?? fail(`No tool called ${rest[0]}. grove tools lists them.`);
    console.log(`${t.name}: ${t.title ?? ""}\n\n${t.description}\n`);
    for (const [k, v] of Object.entries<any>(t.inputSchema?.properties ?? {})) console.log(`  --${k}${(t.inputSchema.required ?? []).includes(k) ? "" : " (optional)"}  ${v.type ?? ""} ${v.description ?? ""}`);
    break;
  }
  case "pull": {
    const app = rest[0] ?? fail("grove pull <app> [dir]");
    await pull(app, rest[1] ?? app, args.change as string | undefined);
    break;
  }
  case "push":
    await push(rest[0] ?? ".", args.change as string | undefined, args.message as string | undefined);
    break;
  default: {
    const input = typeof args.json === "string" ? JSON.parse(args.json) : args.json && typeof args.json === "object" ? args.json : args;
    show(await call(cmd, input as object));
  }
}
