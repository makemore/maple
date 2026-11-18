// Bringing a spreadsheet's rows into an app (an export from Airtable, Google Sheets, Notion, a CRM, a form
// tool...), as code: a table, and the rows loaded into it once. It travels through a trial copy and ships
// like any other change, and the rows go wherever the app goes. Also wires imported things into src/app.ts.
import { createHash } from "node:crypto";
import type { Files } from "./build.ts";

/** Rows of a CSV file (RFC 4180: quotes, doubled quotes, line breaks in quotes). Also reads tabs or semicolons. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.indexOf("\n") === -1 ? src.length : src.indexOf("\n"));
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const sep = count("\t") > count(",") ? "\t" : count(";") > count(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field), (field = "");
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** A column name Postgres is happy with: lowercase words and underscores. */
export const columnName = (s: string, i: number) => {
  const n = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  return !n ? `column_${i + 1}` : /^[0-9]/.test(n) ? `c_${n}` : ["id", "user", "order", "group", "select", "from", "where", "table", "default", "check", "primary", "references", "limit", "offset", "desc", "asc", "end", "case", "when", "all", "and", "or", "not", "null", "true", "false"].includes(n) ? `${n}_` : n;
};

type Kind = "integer" | "numeric" | "boolean" | "date" | "timestamptz" | "text";
const BOOL = /^(true|false|yes|no|y|n|checked|unchecked)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const kindOf = (values: string[]): Kind => {
  const v = values.map((x) => x.trim()).filter(Boolean);
  if (!v.length) return "text";
  if (v.every((x) => /^-?\d{1,15}$/.test(x)) && !v.some((x) => /^0\d/.test(x))) return "integer";
  if (v.every((x) => /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(x)) && !v.some((x) => /^0\d/.test(x))) return "numeric";
  if (v.every((x) => BOOL.test(x))) return "boolean";
  if (v.every((x) => DATE.test(x))) return "date";
  if (v.every((x) => STAMP.test(x))) return "timestamptz";
  return "text";
};
const literal = (v: string, k: Kind) => {
  const x = v.trim();
  if (!x) return "null";
  if (k === "integer") return x;
  if (k === "numeric") return x.replace(/,/g, "");
  if (k === "boolean") return /^(true|yes|y|checked)$/i.test(x) ? "true" : "false";
  return `'${(k === "text" ? v : x).replace(/'/g, "''").replace(/\0/g, "")}'`;
};

export const TABLE = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * The files that make a table from CSV rows: `src/imported/data-<table>-<n>.ts`, each with its part of the
 * rows, loaded once (a note in imported_batches stops them loading again, even if rows are later deleted).
 */
export function dataFiles(table: string, csv: string, o: { maxBytes?: number } = {}) {
  if (!TABLE.test(table)) throw new Error("table must be lowercase letters, digits and underscores, starting with a letter, e.g. customers");
  if (table.startsWith("maple_") || table === "imported_batches") throw new Error(`${table} is a name the kit uses. Pick another.`);
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error("The file needs a header row and at least one row of data.");
  const [head, ...data] = rows;
  if (head.length > 100) throw new Error("That's more than 100 columns. Export only the columns the app needs.");
  const names: string[] = [];
  head.forEach((h, i) => {
    let n = columnName(h, i), k = 2;
    while (names.includes(n)) n = `${columnName(h, i)}_${k++}`;
    names.push(n);
  });
  const kinds = names.map((_, i) => kindOf(data.map((r) => r[i] ?? "")));
  const create = `create table if not exists ${table} (\n  id serial primary key,\n${names.map((n, i) => `  ${n} ${kinds[i]}`).join(",\n")},\n  imported_at timestamptz not null default now());`;
  const values = data.map((r) => `(${names.map((_, i) => literal(r[i] ?? "", kinds[i])).join(", ")})`);
  const id = createHash("sha256").update(csv).digest("hex").slice(0, 10);
  const parts: string[][] = [[]];
  let size = 0;
  for (const v of values) {
    if (size + v.length > 150_000 && parts[parts.length - 1].length) parts.push([]), (size = 0);
    parts[parts.length - 1].push(v);
    size += v.length + 3;
  }
  const total = parts.reduce((n, p) => n + p.reduce((m, v) => m + v.length, 0), 0);
  if (total > (o.maxBytes ?? 1_500_000)) throw new Error(`That's too many rows to keep in the app's code (about ${Math.round(total / 1000)} KB). Split the file, or export fewer columns or rows.`);
  const files: Files = {};
  parts.forEach((p, i) => {
    const batch = `${table}-${id}-${i + 1}`;
    // The block is quoted with a tag none of the values contain, so no cell can end it early.
    const body = p.join("");
    let q = "$grove$";
    for (let n = 1; body.includes(q); n++) q = `$grove${n}$`;
    const sql = `${i === 0 ? create + "\n" : ""}do ${q} begin
  if not exists (select 1 from imported_batches where name = '${batch}') then
    insert into ${table} (${names.join(", ")}) values
    ${p.join(",\n    ")};
    insert into imported_batches (name) values ('${batch}');
  end if;
end ${q};`;
    files[`src/imported/data-${table}-${i + 1}.ts`] = `// ${i === 0 ? `The ${table} table, and ` : ""}rows ${i === 0 ? "" : `(part ${i + 1}) `}imported by Grove from a spreadsheet. They load once; after that the table is the app's to change.\nexport const schema = ${JSON.stringify(sql)};\n`;
  });
  return { files, columns: names.map((n, i) => ({ column: n, type: kinds[i], from: head[i] })), rows: data.length, parts: parts.length };
}

/** src/imported/index.ts: everything imported, put together for src/app.ts. Rewritten after every import. */
export function importedIndex(files: Files) {
  const data = Object.keys(files).filter((p) => /^src\/imported\/data-[a-z0-9_]+-\d+\.ts$/.test(p)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const site = "src/imported/site.ts" in files;
  return `// Made by Grove's import tools, and rewritten after each import: change the other files here instead.
// src/app.ts uses importedSchema (in schema), importedRoutes (in routes) and importedHome (as home).
import type { Hono } from "hono";
${site ? `import { siteRoutes, homeOf } from "./render.ts";\nimport { pages, styles, SOURCE } from "./site.ts";\n` : ""}${data.map((p, i) => `import { schema as d${i} } from "./${p.slice("src/imported/".length)}";`).join("\n")}

export const importedSchema = [
  "create table if not exists imported_batches (name text primary key, at timestamptz not null default now());",${data.map((_, i) => `\n  d${i},`).join("")}
].join("\\n");

export function importedRoutes(app: Hono) {
${site ? "  siteRoutes(app, pages, styles, SOURCE);\n" : "  void app;\n"}}

export const importedHome: ((info: { title: string; site: string; mcpUrl: string }) => string) | undefined = ${site ? "homeOf(pages, SOURCE)" : "undefined"};
`;
}

/**
 * Connects src/imported/index.ts to src/app.ts where app.ts is still close to the template's shape.
 * Says what it did, and what is left for the assistant to do by hand when the file has moved on.
 */
export function wire(appTs: string, o: { home: boolean }) {
  let code = appTs;
  const done: string[] = [], todo: string[] = [];
  if (!code.includes("./imported/index.ts")) {
    const imports = [...code.matchAll(/^import .*?;\s*$/gm)];
    const at = imports.length ? imports[imports.length - 1].index! + imports[imports.length - 1][0].length : 0;
    code = code.slice(0, at) + `\nimport { importedSchema, importedRoutes, importedHome } from "./imported/index.ts";` + code.slice(at);
    done.push("imported src/imported/index.ts");
  }
  if (!code.includes("${importedSchema}")) {
    const m = code.match(/export const schema\s*=\s*`/);
    if (m) (code = code.replace(m[0], m[0] + "${importedSchema}\n")), done.push("added importedSchema to schema");
    else todo.push("put ${importedSchema} at the start of the schema in src/app.ts");
  }
  if (!/importedRoutes\(/.test(code.replace(/^import .*$/gm, ""))) {
    const m = code.match(/export function routes\(\s*(\w+)[^)]*\)\s*(:\s*\w+\s*)?\{/);
    if (m) (code = code.replace(m[0], `${m[0]}\n  importedRoutes(${m[1]});`)), done.push("called importedRoutes in routes");
    else todo.push("call importedRoutes(app) at the start of routes in src/app.ts");
  }
  if (o.home && !/=\s*importedHome/.test(code)) {
    const m = code.match(/(export const home\b.*?=\s*)undefined\s*;/);
    if (m) (code = code.replace(m[0], `${m[1]}importedHome;`)), done.push("made the imported front page the app's home");
    else todo.push("the imported front page isn't the app's home yet: set home to importedHome in src/app.ts if it should be");
  }
  return { code, done, todo };
}
