// This app's own features: its tables, what the assistant should know, and its tools.
// See AGENTS.md for how to add a feature.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Pool } from "pg";
import manifest from "../maple.json" with { type: "json" };
import { z, type Ctx } from "./maple/kit.ts";

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

/** Extra web routes, if any. Paths under /api/ require sign-in. */
export function routes(_app: unknown, _pool: Pool) {}
