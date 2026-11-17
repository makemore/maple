// The rules for an app's code as Grove keeps it: what may be written, how changes combine, and how
// an app takes a newer kit. Nothing here touches the database or the network.
import type { Files } from "./build.ts";

// The kit stays as MAPLE made it; features go everywhere else.
export const PROTECTED = [/^src\/maple\//, /^package-lock\.json$/];
export const MAX_FILE = 200_000, MAX_FILES = 200, MAX_TOTAL = 3_000_000;
export const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const CHANGE = /^[a-z0-9][a-z0-9-]{0,38}$/;
// Names that would look like part of Grove itself on the apps domain.
export const RESERVED = new Set(["www", "grove", "maple", "api", "app", "apps", "admin", "mail", "email", "help", "support", "status", "preview", "login", "signin", "sign-in", "account", "billing", "pay", "secure", "security", "report", "abuse", "terms", "privacy"]);

export type Write = { path: string; content: string | null };

/** The files after some writes (content null deletes). Throws on anything Grove won't keep. */
export function applyWrites(before: Files, writes: Write[]): Files {
  const files = { ...before };
  for (const f of writes) {
    if (f.path.startsWith("/") || f.path.includes("..") || f.path.includes("\\")) throw new Error(`Bad path: ${f.path}`);
    if (PROTECTED.some((p) => p.test(f.path))) throw new Error(`${f.path} belongs to MAPLE and can't be changed here.`);
    if (f.content?.includes("\0")) throw new Error(`${f.path} isn't a text file.`);
    if (f.path === "maple.json" && f.content !== null) JSON.parse(f.content);
    if (f.content === null) delete files[f.path];
    else files[f.path] = f.content;
  }
  tooBig(files);
  return files;
}

export function tooBig(files: Files) {
  if (Object.keys(files).length > MAX_FILES || Object.values(files).reduce((n, c) => n + c.length, 0) > MAX_TOTAL) throw new Error("That makes the app too big for Grove. Remove some files.");
}

/** Combines a change with what shipped since it started, file by file. */
export function merge(base: Files, live: Files, mine: Files) {
  const files: Files = {}, clashes: string[] = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(live), ...Object.keys(mine)])) {
    const b = base[path], l = live[path], m = mine[path];
    const pick = m === b ? l : l === b || l === m ? m : (clashes.push(path), m);
    if (pick !== undefined) files[path] = pick;
  }
  return { files, clashes };
}

export const diff = (from: Files, to: Files) =>
  [...new Set([...Object.keys(from), ...Object.keys(to)])].sort().flatMap((p) => (from[p] === to[p] ? [] : [`${!(p in from) ? "added" : !(p in to) ? "deleted" : "changed"} ${p}`]));

/**
 * The app with the kit from a newer template: the protected files are replaced whole, and package.json
 * takes the template's versions of the packages the kit needs. Everything the maker wrote is left alone.
 */
export function withKit(files: Files, template: Files): Files {
  const kit = (p: string) => PROTECTED.some((r) => r.test(p));
  const out: Files = {};
  for (const [p, c] of Object.entries(files)) if (!kit(p)) out[p] = c;
  for (const [p, c] of Object.entries(template)) if (kit(p)) out[p] = c;
  if (files["package.json"] && template["package.json"]) {
    const mine = JSON.parse(files["package.json"]), theirs = JSON.parse(template["package.json"]);
    for (const k of ["dependencies", "devDependencies"]) if (theirs[k]) mine[k] = { ...mine[k], ...theirs[k] };
    const text = JSON.stringify(mine, null, 2) + "\n";
    if (JSON.stringify(JSON.parse(files["package.json"])) !== JSON.stringify(mine)) out["package.json"] = text;
  }
  return out;
}
