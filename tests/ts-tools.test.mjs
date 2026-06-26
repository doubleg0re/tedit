import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runMcpTool } from "../dist/mcp-tools.js";
import { parseTsTriviaMap, runTsEdit, runTsMove, runTsSelect, serializeTsTriviaMap } from "../dist/ts-tools.js";

test("ts trivia map is lossless and classifies comments/directives/blank lines", () => {
  const source = "\"use client\";\r\n\r\n// owned\r\nexport function alpha() {\r\n  const x = /* intra */ 1; // same line\r\n}\r\n";
  const map = parseTsTriviaMap(source);

  assert.equal(serializeTsTriviaMap(source, map), source);
  assert.equal(map.lineEnding, "\r\n");
  assert.ok(map.sourceHash);
  assert.ok(map.trivia.some((item) => item.kind === "directive" && item.preview === "\"use client\";"));
  assert.ok(map.trivia.some((item) => item.kind === "blank-line"));
  assert.ok(map.trivia.some((item) => item.kind === "comment" && item.preview === "// owned" && item.relationship.kind === "own-line"));
  assert.ok(map.trivia.some((item) => item.kind === "comment" && item.preview === "/* intra */" && item.relationship.kind === "same-line-trailing"));
  assert.ok(map.trivia.some((item) => item.kind === "comment" && item.preview === "// same line" && item.relationship.kind === "same-line-trailing"));
});

test("ts-select finds declarations and ts-edit replaces only the block body", () => {
  const workspace = mkdtempSync(join(tmpdir(), "tedit-ts-edit-"));
  const file = join(workspace, "server.ts");
  const source = [
    "const untouched = 1;",
    "",
    "export function alpha() {",
    "  return 1;",
    "}",
    "",
    "class Service {",
    "  start() {",
    "    return alpha();",
    "  }",
    "}",
    "",
  ].join("\n");
  writeFileSync(file, source);

  const select = runTsSelect(file, "fn:alpha");
  assert.equal(select.count, 1);
  assert.equal(select.matches[0].canReplaceBody, true);

  const result = runTsEdit(file, {
    selector: "fn:alpha",
    body: "\n  return 2;\n",
    dryRun: true,
  });
  assert.equal(result.changed, true);
  assert.equal(result.written, false);
  assert.equal(result.parser, "typescript");
  assert.match(result.diff, /return 2/);
  assert.equal(readFileSync(file, "utf8"), source);

  runTsEdit(file, {
    selector: "method:Service.start",
    body: "\n    return 3;\n  ",
    write: true,
    noBackup: true,
  });
  const next = readFileSync(file, "utf8");
  assert.match(next, /return 3/);
  assert.match(next, /const untouched = 1/);

  runTsEdit(file, {
    selector: "fn:alpha",
    body: "{\n  return 4;\n}",
    write: true,
    noBackup: true,
  });
  assert.match(readFileSync(file, "utf8"), /function alpha\(\) \{\n  return 4;\n\}/);
  assert.doesNotMatch(readFileSync(file, "utf8"), /\{\s*\{/);
});

test("ts-move carries owned leading trivia and requires confirmation for writes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "tedit-ts-move-"));
  const file = join(workspace, "server.ts");
  const source = [
    "// module note",
    "",
    "// owned alpha",
    "function alpha() {",
    "  return \"a\";",
    "}",
    "",
    "function beta() {",
    "  return \"b\";",
    "}",
    "",
  ].join("\n");
  writeFileSync(file, source);

  const dryRun = runTsMove(file, {
    target: "fn:alpha",
    after: "fn:beta",
    dryRun: true,
  });
  assert.equal(dryRun.changed, true);
  assert.equal(dryRun.written, false);
  assert.equal(dryRun.trivia.carried.length, 1);
  assert.equal(dryRun.trivia.carried[0].preview, "// owned alpha");
  assert.equal(dryRun.trivia.adjacentNotCarried[0].preview, "// module note");
  assert.match(dryRun.diff, /function beta/);
  assert.equal(readFileSync(file, "utf8"), source);

  assert.throws(
    () => runTsMove(file, { target: "fn:alpha", after: "fn:beta", write: true, noBackup: true }),
    (error) => error.code === "TS_MOVE_REQUIRES_TRIVIA_CONFIRMATION",
  );

  runTsMove(file, {
    target: "fn:alpha",
    after: "fn:beta",
    confirmTrivia: true,
    sourceHash: dryRun.sourceHash,
    write: true,
    noBackup: true,
  });
  const moved = readFileSync(file, "utf8");
  assert.ok(moved.indexOf("function beta") < moved.indexOf("// owned alpha"));
  assert.ok(moved.startsWith("// module note\n\n"));
});

test("ts-move rejects stale source hashes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "tedit-ts-stale-"));
  const file = join(workspace, "server.ts");
  writeFileSync(file, "function a() {}\nfunction b() {}\n");
  const dryRun = runTsMove(file, { target: "fn:a", after: "fn:b", dryRun: true });
  writeFileSync(file, "function a() {}\nfunction b() {}\nfunction c() {}\n");

  assert.throws(
    () => runTsMove(file, { target: "fn:a", after: "fn:b", sourceHash: dryRun.sourceHash, confirmTrivia: true, write: true, noBackup: true }),
    (error) => error.code === "TS_SOURCE_HASH_MISMATCH",
  );
});

test("mcp advanced ts tools return compact mutation contracts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "tedit-ts-mcp-"));
  const file = join(workspace, "server.ts");
  writeFileSync(file, "function alpha() {\n  return 1;\n}\nfunction beta() {}\n");

  const select = runMcpTool("ts_select", { file, selector: "fn:alpha" });
  assert.equal(select.ok, true);
  assert.equal(select.kind, "ts-select");
  assert.equal(select.count, 1);

  const edit = runMcpTool("ts_edit", {
    file,
    selector: "fn:alpha",
    body: "\n  return 2;\n",
    dryRun: true,
    diffMode: "stats",
  });
  assert.equal(edit.ok, true);
  assert.equal(edit.kind, "mutation");
  assert.equal(edit.path, file);
  assert.equal(edit.changedCount, 1);
  assert.equal(edit.writtenCount, 0);
  assert.equal(edit.parser, "typescript");

  const move = runMcpTool("ts_move", {
    file,
    target: "fn:alpha",
    after: "fn:beta",
    dryRun: true,
    diffMode: "stats",
  });
  assert.equal(move.ok, true);
  assert.equal(move.kind, "mutation");
  assert.equal(move.files[0].diff.mode, "stats");
});

test("mcp ts_edit runs verify argv and rolls back on failure", () => {
  const workspace = mkdtempSync(join(tmpdir(), "tedit-ts-mcp-verify-"));
  const file = join(workspace, "server.ts");
  const original = "function alpha() {\n  return 1;\n}\n";
  writeFileSync(file, original);

  const passed = runMcpTool("ts_edit", {
    file,
    selector: "fn:alpha",
    body: "\n  return 2;\n",
    write: true,
    noBackup: true,
    verify: { cmd: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5000 },
    output: "detailed",
  });
  assert.equal(passed.success, true);
  assert.equal(passed.verify.passed, true);
  assert.match(readFileSync(file, "utf8"), /return 2/);

  const beforeFail = readFileSync(file, "utf8");
  const failed = runMcpTool("ts_edit", {
    file,
    selector: "fn:alpha",
    body: "\n  return 3;\n",
    write: true,
    noBackup: true,
    verify: {
      cmd: [process.execPath, "-e", "console.error('server.ts(1,1): error TS9999: nope'); process.exit(7)"],
      timeoutMs: 5000,
      rollbackOnFail: true,
    },
    output: "detailed",
  });

  assert.equal(failed.success, true);
  assert.equal(failed.verify.passed, false);
  assert.equal(failed.verify.exitCode, 7);
  assert.equal(failed.verification_failed, true);
  assert.equal(failed.verify.rollback.attempted, true);
  assert.equal(failed.verify.diagnostics[0].code, "TS9999");
  assert.equal(readFileSync(file, "utf8"), beforeFail);
});
