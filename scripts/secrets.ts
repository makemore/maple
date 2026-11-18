// Grove's settings live in Google Secret Manager (project makewithgrove), one secret per setting, named
// grove-env-<name in lowercase with dashes>. .env.grove is only a local copy made from them for a deploy.
//
//   node scripts/secrets.ts pull          writes .env.grove from Secret Manager (readable only by you)
//   node scripts/secrets.ts push          copies every setting in .env.grove into Secret Manager
//   node scripts/secrets.ts set NAME      sets one setting, reading its value from standard input
//   node scripts/secrets.ts list          the names kept, never the values
//
// Values pass between gcloud and this script through pipes, never on a command line.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const PROJECT = process.env.GROVE_SECRETS_PROJECT ?? "makewithgrove";
const FILE = new URL("../.env.grove", import.meta.url).pathname;
const PREFIX = "grove-env-";
const toSecret = (name: string) => PREFIX + name.toLowerCase().replace(/_/g, "-");
const fromSecret = (id: string) => id.slice(PREFIX.length).toUpperCase().replace(/-/g, "_");

const gcloud = (args: string[], input?: string) =>
  execFileSync("gcloud", [...args, `--project=${PROJECT}`, "--quiet"], { input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });

function names() {
  const out = gcloud(["secrets", "list", "--filter=labels.grove-env=1", "--format=value(name)"]);
  return out.split("\n").map((l) => l.trim().split("/").pop()!).filter((n) => n.startsWith(PREFIX)).sort();
}

function set(name: string, value: string) {
  const id = toSecret(name);
  const exists = (() => {
    try {
      gcloud(["secrets", "describe", id, "--format=value(name)"]);
      return true;
    } catch {
      return false;
    }
  })();
  if (!exists) gcloud(["secrets", "create", id, "--replication-policy=automatic", "--labels=grove-env=1", "--data-file=-"], value);
  else {
    const current = (() => {
      try {
        return gcloud(["secrets", "versions", "access", "latest", `--secret=${id}`]);
      } catch {
        return undefined;
      }
    })();
    if (current !== value) gcloud(["secrets", "versions", "add", id, "--data-file=-"], value);
  }
  return exists ? "updated" : "created";
}

/** KEY=value lines, as the deploy tools read them. Values are kept exactly, quotes and all. */
export function parseEnv(text: string) {
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "list") console.log(names().map(fromSecret).join("\n"));
else if (cmd === "pull") {
  const lines = names().map((id) => `${fromSecret(id)}=${gcloud(["secrets", "versions", "access", "latest", `--secret=${id}`])}`);
  if (!lines.length) throw new Error(`No Grove settings in Secret Manager (project ${PROJECT}). Run push first.`);
  writeFileSync(FILE, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(FILE, 0o600);
  console.log(`Wrote ${lines.length} settings to .env.grove from Secret Manager.`);
} else if (cmd === "push") {
  if (!existsSync(FILE)) throw new Error(".env.grove isn't there to push.");
  for (const [k, v] of parseEnv(readFileSync(FILE, "utf8"))) console.log(`${k}: ${set(k, v)}`);
} else if (cmd === "set" && arg && /^[A-Z][A-Z0-9_]*$/.test(arg)) {
  const value = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (!value) throw new Error("Give the value on standard input, e.g.: pbpaste | node scripts/secrets.ts set STRIPE_SECRET_KEY");
  console.log(`${arg}: ${set(arg, value)}`);
} else {
  console.log("Usage: node scripts/secrets.ts pull | push | set NAME | list");
  process.exit(1);
}
