// Builds an app inside Grove and puts it live, with no CI in between: bundle the app's files
// (esbuild as WebAssembly), check its types, zip it, upload it to Neon. The bundler, the packages
// apps may import and the type files ship next to Grove's code under build/ (scripts/build-assets.ts).
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

export type Files = Record<string, string>;

/** What went wrong in the app's code, one line each, written so an assistant can fix it. */
export class BuildError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

const ASSETS = process.env.GROVE_BUILD_ASSETS ? pathToFileURL(process.env.GROVE_BUILD_ASSETS + "/build/") : new URL("./build/", import.meta.url);
const asset = (name: string) => readFile(new URL(name, ASSETS));

const once = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= f().catch((e) => { p = undefined; throw e; }));
};

const vendor = once(async () => JSON.parse(await asset("vendor.json").then(String)) as { files: Files; map: Record<string, string> });
const typeFiles = once(async () => JSON.parse(await asset("types.json").then(String)) as Files);
const bundler = once(async () => {
  const mod = await import("esbuild-wasm/lib/browser.js");
  const esbuild = (mod as any).default ?? mod;
  (globalThis as any).self ??= globalThis; // the browser build of esbuild looks for it
  await esbuild.initialize({ wasmModule: await WebAssembly.compile(await asset("esbuild.wasm")), worker: false });
  return esbuild as typeof import("esbuild-wasm");
});

const BUILTIN = new Set(builtinModules);
const TRY = ["", ".ts", ".js", ".json", "/index.ts"];

/** The app as the files Neon runs: index.mjs (the app's own code) plus the shared packages. */
export async function bundle(files: Files, entry = "src/index.ts"): Promise<Record<string, string>> {
  const [esbuild, v] = await Promise.all([bundler(), vendor()]);
  const result = await esbuild
    .build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      target: "node24",
      logLevel: "silent",
      plugins: [
        {
          name: "app-files",
          setup(b) {
            b.onResolve({ filter: /.*/ }, (a) => {
              if (a.kind === "entry-point") return { path: a.path, namespace: "app" };
              if (a.path.startsWith(".")) {
                const base = posix.join(posix.dirname(a.importer), a.path);
                const hit = TRY.map((ext) => base + ext).find((p) => p in files);
                return hit ? { path: hit, namespace: "app" } : { errors: [{ text: `No file ${base} (imported as ${a.path}).` }] };
              }
              if (a.path.startsWith("node:") || BUILTIN.has(a.path)) return { path: a.path, external: true };
              if (v.map[a.path]) return { path: v.map[a.path], external: true };
              return { errors: [{ text: `"${a.path}" can't be imported here. Available: ${Object.keys(v.map).join(", ")}, and Node's built-ins.` }] };
            });
            b.onLoad({ filter: /.*/, namespace: "app" }, (a) => ({ contents: files[a.path], loader: a.path.endsWith(".json") ? "json" : a.path.endsWith(".ts") ? "ts" : "js" }));
          },
        },
      ],
    })
    .catch((e: any) => {
      if (!e?.errors) throw e;
      throw new BuildError(e.errors.map((m: any) => `${m.location ? `${m.location.file}(${m.location.line},${m.location.column + 1}): ` : ""}${m.text}`));
    });
  return { "index.mjs": result.outputFiles![0].text, ...v.files };
}

const parsed = new Map<string, import("typescript").SourceFile>();

/** Type errors in the app's files, as "src/app.ts(12,5): message". Empty when it's fine. */
export async function check(files: Files): Promise<string[]> {
  const [{ default: ts }, types] = await Promise.all([import("typescript"), typeFiles()]);
  const root = "/app/";
  const all = new Map<string, string>();
  for (const [p, text] of Object.entries(types)) all.set(root + p, text);
  for (const [p, text] of Object.entries(files)) all.set(root + p, text);
  const dirs = new Set<string>();
  for (const p of all.keys()) for (let d = posix.dirname(p); !dirs.has(d); d = posix.dirname(d)) dirs.add(d);

  const options = {
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
  const lib = root + "node_modules/typescript/lib";
  const trim = (d: string) => (d.length > 1 ? d.replace(/\/$/, "") : d);
  const host: import("typescript").CompilerHost = {
    fileExists: (f) => all.has(f),
    readFile: (f) => all.get(f),
    directoryExists: (d) => dirs.has(trim(d)),
    getDirectories: (d) => [...dirs].filter((x) => posix.dirname(x) === trim(d) && x !== trim(d)).map((x) => posix.basename(x)),
    // The packages' type files never change, so they are parsed once and kept; only the app's files are read each time.
    getSourceFile: (f, version) => {
      if (!all.has(f)) return undefined;
      if (!f.startsWith(root + "node_modules/")) return ts.createSourceFile(f, all.get(f)!, version);
      let kept = parsed.get(f);
      if (!kept) parsed.set(f, (kept = ts.createSourceFile(f, all.get(f)!, version)));
      return kept;
    },
    getDefaultLibLocation: () => lib,
    getDefaultLibFileName: (o) => `${lib}/${ts.getDefaultLibFileName(o)}`,
    getCurrentDirectory: () => root,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    writeFile: () => {},
    realpath: (f) => f,
  };
  const sources = Object.keys(files).filter((p) => /\.ts$/.test(p) && !p.startsWith("node_modules/")).map((p) => root + p);
  const program = ts.createProgram(sources, options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (!d.file || d.start === undefined) return text;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName.slice(root.length)}(${line + 1},${character + 1}): ${text}`;
  });
}

/** A zip archive of these files, as Neon's upload wants it. */
export function zip(files: Record<string, string | Uint8Array>) {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, count = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name), raw = Buffer.from(data as any), z = deflateRawSync(raw), crc = crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(z.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(z.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    parts.push(h, n, z);
    central.push(c, n);
    offset += 30 + n.length + z.length;
    count++;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const NEON = "https://console.neon.tech/api/v2";

export interface Target {
  /** An API key that reaches this project. */
  key: string;
  project: string;
  branch: string;
  /** Function slug; "app" for apps made from the template. */
  slug?: string;
}

async function neon<T = any>(t: Target, method: string, path: string, body?: FormData): Promise<T> {
  const res = await fetch(`${NEON}/projects/${t.project}/branches/${t.branch}/functions/${t.slug ?? "app"}${path}`, {
    method,
    headers: { authorization: `Bearer ${t.key}`, accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`Neon ${method} function${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

/** Uploads a built app and waits until Neon has taken it. Returns the app's address. */
export async function upload(t: Target, archive: Record<string, string | Uint8Array>, env: Record<string, string>) {
  const form = new FormData();
  form.set("zip", new Blob([new Uint8Array(zip(archive))], { type: "application/zip" }), "function.zip");
  form.set("runtime", "nodejs24");
  form.set("environment", JSON.stringify(env));
  const { deployment } = await neon(t, "POST", "/deployments", form);
  for (let i = 0; i < 150; i++) {
    const { function: f } = await neon(t, "GET", "");
    const d = f.current_deployment?.id === deployment.id ? f.current_deployment : undefined;
    if (d?.status === "completed") return { address: (f.invocation_url as string).replace(/\/$/, ""), deployment: deployment.id as number };
    if (d?.status === "failed") throw new Error(`Neon could not start this version: ${JSON.stringify(d).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Neon took more than two minutes to accept the upload.");
}

/** Checks, bundles and uploads in one go. Throws BuildError with the problems if the code is wrong. */
export async function buildAndUpload(t: Target, files: Files, env: Record<string, string>) {
  const started = Date.now();
  const [problems, archive] = await Promise.all([check(files), bundle(files)]);
  if (problems.length) throw new BuildError(problems);
  const built = Date.now();
  const live = await upload(t, archive, env);
  return { ...live, seconds: { build: (built - started) / 1000, upload: (Date.now() - built) / 1000 } };
}
