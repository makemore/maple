// Bundles an app for the shared runner: the same app code and the same kit, with the four
// host-specific packages swapped for the stand-ins in shims/.
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const shim = (f) => join(here, "shims", f);

/** files: the app's files by path (src/index.ts is the way in). Returns one JavaScript module as text. */
export async function bundleForRunner(files) {
  const dir = mkdtempSync(join(tmpdir(), "grove-runner-"));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    const out = await build({
      entryPoints: [join(dir, "src/index.ts")],
      bundle: true, write: false, format: "esm", platform: "node", target: "es2022", conditions: ["workerd", "worker", "import"], mainFields: ["module", "main"],
      external: ["node:*"],
      nodePaths: [join(here, "node_modules"), join(here, "../node_modules")],
      alias: { pg: shim("pg.js"), "@neon/functions": shim("neon-functions.js"), "@neon/oauth/mcp": shim("neon-oauth-mcp.js"), "@neon/oauth/mcp/hono": shim("neon-oauth-mcp-hono.js") },
      logLevel: "silent",
    });
    return out.outputFiles[0].text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
