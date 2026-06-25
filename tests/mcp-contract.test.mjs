import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMcpTool, toolsForMcpProfile } from "../dist/mcp-tools.js";

function readDetailValue(descriptor, extra = {}) {
  const detail = runMcpTool("read_detail", { id: descriptor.id, limitBytes: 50_000, ...extra });
  if (detail.data !== undefined) return detail.data;
  return JSON.parse(detail.text);
}

test("mcp default profile tools share compact agent contracts", () => {
  const workspace = createWorkspace();
  const defaultTools = toolsForMcpProfile("agent").map((tool) => tool.name).sort();
  assert.deepEqual(defaultTools, [
    "actions",
    "delete_file",
    "edit",
    "file_write",
    "flow",
    "inspect_range",
    "multiedit",
    "patch",
    "read_detail",
    "refactor",
    "rename_file",
    "search_text",
    "select",
    "ts_edit",
    "ts_move",
    "ts_select",
    "verify_file",
  ].sort());

  const actions = runMcpTool("actions", {});
  assert.equal(actions.ok, true);
  assert.equal(actions.success, undefined);
  assert.equal(actions.kind, "actions");
  assert.equal(actions.profiles.current, "agent");
  assert.deepEqual(actions.profiles.agent.sort(), defaultTools);
  assert.equal(actions.guidance.$detail, true);
  const guidance = readDetailValue(actions.guidance);
  assert.ok(guidance.edit_loop.some((row) => row.tool === "edit"));
  assert.ok(guidance.edit_loop.some((row) => row.tool === "search_text"));
  assert.ok(guidance.edit_loop.some((row) => row.tool === "select"));
  assert.ok(guidance.refactor_loop.some((row) => row.tool === "refactor"));

  const select = runMcpTool("select", { file: workspace.page, selector: "button" });
  assert.equal(select.ok, true);
  assert.equal(select.kind, "select");
  assert.equal(select.language, "tsx");
  assert.ok(select.matches.some((match) => match.route === "jsx" && match.kind === "jsx.element"));
  assert.ok(select.matches.some((match) => match.editHint?.tool === "edit"));

  const pythonSelect = runMcpTool("select", { file: workspace.python, selector: "train_model" });
  assert.equal(pythonSelect.ok, true);
  assert.equal(pythonSelect.kind, "select");
  assert.equal(pythonSelect.language, "py");
  assert.equal(pythonSelect.route, "python");
  assert.ok(pythonSelect.matches.some((match) => match.kind === "python.function" && match.name === "train_model"));
  assert.ok(pythonSelect.matches.some((match) => match.editHint?.tool === "edit" && match.editHint.findLines));

  const pythonClassSelect = runMcpTool("select", { file: workspace.python, kind: "class", selector: "Trainer" });
  assert.equal(pythonClassSelect.ok, true);
  assert.equal(pythonClassSelect.matches[0].kind, "python.class");

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

  const verifyPython = runMcpTool("verify_file", { file: workspace.python });
  assert.equal(verifyPython.ok, true);
  assert.equal(verifyPython.parse_verified, true);
  assert.equal(verifyPython.parser, "python-syntax");

  const verifyMany = runMcpTool("verify_file", { files: [workspace.config, workspace.page, workspace.python] });
  assert.equal(verifyMany.ok, true);
  assert.equal(verifyMany.success, undefined);
  assert.equal(verifyMany.kind, "verify-files");
  assert.equal(verifyMany.count, 3);
  assert.equal(verifyMany.verifiedCount, 3);
  assert.equal(verifyMany.files.length, 3);
  assert.equal(verifyMany.files[0].path, workspace.config);
  assert.equal(verifyMany.files[0].file, undefined);
  assert.equal(verifyMany.files[1].path, workspace.page);
  assert.equal(verifyMany.files[1].parser, "jsx");
  assert.equal(verifyMany.files[2].path, workspace.python);
  assert.equal(verifyMany.files[2].parser, "python-syntax");

  const edit = runMcpTool("edit", {
    file: workspace.notes,
    find: "draft",
    replace: "final",
    dryRun: true,
    diffMode: "stats",
  });
  assertMutationContract(edit, workspace.notes, { changedCount: 1, writtenCount: 0, persisted: false });
  assert.equal(edit.next[0], "rerun with write=true to apply");

  const pythonEdit = runMcpTool("edit", {
    file: workspace.python,
    find: "TIMEOUT = 30",
    replace: "TIMEOUT = 60",
    write: true,
    noBackup: true,
    diffMode: "stats",
  });
  assertMutationContract(pythonEdit, workspace.python, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.equal(pythonEdit.parser, "python-syntax");
  const pythonBeforeInvalid = readFileSync(workspace.python, "utf8");
  assert.throws(
    () => runMcpTool("edit", {
      file: workspace.python,
      find: "def train_model(path: str) -> dict[str, float]:",
      replace: "def train_model(:",
      write: true,
      noBackup: true,
    }),
    (err) => err.code === "PARSE_BROKEN_AFTER_EDIT",
  );
  assert.equal(readFileSync(workspace.python, "utf8"), pythonBeforeInvalid);

  const verifiedEdit = runMcpTool("edit", {
    file: workspace.verifyPass,
    find: "before",
    replace: "after",
    write: true,
    verify: { cmd: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5000 },
  });
  assert.equal(verifiedEdit.ok, true);
  assert.equal(verifiedEdit.verify.passed, true);
  assert.match(verifiedEdit.summary, /verification passed/);
  assert.equal(readFileSync(workspace.verifyPass, "utf8"), "after\n");

  const failedVerifiedEdit = runMcpTool("edit", {
    file: workspace.verifyFail,
    find: "before",
    replace: "after",
    write: true,
    verify: { cmd: [process.execPath, "-e", "console.error('src/Page.tsx(1,2): error TS2322: Bad'); process.exit(7)"], timeoutMs: 5000, rollbackOnFail: true },
  });
  assert.equal(failedVerifiedEdit.ok, false);
  assert.equal(failedVerifiedEdit.verification_failed, true);
  assert.equal(failedVerifiedEdit.verify.passed, false);
  assert.equal(failedVerifiedEdit.verify.exitCode, 7);
  assert.deepEqual(failedVerifiedEdit.verify.diagnostics[0], {
    file: "src/Page.tsx",
    line: 1,
    column: 2,
    code: "TS2322",
    message: "Bad",
    source: "tsc",
  });
  assert.equal(failedVerifiedEdit.verify.rollback.attempted, true);
  assert.equal(readFileSync(workspace.verifyFail, "utf8"), "before\n");

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

  const flowFromChain = runMcpTool("flow", {
    file: workspace.page,
    chain: "find button as btn :: wrap @btn div.inline-flex",
    dryRun: true,
    diffMode: "stats",
  });
  assertMutationContract(flowFromChain, workspace.page, { changedCount: 1, writtenCount: 0, persisted: false });

  const flowFromSteps = runMcpTool("flow", {
    steps: [
      { action: "edit", file: workspace.notes, find: "draft", replace: "flowed" },
    ],
    dryRun: true,
    diffMode: "stats",
  });
  assertMutationContract(flowFromSteps, workspace.notes, { changedCount: 1, writtenCount: 0, persisted: false });

  const deleted = runMcpTool("delete_file", {
    file: workspace.deleteMe,
    dryRun: true,
    diffMode: "stats",
  });
  assertMutationContract(deleted, workspace.deleteMe, { changedCount: 1, writtenCount: 0, persisted: false });
  assert.equal(deleted.files[0].change, "deleted");
  assert.equal(existsSync(workspace.deleteMe), true);

  const renamed = runMcpTool("rename_file", {
    file: workspace.renameOld,
    to: workspace.renameNew,
    write: true,
    diffMode: "stats",
  });
  assertMutationContract(renamed, undefined, { changedCount: 2, writtenCount: 2, persisted: true });
  assert.equal(existsSync(workspace.renameOld), false);
  assert.equal(readFileSync(workspace.renameNew, "utf8"), "move me\n");

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

  const refactor = runMcpTool("refactor", {
    kind: "state",
    file: workspace.statePage,
    dryRun: true,
    diffMode: "stats",
  });
  assert.equal(refactor.success, true);
  assert.equal(refactor.files[0].file, workspace.statePage);
  assert.equal(refactor.files[0].changed, true);
  assert.equal(refactor.files[0].written, false);
  assert.match(refactor.state_object, /State$/);
});

test("compact output stores large payload fields as read_detail artifacts", () => {
  const workspace = createWorkspace();
  const noisy = join(workspace.src, "Many.tsx");
  writeFileSync(noisy, [
    "export const labels = [",
    ...Array.from({ length: 80 }, (_, index) => `  "label-${String(index).padStart(3, "0")}",`),
    "];",
    "",
  ].join("\n"));

  const result = runMcpTool("scan_strings", { file: noisy });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "scan-strings");
  assert.equal(result.strings.$detail, true);
  assert.ok(result.strings.bytes > 1024);
  assert.equal(result.strings.count, 80);
  assert.ok(existsSync(result.strings.path));
  assert.equal(result.strings.preview[0].id, "str_1");

  assert.equal(readDetailValue(result.strings, { path: "0.value" }), "label-000");
  const grep = runMcpTool("read_detail", { id: result.strings.id, grep: "label-042", limitBytes: 1000 });
  assert.equal(grep.kind, "detail");
  assert.match(grep.text, /label-042/);
  assert.throws(() => runMcpTool("read_detail", { file: "../outside.json" }), /stay inside/);
});

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "tedit-mcp-contract-"));
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  const page = join(src, "Page.tsx");
  const notes = join(root, "notes.md");
  const config = join(root, "config.json");
  const python = join(root, "train.py");
  const generated = join(root, "generated.json");
  const statePage = join(src, "StatePage.tsx");
  const deleteMe = join(root, "delete-me.txt");
  const renameOld = join(root, "old-name.txt");
  const renameNew = join(root, "new-name.txt");
  const verifyPass = join(root, "verify-pass.txt");
  const verifyFail = join(root, "verify-fail.txt");
  writeFileSync(page, "export function Page() {\n  return <button>삭제</button>;\n}\n");
  writeFileSync(statePage, `import { useState } from "react";

export function StatePage() {
  const [crewImportOpen, setCrewImportOpen] = useState(false);
  const [crewImportDayId, setCrewImportDayId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const openImport = (dayId: string) => {
    setCrewImportOpen(true);
    setCrewImportDayId(dayId);
  };

  return (
    <main>
      <button onClick={() => openImport("d1")}>Open</button>
      <span>{crewImportOpen ? crewImportDayId : "closed"}</span>
      <input value={search} onChange={(event) => setSearch(event.target.value)} />
    </main>
  );
}
`);
  writeFileSync(python, [
    "import torch",
    "from dataclasses import dataclass",
    "",
    "TIMEOUT = 30",
    "",
    "@dataclass",
    "class Trainer:",
    "  def fit(self):",
    "    return TIMEOUT",
    "",
    "def train_model(path: str) -> dict[str, float]:",
    "  return {\"loss\": 0.1}",
    "",
    "if __name__ == \"__main__\":",
    "  train_model(\"data\")",
    "",
  ].join("\n"));
  writeFileSync(notes, "# Notes\nstatus: draft\n");
  writeFileSync(config, "{\"enabled\":true}\n");
  writeFileSync(deleteMe, "remove me\n");
  writeFileSync(renameOld, "move me\n");
  writeFileSync(verifyPass, "before\n");
  writeFileSync(verifyFail, "before\n");
  return { root, src, page, statePage, python, notes, config, generated, deleteMe, renameOld, renameNew, verifyPass, verifyFail };
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
