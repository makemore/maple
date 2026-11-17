import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,
  functions: {
    app: {
      name: "app",
      source: "src/index.ts",
      env: {
        // Set by Grove on each deploy. Loop emails go through Grove; MAPLE_COMMIT says which version is live.
        GROVE_URL: { value: process.env.GROVE_URL, required: false },
        GROVE_APP_SECRET: { value: process.env.GROVE_APP_SECRET, required: false },
        PUBLIC_URL: { value: process.env.PUBLIC_URL, required: false },
        MAPLE_COMMIT: { value: process.env.MAPLE_COMMIT, required: false },
      },
    },
  },
  // Scheduled jobs call the app over HTTP. Grove doesn't set these up yet; they apply when you deploy this yourself:
  // triggers: { daily: { type: "schedule", function: "app", cron: "0 9 * * *", functionPath: "/jobs/daily" } },
});
