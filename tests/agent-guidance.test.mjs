import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runMcpTool } from "../dist/mcp-tools.js";

function readDetailValue(descriptor) {
  const detail = runMcpTool("read_detail", { id: descriptor.id, limitBytes: 50_000 });
  if (detail.data !== undefined) return detail.data;
  return JSON.parse(detail.text);
}

test("actions guidance gives agents a stable workflow decision table", () => {
  const actions = runMcpTool("actions", {});
  const guide = readDetailValue(actions.guidance);

  assert.equal(actions.ok, true);
  assert.equal(actions.guidance.$detail, true);
  assert.ok(Array.isArray(guide.workflow_guide));
  assert.ok(guide.workflow_guide.some((row) => row.when.includes("target context") && row.first_tool === "search"));
  assert.ok(guide.workflow_guide.some((row) => row.when.includes("one localized") && row.first_tool === "edit"));
  assert.ok(guide.workflow_guide.some((row) => row.when.includes("several places") && row.then === "multiedit"));
  assert.ok(guide.workflow_guide.some((row) => row.when.includes("generated diff") && row.first_tool === "patch"));
  assert.ok(guide.workflow_guide.some((row) => row.when.includes("delete or rename") && row.first_tool === "delete_file or rename_file"));
  assert.ok(guide.workflow_guide.some((row) => row.when.includes("validation") && row.first_tool === "edit/multiedit/patch with verify"));
  assert.ok(guide.workflow_guide.some((row) => row.when.includes("whole file") && row.first_tool === "file_write"));
  assert.ok(guide.workflow_guide.some((row) => row.when.includes("hardcoded") && row.first_tool === "scan_strings"));
  assert.equal(guide.mutate_cheatsheet.targets.jsx, "jsx:<selector> or id:jsx:<id>");
  assert.equal(guide.mutate_cheatsheet.examples.jsx_prop["prop.set"].name, "disabled");
  assert.deepEqual(guide.mutate_cheatsheet.opPrefixes["body.replace"], ["fn:", "method:", "class:"]);
  assert.match(guide.mutate_cheatsheet.boundary, /single file \+ single structural transformation/);

  const recoveryCodes = guide.failure_recovery.map((row) => row.code);
  assert.deepEqual(recoveryCodes, [
    "MATCH_NONE",
    "MATCH_NOT_UNIQUE",
    "PARSE_BROKEN_AFTER_EDIT",
    "AST_MATCH_NONE",
    "PATCH_HUNK_FAILED",
  ]);

  assert.deepEqual(Object.keys(guide.examples).filter((key) => [
    "edit",
    "multiedit",
    "patch",
    "delete_file",
    "rename_file",
    "edit_with_verify",
    "file_write",
    "scan_strings",
    "ast_edit",
  ].includes(key)).sort(), [
    "ast_edit",
    "delete_file",
    "edit",
    "edit_with_verify",
    "file_write",
    "multiedit",
    "patch",
    "rename_file",
    "scan_strings",
  ]);
});

test("README documents the same agent workflow pivots", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const text of [
    "The `actions` response includes an agent workflow guide.",
    "`search` when the target",
    "`edit` for one localized",
    "`multiedit` after `search`",
    "`delete_file` or `rename_file`",
    "`patch` only when the change already exists",
    "`file_write` for whole-file generation",
    "`TEDIT_MCP_PROFILE=all` for compat/advanced",
    "`MATCH_NONE`",
    "`PATCH_HUNK_FAILED`",
  ]) {
    assert.ok(readme.includes(text), `${text} missing from README`);
  }
});
