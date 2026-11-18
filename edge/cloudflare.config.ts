// Grove's front door for apps, on Cloudflare. Deploy with: npm run deploy:edge (from the repo root).
import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  worker: {
    name: "grove-edge",
    entrypoint: "./worker.js",
    compatibilityDate: "2026-06-01",
    workersDev: false,
    previewUrls: false,
    // Which addresses come through here. EDGE_ROUTES is a comma-separated list of patterns on the apps domain,
    // e.g. "*.grovehelper.com/*" for every app, or one name while trying it out.
    triggers: (process.env.EDGE_ROUTES ?? "").split(",").filter(Boolean).map((pattern) => triggers.fetch({ pattern: pattern.trim(), zone: process.env.APPS_DOMAIN! })),
    env: {
      GROVE_URL: bindings.text(process.env.PUBLIC_URL!),
      // The shared runner (runner/) and the addresses that go to it, comma-separated. For now a short list;
      // later Grove will say which apps live there, as it does for the rest.
      RUNNER_ORIGIN: bindings.text(process.env.RUNNER_ORIGIN ?? ""),
      RUNNER_HOSTS: bindings.text(process.env.RUNNER_HOSTS ?? ""),
      EDGE_SECRET: bindings.secret(),
      // Requests one visitor may make to one app in a minute, before getting "too many requests".
      // Where the front door's own failures go (a Sentry DSN). Empty: nowhere.
      SENTRY_DSN: bindings.text(process.env.SENTRY_DSN ?? ""),
      LIMIT_PER_MINUTE: bindings.text(process.env.EDGE_LIMIT_PER_MINUTE ?? "600"),
    },
  },
});
