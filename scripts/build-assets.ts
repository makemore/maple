// Packs what Grove needs to build apps inside itself, with no CI: the bundler as WebAssembly, the
// packages apps may import (built once, shared by every app), and the type files to check against.
// Grove's neon.ts ships the result next to its own code, under build/.
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import ts from "typescript";
import { templateFiles } from "./bundle-template.ts";

const root = new URL("..", import.meta.url).pathname;

/** What an app's code may import, besides its own files and Node's built-ins. */
export const VENDORED = [
  "@modelcontextprotocol/sdk/server/mcp.js",
  "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
  "@modelcontextprotocol/sdk/types.js",
  "@neon/functions",
  "@neon/functions/triggers",
  "@neon/oauth/mcp",
  "@neon/oauth/mcp/hono",
  "hono",
  "hono/cookie",
  "hono/cors",
  "hono/html",
  "hono/http-exception",
  "jose",
  "pg",
  "zod",
];

// Same settings as template/tsconfig.json. grove/src/build.ts checks with these too.
export const TS_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  types: ["node"],
};

/** Each package as its own file, with what they share split out, so an app's bundle holds only the app. */
async function vendor() {
  const out = await build({
    entryPoints: Object.fromEntries(VENDORED.map((spec, i) => [`v${i}`, spec])),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outdir: "vendor",
    outExtension: { ".js": ".mjs" },
    chunkNames: "c-[hash]",
    write: false,
    absWorkingDir: root,
    logLevel: "warning",
    // Packages written as CommonJS call require(); an ES module has none in scope.
    banner: { js: "import{createRequire as __mapleRequire}from'node:module';const require=__mapleRequire(import.meta.url);" },
  });
  const files: Record<string, string> = {};
  for (const f of out.outputFiles) files[f.path.slice(root.length)] = f.text;
  const map = Object.fromEntries(VENDORED.map((spec, i) => [spec, `./vendor/v${i}.mjs`]));
  return { files, map };
}

/** Every type file (and package.json) TypeScript reads to check the template and the packages above. */
function types() {
  const app = root + "__app/";
  const virtual = new Map<string, string>();
  for (const [path, content] of Object.entries(templateFiles())) virtual.set(app + path, content);
  virtual.set(app + "src/__probe.ts", VENDORED.map((s) => `import ${JSON.stringify(s)};`).join("\n"));

  const host = ts.createCompilerHost(TS_OPTIONS);
  const real = { readFile: host.readFile, fileExists: host.fileExists, directoryExists: host.directoryExists! };
  const seen: Record<string, string> = {};
  host.getCurrentDirectory = () => app;
  host.readFile = (f) => {
    const text = virtual.get(f) ?? real.readFile(f);
    if (text !== undefined && f.startsWith(root + "node_modules/")) seen[f.slice(root.length)] = text;
    return text;
  };
  host.fileExists = (f) => virtual.has(f) || real.fileExists(f);
  host.directoryExists = (d) => real.directoryExists(d) || [...virtual.keys()].some((k) => k.startsWith(d.replace(/\/?$/, "/")));

  const program = ts.createProgram([...virtual.keys()].filter((f) => f.endsWith(".ts")), TS_OPTIONS, host);
  const problems = ts.getPreEmitDiagnostics(program);
  if (problems.length) throw new Error("The template doesn't pass its own type check:\n" + ts.formatDiagnostics(problems, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => app, getNewLine: () => "\n" }));
  return seen;
}

/** Archive path to contents, for Grove's deploy. */
export async function buildAssets(): Promise<Record<string, Uint8Array>> {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  return {
    "build/esbuild.wasm": new Uint8Array(readFileSync(root + "node_modules/esbuild-wasm/esbuild.wasm")),
    "build/vendor.json": enc(await vendor()),
    "build/types.json": enc(types()),
  };
}

// node scripts/build-assets.ts <dir>: write them to a folder, for running grove/src/build.ts outside Grove.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = process.argv[2] ?? root + ".neon/build-assets";
  mkdirSync(dir + "/build", { recursive: true });
  for (const [path, bytes] of Object.entries(await buildAssets())) {
    writeFileSync(`${dir}/${path}`, bytes);
    console.log(`${path}: ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
  }
}
