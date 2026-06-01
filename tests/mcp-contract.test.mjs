import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMcpTool, toolsForMcpProfile } from "../dist/mcp-tools.js";

test("mcp default profile tools share compact agent contracts", () => {
  const workspace = createWorkspace();
  const defaultTools = toolsForMcpProfile("agent").map((tool) => tool.name).sort();
  assert.deepEqual(defaultTools, [
    "actions",
    "edit",
    "file_write",
    "inspect_range",
    "multiedit",
    "patch",
    "search_text",
    "verify_file",
  ].sort());

  const actions = runMcpTool("actions", {});
  assert.equal(actions.ok, true);
  assert.equal(actions.success, undefined);
  assert.equal(actions.kind, "actions");
  assert.equal(actions.profiles.current, "agent");
  assert.deepEqual(actions.profiles.agent.sort(), defaultTools);
  assert.ok(actions.guidance.edit_loop.some((row) => row.tool === "edit"));
  assert.ok(actions.guidance.edit_loop.some((row) => row.tool === "search_text"));

  const inspect = runMcpTool("inspect_range", { file: workspace.page, lines: "2", context: 1 });
  assert.equal(inspect.ok, true);
  assert.equal(inspect.success, undefined);
  assert.equal(inspect.kind, "inspect-range");
  assert.equal(inspect.path, workspace.page);
  assert.equal(inspect.file, workspace.page);
  assert.equal(inspect.lines.length, 3);
  assert.equal(inspect.parser, "jsx");
  assert.equal(inspect.suggestions[0].tool, "edit");

  const search = runMcpTool("search_text", {
    query: "삭제",
    paths: [workspace.src],
    glob: "**/*.tsx",
    multieditSpec: true,
    replace: "Delete",
  });
  assert.equal(search.ok, true);
  assert.equal(search.success, undefined);
  assert.equal(search.kind, "search-text");
  assert.equal(search.count, 1);
  assert.equal(search.resultsShown, 1);
  assert.equal(search.resultsTruncated, undefined);
  assert.equal(search.multiedit.edits.length, 1);
  assert.equal(search.files.length, 1);
  assert.equal(search.files[0].path, workspace.page);
  assert.equal(search.results[0].fileId, search.files[0].id);
  assert.equal(search.results[0].lineRange, "2");
  assert.equal(search.results[0].suggested, undefined);
  assert.equal(search.results[0].suggestions, undefined);
  assert.ok(search.suggestions.some((suggestion) => suggestion.includes("inspect_range")));

  const verify = runMcpTool("verify_file", { file: workspace.config });
  assert.equal(verify.ok, true);
  assert.equal(verify.success, undefined);
  assert.equal(verify.kind, "verify-file");
  assert.equal(verify.path, workspace.config);
  assert.equal(verify.file, undefined);
  assert.equal(verify.parse_verified, true);
  assert.equal(verify.parser, "json");

  const verifyMany = runMcpTool("verify_file", { files: [workspace.config, workspace.page] });
  assert.equal(verifyMany.ok, true);
  assert.equal(verifyMany.success, undefined);
  assert.equal(verifyMany.kind, "verify-files");
  assert.equal(verifyMany.count, 2);
  assert.equal(verifyMany.verifiedCount, 2);
  assert.equal(verifyMany.files.length, 2);
  assert.equal(verifyMany.files[0].path, workspace.config);
  assert.equal(verifyMany.files[0].file, undefined);
  assert.equal(verifyMany.files[1].path, workspace.page);
  assert.equal(verifyMany.files[1].parser, "jsx");

  const edit = runMcpTool("edit", {
    file: workspace.notes,
    find: "draft",
    replace: "final",
    dryRun: true,
    diffMode: "stats",
  });
  assertMutationContract(edit, workspace.notes, { changedCount: 1, writtenCount: 0, persisted: false });
  assert.equal(edit.next[0], "rerun with write=true to apply");

  const multiedit = runMcpTool("multiedit", {
    edits: [
      { file: workspace.notes, find: "draft", replace: "queued" },
      { file: workspace.config, find: "true", replace: "false" },
    ],
    dryRun: true,
    diffMode: "stats",
  });
  assertMutationContract(multiedit, undefined, { changedCount: 2, writtenCount: 0, persisted: false });
  assert.equal(multiedit.files.length, 2);

  const patch = runMcpTool("patch", {
    patch: `--- ${workspace.notes}
+++ ${workspace.notes}
@@ -1,2 +1,2 @@
 # Notes
-status: draft
+status: patched
`,
    dryRun: true,
    diffMode: "stats",
  });
  assertMutationContract(patch, workspace.notes, { changedCount: 1, writtenCount: 0, persisted: false });

  const written = runMcpTool("file_write", {
    mode: "write",
    file: workspace.generated,
    source: "{\"ok\":true}\n",
    dryRun: true,
    diffMode: "stats",
  });
  assertMutationContract(written, workspace.generated, { changedCount: 1, writtenCount: 0, persisted: false });
  assert.equal(written.parser, "json");
  assert.equal(written.files[0].change, "created");
});

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "tedit-mcp-contract-"));
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  const page = join(src, "Page.tsx");
  const notes = join(root, "notes.md");
  const config = join(root, "config.json");
  const generated = join(root, "generated.json");
  writeFileSync(page, "export function Page() {\n  return <button>삭제</button>;\n}\n");
  writeFileSync(notes, "# Notes\nstatus: draft\n");
  writeFileSync(config, "{\"enabled\":true}\n");
  return { root, src, page, notes, config, generated };
}

function assertMutationContract(result, path, expected) {
  assert.equal(result.ok, true);
  assert.equal(result.success, undefined);
  assert.equal(result.kind, "mutation");
  assert.equal(result.changedCount, expected.changedCount);
  assert.equal(result.writtenCount, expected.writtenCount);
  assert.equal(result.diff, undefined);
  assert.equal(result.write_policy, undefined);
  if (path) assert.equal(result.path, path);
  assert.ok(result.files.every((file) => file.file === undefined));
  assert.ok(result.files.every((file) => file.changed === undefined));
  assert.ok(result.files.every((file) => file.written === undefined));
  assert.ok(result.files.every((file) => file.persisted === expected.persisted));
  assert.ok(result.files.every((file) => file.diff.mode === "stats"));
}
