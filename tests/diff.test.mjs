import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unifiedDiff } from "../dist/diff.js";
import { parsePatchInput, runPatchInput } from "../dist/patch.js";

test("unifiedDiff emits bounded hunks with standard headers", () => {
  const oldText = numberedLines(127, { 64: "const x = 1;" });
  const newText = oldText.replace("const x = 1;", "const x = 2;");

  const diff = unifiedDiff(oldText, newText, "sample.ts");

  assert.match(diff, /^@@ -61,7 \+61,7 @@/m);
  assert.match(diff, /^-const x = 1;$/m);
  assert.match(diff, /^\+const x = 2;$/m);
  assert.ok(diff.split("\n").length <= 12);
  assert.ok(Buffer.byteLength(diff) < 300);
});

test("unifiedDiff splits distant changes and merges overlapping context", () => {
  const oldText = numberedLines(40);
  const distant = oldText.replace("line 5", "line five").replace("line 35", "line thirty-five");
  const nearby = oldText.replace("line 10", "line ten").replace("line 15", "line fifteen");

  assert.equal(countHunks(unifiedDiff(oldText, distant, "sample.ts")), 2);
  assert.equal(countHunks(unifiedDiff(oldText, nearby, "sample.ts")), 1);
});

test("unifiedDiff handles file edge and whole-file add/delete cases", () => {
  assert.match(unifiedDiff("line 1\nline 2\n", "start\nline 2\n", "edge.txt"), /^@@ -1,2 \+1,2 @@/m);
  assert.match(unifiedDiff("line 1\nline 2\n", "line 1\nend\n", "edge.txt"), /^@@ -1,2 \+1,2 @@/m);

  const added = unifiedDiff("", "created\n", "new.txt");
  assert.match(added, /^@@ -0,0 \+1,1 @@/m);
  assert.match(added, /^\+created$/m);

  const deleted = unifiedDiff("removed\n", "", "gone.txt");
  assert.match(deleted, /^@@ -1,1 \+0,0 @@/m);
  assert.match(deleted, /^-removed$/m);
});

test("unifiedDiff output can round-trip through the patch parser", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-diff-"));
  const file = join(dir, "notes.txt");
  const oldText = "alpha\nbeta\ngamma\n";
  const newText = "alpha\nBETA\ngamma\n";
  writeFileSync(file, oldText);

  const diff = unifiedDiff(oldText, newText, file);
  const parsed = parsePatchInput(diff);
  const result = runPatchInput(diff, { dryRun: true, noBackup: true });

  assert.equal(parsed[0].hunks.length, 1);
  assert.equal(result.files[0].file, file);
  assert.equal(result.files[0].changed, true);
  assert.equal(result.files[0].written, false);
  assert.equal(result.files[0].diff, diff);
});

function numberedLines(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => overrides[index + 1] ?? `line ${index + 1}`).join("\n") + "\n";
}

function countHunks(diff) {
  return diff.split("\n").filter((line) => line.startsWith("@@")).length;
}
