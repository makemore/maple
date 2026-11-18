// Packs the runner into one file for the container. Loading thousands of small files one by one is
// what made it slow to start (about 3.5 seconds on Cloud Run); one file loads in a fraction of that.
// The sandbox runtime and the bundler carry programs of their own, so they stay as they are.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
await build({
  entryPoints: ["server.mjs"],
  outfile: "dist/server.mjs",
  bundle: true, platform: "node", format: "esm", target: "node22", minify: false, legalComments: "none",
  external: ["miniflare", "esbuild", "pg-native", "cloudflare:*"],
  banner: { js: "import{createRequire as __r}from'node:module';import{fileURLToPath as __f}from'node:url';const require=__r(import.meta.url);const __filename=__f(import.meta.url);const __dirname=__f(new URL('.',import.meta.url));" },
  logLevel: "error",
});
cpSync("dispatcher.js", "dist/dispatcher.js");
cpSync("shims", "dist/shims", { recursive: true });
console.log("packed dist/server.mjs");
