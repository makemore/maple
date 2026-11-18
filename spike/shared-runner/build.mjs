// Bundles an app for the sandbox: the same app code and the same kit, with only the four
// host-specific packages swapped for the stand-ins in shims/.
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { templateFiles } from "../../scripts/bundle-template.ts";

const here = new URL(".", import.meta.url).pathname;
const shim = (f) => join(here, "shims", f);

export async function bundleApp(name, changeApp = (s) => s) {
  const files = templateFiles();
  files["maple.json"] = JSON.stringify({ maple: "0.1", name, title: `App ${name}`, description: "A spike app.", maker: { name: "Maker", email: "maker@example.com" }, auth: { method: "email-code", allowed: [] }, mcp: { audience: "everyone" }, loop: {}, database: {} });
  files["src/app.ts"] = changeApp(files["src/app.ts"]);
  const dir = mkdtempSync(join(tmpdir(), "grove-spike-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  const out = await build({
    entryPoints: [join(dir, "src/index.ts")],
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022", conditions: ["workerd", "worker", "import"], mainFields: ["module", "main"],
    external: ["node:*"],
    nodePaths: [join(here, "../../node_modules")],
    alias: { pg: shim("pg.js"), "@neon/functions": shim("neon-functions.js"), "@neon/oauth/mcp": shim("neon-oauth-mcp.js"), "@neon/oauth/mcp/hono": shim("neon-oauth-mcp-hono.js") },
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}
