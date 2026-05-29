import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;

test("recovery: compact match errors include bounded retry hints", () => {
  const dir = createWorkspace();

  const none = runFail(["edit", "notes.txt", "--find", "Helo", "--replace", "x", "--dry-run"], dir);
  assert.equal(none.status, 1);
  assert.equal(none.body.ok, false);
  assert.equal(none.body.kind, "error");
  assert.equal(none.body.code, "MATCH_NONE");
  assert.equal(none.body.details, undefined);
  assert.equal(none.body.next[0], "Retry near candidate 1 with --find-lines 1.");
  assert.ok(none.body.next.length <= 3);

  const ambiguous = runFail(["edit", "notes.txt", "--find", "Hello world", "--replace", "x", "--dry-run"], dir);
  assert.equal(ambiguous.status, 1);
  assert.equal(ambiguous.body.code, "MATCH_NOT_UNIQUE");
  assert.equal(ambiguous.body.next[0], "Retry candidate 1 with --find-lines 1.");
  assert.ok(ambiguous.body.next.length <= 3);
});

test("recovery: compact multiedit errors explain the expected input shape", () => {
  const dir = createWorkspace();

  const invalidJson = runFail(["multiedit", "--from-stdin", "--dry-run"], dir, "{not json");
  assert.equal(invalidJson.status, 1);
  assert.equal(invalidJson.body.ok, false);
  assert.equal(invalidJson.body.code, "INVALID_MULTIEDIT");
  assert.deepEqual(invalidJson.body.next, [
    "Validate stdin as JSON before piping it to tedit multiedit.",
    "Pass an edits array or an object shaped like {\"edits\":[...]}.",
  ]);

  const searchResultShape = runFail(["multiedit", "--from-stdin", "--dry-run"], dir, JSON.stringify({
    kind: "search-text",
    multiedit: { edits: [{ file: "notes.txt", find: "alpha", replace: "beta" }] },
  }));
  assert.equal(searchResultShape.status, 1);
  assert.equal(searchResultShape.body.code, "INVALID_MULTIEDIT");
  assert.match(searchResultShape.body.next[0], /\.multiedit/);
});

test("recovery: compact patch hunk failures point to current context", () => {
  const dir = createWorkspace();
  const patch = `--- notes.txt
+++ notes.txt
@@ -1,2 +1,2 @@
-missing
+patched
 beta
`;

  const failed = runFail(["patch", "--stdin", "--write"], dir, patch);
  assert.equal(failed.status, 1);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.code, "PATCH_HUNK_FAILED");
  assert.match(failed.body.next[0], /tedit inspect-range "notes\.txt" --lines 1:1 --context 3 --json/);
  assert.ok(failed.body.next.length <= 3);
  assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "Hello world\nbeta\nHello world\n");
});

test("recovery: compact parse failures keep a concrete next step", () => {
  const dir = createWorkspace();

  const failed = runFail([
    "edit",
    "config.json",
    "--find",
    "\"enabled\": true",
    "--replace",
    "\"enabled\": }",
    "--dry-run",
  ], dir);
  assert.equal(failed.status, 1);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.equal(failed.body.next[0], "Inspect the reported line, fix the syntax, then rerun the same tedit command.");
  assert.equal(failed.body.details, undefined);
});

function createWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "tedit-recovery-"));
  writeFileSync(join(dir, "notes.txt"), "Hello world\nbeta\nHello world\n");
  writeFileSync(join(dir, "config.json"), "{\n  \"enabled\": true\n}\n");
  return dir;
}

function runFail(args, cwd, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: compactEnv(),
  });
  return {
    status: result.status,
    body: JSON.parse(result.stderr || result.stdout),
  };
}

function compactEnv() {
  return { ...process.env, FORCE_COLOR: "0", TEDIT_OUTPUT: "compact" };
}
