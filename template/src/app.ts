// This app's own features: its tables, what the assistant should know, and its tools.
// See AGENTS.md for how to add a feature.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Hono } from "hono";
import type { Pool } from "pg";
import manifest from "../maple.json" with { type: "json" };
import { z, type Ctx, type Services } from "./maple/kit.ts";

/** Tables, created on every start, so always "if not exists". Add columns with "alter table ... add column if not exists". */
export const schema = `
`;

/** What the app is for, for the assistant. Update it as features are added. */
export const guide = manifest.description ?? "";

export function tools(server: McpServer, { json }: Ctx) {
  server.registerTool(
    "about",
    {
      title: "What this app does",
      annotations: { readOnlyHint: true },
      description: "What this app is for and what it can do so far. Use it when someone asks what the app can do.",
      inputSchema: {},
    },
    async () => json({ description: manifest.description, features: "None yet besides asking the maker for changes. Ask for what you need." }),
  );
  void z;
}

/** Web pages and other routes, if any. Paths under /api/ require sign-in; everything else is public. See AGENTS.md. */
export function routes(_app: Hono, _pool: Pool, _services: Services) {}

/** The front page at "/", as HTML, for a public website. Left undefined, "/" is the sign-in page. */
export const home: ((info: { title: string; site: string; mcpUrl: string }) => string) | undefined = undefined;
