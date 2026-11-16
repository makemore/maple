import assert from "node:assert/strict";
import { test } from "node:test";
import { schema } from "./app.ts";

test("schema is safe to run on every start", () => {
  for (const stmt of schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    assert.match(stmt, /if not exists/i, "every statement must be idempotent: " + stmt.slice(0, 60));
    assert.doesNotMatch(stmt, /\bdrop\b|\btruncate\b|\bdelete\b/i, "no destructive statements: " + stmt.slice(0, 60));
  }
});
