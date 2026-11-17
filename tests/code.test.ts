// The rules for an app's code: what may be written, how changes combine, and kit updates.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANGE, MAX_FILES, RESERVED, SLUG, applyWrites, diff, merge, withKit } from "../grove/src/code.ts";

test("app names: short, lowercase, and not ones that look like Grove itself", () => {
  for (const ok of ["club-helper", "abc", "river-rowing-fees2"]) assert.match(ok, SLUG);
  for (const bad of ["a", "ab", "Club", "club_helper", "-club", "club-", "2club", "x".repeat(41), "a.b"]) assert.doesNotMatch(bad, SLUG);
  for (const taken of ["www", "grove", "admin", "login", "billing", "report", "terms"]) assert.ok(RESERVED.has(taken), taken);
  assert.match("add-fee-reminders", CHANGE);
  assert.doesNotMatch("Add Fees", CHANGE);
});

test("writes: add, replace and delete files", () => {
  const files = applyWrites({ "a.ts": "1", "b.ts": "2" }, [{ path: "a.ts", content: "one" }, { path: "b.ts", content: null }, { path: "src/c.ts", content: "3" }]);
  assert.deepEqual(files, { "a.ts": "one", "src/c.ts": "3" });
});

test("writes: the starting files are not changed in place", () => {
  const before = { "a.ts": "1" };
  applyWrites(before, [{ path: "a.ts", content: "2" }]);
  assert.deepEqual(before, { "a.ts": "1" });
});

test("writes: the kit, paths outside the app, binary content and broken maple.json are refused", () => {
  const refuse = (path: string, content: string | null, why: RegExp) => assert.throws(() => applyWrites({}, [{ path, content }]), why, path);
  refuse("src/maple/kit.ts", "x", /belongs to MAPLE/);
  refuse("src/maple/kit.ts", null, /belongs to MAPLE/);
  refuse("package-lock.json", "{}", /belongs to MAPLE/);
  refuse("/etc/passwd", "x", /Bad path/);
  refuse("../other/app.ts", "x", /Bad path/);
  refuse("src\\app.ts", "x", /Bad path/);
  refuse("src/a.ts", "a\0b", /isn't a text file/);
  refuse("maple.json", "{not json", /JSON/);
});

test("writes: an app can't grow past Grove's size limits", () => {
  const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `src/f${i}.ts`, content: "" }));
  assert.throws(() => applyWrites({}, many), /too big/);
  const big = Array.from({ length: 16 }, (_, i) => ({ path: `src/f${i}.ts`, content: "x".repeat(199_000) }));
  assert.throws(() => applyWrites({}, big), /too big/);
});

test("merge: changes to different files combine", () => {
  const base = { a: "1", b: "1" };
  const { files, clashes } = merge(base, { a: "live", b: "1" }, { a: "1", b: "mine" });
  assert.deepEqual(files, { a: "live", b: "mine" });
  assert.deepEqual(clashes, []);
});

test("merge: the same file changed both ways is a clash, and both making the same change is not", () => {
  assert.deepEqual(merge({ a: "1" }, { a: "live" }, { a: "mine" }).clashes, ["a"]);
  assert.deepEqual(merge({ a: "1" }, { a: "same" }, { a: "same" }), { files: { a: "same" }, clashes: [] });
});

test("merge: added and deleted files carry over from both sides", () => {
  const { files, clashes } = merge({ a: "1", b: "1" }, { a: "1", b: "1", c: "live-new" }, { a: "1", d: "mine-new" });
  assert.deepEqual(files, { a: "1", c: "live-new", d: "mine-new" });
  assert.deepEqual(clashes, []);
  assert.deepEqual(merge({ a: "1" }, { a: "changed" }, {}).clashes, ["a"], "deleting a file that changed meanwhile is a clash");
});

test("diff: says what was added, changed and deleted, in order", () => {
  assert.deepEqual(diff({ a: "1", b: "1", c: "1" }, { a: "1", b: "2", d: "1" }), ["changed b", "deleted c", "added d"]);
  assert.deepEqual(diff({ a: "1" }, { a: "1" }), []);
});

test("kit update: the kit is replaced whole and the maker's files are left alone", () => {
  const pkg = (deps: object) => JSON.stringify({ name: "x", dependencies: deps }, null, 2) + "\n";
  const app = { "src/app.ts": "mine", "src/maple/kit.ts": "old kit", "src/maple/gone.ts": "old", "package-lock.json": "old lock", "package.json": pkg({ hono: "^4.0.0", "date-fns": "^3.0.0" }), "AGENTS.md": "my notes" };
  const template = { "src/app.ts": "template app", "src/maple/kit.ts": "new kit", "src/maple/pages.ts": "new pages", "package-lock.json": "new lock", "package.json": pkg({ hono: "^4.13.0", zod: "^4.0.0" }), "AGENTS.md": "template notes" };
  const out = withKit(app, template);
  assert.equal(out["src/app.ts"], "mine");
  assert.equal(out["AGENTS.md"], "my notes");
  assert.equal(out["src/maple/kit.ts"], "new kit");
  assert.equal(out["src/maple/pages.ts"], "new pages");
  assert.ok(!("src/maple/gone.ts" in out), "kit files that no longer exist are removed");
  assert.equal(out["package-lock.json"], "new lock");
  assert.deepEqual(JSON.parse(out["package.json"]).dependencies, { hono: "^4.13.0", "date-fns": "^3.0.0", zod: "^4.0.0" });
});

test("kit update: an app that already has the newest kit is unchanged", () => {
  const app = { "src/app.ts": "mine", "src/maple/kit.ts": "kit", "package-lock.json": "lock", "package.json": '{"name":"mine","dependencies":{"hono":"1"}}' };
  const template = { "src/app.ts": "t", "src/maple/kit.ts": "kit", "package-lock.json": "lock", "package.json": '{\n  "name": "maple-app",\n  "dependencies": { "hono": "1" }\n}\n' };
  assert.deepEqual(diff(app, withKit(app, template)), []);
});
