// Building an app inside Grove: the template is clean, mistakes are caught before anything is saved,
// and the code comes out as a bundle and as a zip. Uses the same packed bundler and types Grove ships with.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, test } from "node:test";
import { buildAssets } from "../scripts/build-assets.ts";
import { TEMPLATE } from "../grove/src/template-files.ts";

let b: typeof import("../grove/src/build.ts");

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "grove-build-"));
  for (const [name, bytes] of Object.entries(await buildAssets())) {
    if (!name.startsWith("build/")) continue;
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  process.env.GROVE_BUILD_ASSETS = dir;
  b = await import("../grove/src/build.ts");
});

test("the template every app starts from has no problems and bundles", async () => {
  assert.deepEqual(await b.check(TEMPLATE), []);
  const out = await b.bundle(TEMPLATE);
  assert.ok(Object.keys(out).some((f) => f.endsWith(".mjs")), "there is a bundle to run");
});

test("the template carries the kit, and its schema is safe to run on every start", () => {
  for (const f of ["src/maple/kit.ts", "src/maple/pages.ts", "src/app.ts", "src/index.ts", "maple.json", "AGENTS.md", "package.json"]) assert.ok(f in TEMPLATE, f);
  const schema = TEMPLATE["src/app.ts"].match(/schema = `([^`]*)`/)?.[1] ?? "";
  for (const stmt of schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    assert.match(stmt, /if not exists/i, stmt.slice(0, 60));
    assert.doesNotMatch(stmt, /\bdrop\b|\btruncate\b|\bdelete\b/i, stmt.slice(0, 60));
  }
});

test("a type mistake is reported with its file and line", async () => {
  const problems = await b.check({ ...TEMPLATE, "src/extra.ts": "export const n: number = 'not a number';\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src\/extra\.ts/);
  assert.match(problems[0], /1/);
});

test("an import of something that isn't packaged is caught", async () => {
  const files = { ...TEMPLATE, "src/extra.ts": "import leftPad from 'left-pad';\nexport const x = leftPad('a', 2);\n", "src/index.ts": TEMPLATE["src/index.ts"] + "\nimport './extra.ts';\n" };
  const [checked, bundled] = await Promise.allSettled([b.check(files), b.bundle(files)]);
  const said = [...(checked.status === "fulfilled" ? checked.value : []), ...(bundled.status === "rejected" ? [(bundled.reason as Error).message, ...((bundled.reason as any).problems ?? [])] : [])].join("\n");
  assert.match(said, /left-pad/);
});

test("a missing local file is caught", async () => {
  const files = { ...TEMPLATE, "src/index.ts": TEMPLATE["src/index.ts"] + "\nimport './nowhere.ts';\n" };
  await assert.rejects(b.bundle(files), (e: Error) => e instanceof b.BuildError);
});

test("zip: every file is in the archive", () => {
  const z = Buffer.from(b.zip({ "a.txt": "hello", "src/b.ts": "export {};\n", "empty.txt": "" }));
  assert.equal(z.readUInt32LE(0), 0x04034b50, "starts like a zip");
  const end = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, "has the closing record");
  assert.equal(z.readUInt16LE(end + 10), 3, "three files");
  for (const name of ["a.txt", "src/b.ts", "empty.txt"]) assert.ok(z.includes(name), name);
});
