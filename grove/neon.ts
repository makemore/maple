import { build } from "esbuild";
import { defineConfig } from "@neon/config/v1";
import { buildAssets } from "../scripts/build-assets.ts";

export default defineConfig({
  auth: true,
  functions: {
    grove: {
      name: "Grove",
      source: "src/index.ts",
      // Grove's own code, plus what it needs to build apps inside itself (build/: the bundler as
      // WebAssembly, the packages apps may import, and the type files). See src/build.ts.
      bundler: async (fn: { source: string }): Promise<Record<string, Uint8Array>> => {
        const out = await build({
          entryPoints: [fn.source],
          bundle: true,
          write: false,
          format: "esm",
          platform: "node",
          target: "node24",
          outfile: "index.mjs",
          // CommonJS packages (TypeScript among them) expect require, __filename and __dirname.
          banner: {
            js: "import{createRequire as __mapleRequire}from'node:module';import{fileURLToPath as __mapleFile}from'node:url';const require=__mapleRequire(import.meta.url);const __filename=__mapleFile(import.meta.url);const __dirname=__mapleFile(new URL('.',import.meta.url));",
          },
        });
        return { "index.mjs": out.outputFiles[0].contents, ...(await buildAssets()) };
      },
      env: {
        // Grove's own Neon organization: where it creates one project per app.
        NEON_API_KEY: { value: process.env.GROVE_NEON_API_KEY, required: true },
        NEON_ORG_ID: { value: process.env.GROVE_NEON_ORG_ID, required: true },
        // Signs each app's own secret and the export links. Any long random string; changing it cuts apps off until they next ship.
        GROVE_SECRET: { value: process.env.GROVE_SECRET, required: true },
        // Apps get <name>.<this domain>. Its DNS needs a wildcard CNAME to Neon's custom-domain target. Unset: Neon's own addresses.
        APPS_DOMAIN: { value: process.env.APPS_DOMAIN, required: false },
        GROVE_MAX_APPS: { value: process.env.GROVE_MAX_APPS, required: false },
        // Stripe and Postmark keep the values already deployed when a deploy doesn't give them, so deploying from a
        // machine without those keys can't switch payments or email off.
        // Payments (all three, or none for free only): a Stripe secret key, the monthly price of the paid plan, and the
        // signing secret of a webhook to <site>/stripe/webhook for checkout.session.completed and customer.subscription.*.
        STRIPE_SECRET_KEY: { value: process.env.STRIPE_SECRET_KEY, required: false, onUndefined: "skip" },
        STRIPE_PRICE_ID: { value: process.env.STRIPE_PRICE_ID, required: false, onUndefined: "skip" },
        STRIPE_WEBHOOK_SECRET: { value: process.env.STRIPE_WEBHOOK_SECRET, required: false, onUndefined: "skip" },
        PAID_APPS_PER_PERSON: { value: process.env.PAID_APPS_PER_PERSON, required: false },
        // Tokens of tool traffic in a day before Grove stops and asks the person whether to carry on (default 150000).
        USAGE_WARN_TOKENS: { value: process.env.USAGE_WARN_TOKENS, required: false },
        // Where the code is public. With it, the front page says "open source" and links there.
        GROVE_REPO_URL: { value: process.env.GROVE_REPO_URL, required: false },
        // Who runs this Grove, for its terms and privacy pages. Until both are set the pages are drafts and nobody is asked to agree.
        GROVE_LEGAL_NAME: { value: process.env.GROVE_LEGAL_NAME, required: false },
        GROVE_CONTACT_EMAIL: { value: process.env.GROVE_CONTACT_EMAIL, required: false },
        // Loop and notify emails.
        POSTMARK_TOKEN: { value: process.env.POSTMARK_TOKEN, required: false, onUndefined: "skip" },
        PUBLIC_URL: { value: process.env.PUBLIC_URL, required: false },
        APPS_PER_PERSON: { value: process.env.APPS_PER_PERSON, required: false },
        // For tests only; acts as Grove's maker. Leave unset in normal use.
        MAPLE_TEST_TOKEN: { value: process.env.MAPLE_TEST_TOKEN, required: false },
      },
    },
  },
});
