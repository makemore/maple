import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,
  functions: {
    grove: {
      name: "Grove",
      source: "src/index.ts",
      env: {
        // Grove's own Neon organization: where it creates one project per app.
        NEON_API_KEY: { value: process.env.GROVE_NEON_API_KEY, required: true },
        NEON_ORG_ID: { value: process.env.GROVE_NEON_ORG_ID, required: true },
        // Grove's GitHub App, installed on the organization that holds the apps' repositories.
        GITHUB_APP_ID: { value: process.env.GITHUB_APP_ID, required: true },
        GITHUB_APP_PRIVATE_KEY: { value: process.env.GITHUB_APP_PRIVATE_KEY, required: true },
        GITHUB_ORG: { value: process.env.GITHUB_ORG, required: true },
        // Loop and notify emails.
        POSTMARK_TOKEN: { value: process.env.POSTMARK_TOKEN, required: false },
        PUBLIC_URL: { value: process.env.PUBLIC_URL, required: false },
        APPS_PER_PERSON: { value: process.env.APPS_PER_PERSON, required: false },
        // For tests only; acts as Grove's maker. Leave unset in normal use.
        MAPLE_TEST_TOKEN: { value: process.env.MAPLE_TEST_TOKEN, required: false },
      },
    },
  },
});
