import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMcpTool, toolsForMcpProfile } from "../dist/mcp-tools.js";
import { toErrorResult } from "../dist/errors.js";
import { formatAgentResult } from "../dist/output.js";

function readDetailValue(descriptor, extra = {}) {
  const detail = runMcpTool("read_detail", { id: descriptor.id, limitBytes: 50_000, ...extra });
  if (detail.data !== undefined) return detail.data;
  return JSON.parse(detail.text);
}

test("mcp edit stages an apply_dry_run id on high-confidence fuzzy-only failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "banner.ts");
  const original = 'const banner = {\n  title: "오늘의 랜덤 아티스트 추천을 지금 바로 확인해 보세요",\n};\n';
  writeFileSync(file, original);

  let error;
  try {
    runMcpTool("edit", { file, findExact: "오늘의 럜덤 아티스트 추천을 지금 바로 확인해 보세요", replace: "오늘의 무작위 추천" });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.code, "MATCH_FUZZY_ONLY");
  assert.equal(readFileSync(file, "utf8"), original);
  const staged = error.details.staged_apply;
  assert.equal(staged.tool, "apply_dry_run");
  assert.match(staged.arguments.id, /^dryrun_/);
  assert.ok(error.details.recovery_suggestions[0].includes("apply_dry_run"));

  const compactBody = formatAgentResult(toErrorResult(error), {});
  assert.equal(compactBody.staged_apply.arguments.id, staged.arguments.id);
  assert.ok(compactBody.suggestions.some((item) => item.includes("apply_dry_run")));

  const applied = runMcpTool("apply_dry_run", { id: staged.arguments.id });
  assert.equal(applied.ok, true);
  assert.equal(readFileSync(file, "utf8"), 'const banner = {\n  title: "오늘의 무작위 추천",\n};\n');
});

test("mcp edit does not stage apply ids for low-confidence no-match failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "short.ts");
  const original = 'const label = "랜딩섹션제목입니다";\n';
  writeFileSync(file, original);

  let error;
  try {
    runMcpTool("edit", { file, findExact: "럜딩섹션제목입니다", replace: "x" });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.code, "MATCH_NONE");
  assert.equal(error.details.staged_apply, undefined);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("mcp default profile tools share compact agent contracts", () => {
  const workspace = createWorkspace();
  const defaultTools = toolsForMcpProfile("agent").map((tool) => tool.name).sort();
  assert.deepEqual(defaultTools, [
    "actions",
    "apply_dry_run",
    "delete_file",
    "edit",
    "file_write",
    "flow",
    "multiedit",
    "mutate",
    "patch",
    "read_detail",
    "refactor",
    "rename_file",
    "search",
    "select",
    "verify_file",
    "version",
  ].sort());

  const versionResult = runMcpTool("version", {});
  assert.equal(versionResult.ok, true);
  assert.equal(versionResult.kind, "version");
  assert.match(versionResult.version, /^\d+\.\d+\.\d+/);
  assert.equal(versionResult.profile, "agent");
  assert.equal(versionResult.node, process.version);
  assert.ok(existsSync(join(versionResult.packageRoot, "package.json")));
  assert.match(versionResult.summary, /^tedit \d+\.\d+\.\d+ \(agent profile\)$/);

  const actions = runMcpTool("actions", {});
  assert.equal(actions.ok, true);
  assert.equal(actions.success, undefined);
  assert.equal(actions.kind, "actions");
  assert.match(actions.version, /^\d+\.\d+\.\d+/);
  assert.match(actions.summary, /^tedit \d+\.\d+\.\d+, \d+ actions available$/);
  assert.equal(actions.profiles.current, "agent");
  assert.deepEqual(actions.profiles.agent.sort(), defaultTools);
  assert.equal(actions.guidance.$detail, true);
  const guidance = readDetailValue(actions.guidance);
  assert.ok(guidance.edit_loop.some((row) => row.tool === "edit"));
  assert.ok(guidance.edit_loop.some((row) => row.tool === "search"));
  assert.ok(guidance.edit_loop.some((row) => row.tool === "select"));
  assert.ok(guidance.refactor_loop.some((row) => row.tool === "refactor"));

  const select = runMcpTool("select", { file: workspace.page, selector: "button" });
  assert.equal(select.ok, true);
  assert.equal(select.kind, "select");
  assert.equal(select.language, "tsx");
  assert.ok(select.matches.some((match) => match.route === "jsx" && match.kind === "jsx.element"));
  assert.ok(select.matches.some((match) => match.editHint?.tool === "edit"));
  assert.ok(select.matches.some((match) => match.editHint?.findLines === "2"));
  assert.ok(select.matches.some((match) => match.inspectHint?.tool === "search"));

  const multilinePage = join(workspace.src, "Multiline.tsx");
  writeFileSync(multilinePage, [
    "export function Page() {",
    "  return (",
    "    <button",
    "      className=\"primary\"",
    "    >",
    "      Save",
    "    </button>",
    "  );",
    "}",
    "",
  ].join("\n"));
  const multilineSelect = runMcpTool("select", { file: multilinePage, selector: "button" });
  assert.equal(multilineSelect.matches[0].editHint.find, undefined);
  assert.equal(multilineSelect.matches[0].editHint.findLines, "3:7");
  assert.equal(multilineSelect.matches[0].inspectHint.tool, "search");

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

  const inspect = runMcpTool("search", { file: workspace.page, lines: "2", context: 1 });
  assert.equal(inspect.ok, true);
  assert.equal(inspect.success, undefined);
  assert.equal(inspect.kind, "inspect-range");
  assert.equal(inspect.path, workspace.page);
  assert.equal(inspect.file, workspace.page);
  assert.equal(inspect.lines.length, 3);
  assert.equal(inspect.parser, "jsx");
  assert.equal(inspect.suggestions[0].tool, "edit");

  const search = runMcpTool("search", {
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
  assert.equal(search.matchCount, 1);
  assert.equal(search.fileCount, 1);
  assert.equal(search.resultsShown, 1);
  assert.equal(search.resultsTruncated, undefined);
  assert.equal(search.multiedit.edits.length, 1);
  assert.equal(search.multiedit.editCount, 1);
  assert.equal(search.multiedit.fileCount, 1);
  assert.equal(search.multiedit.matchCount, 1);
  assert.equal(search.files.length, 1);
  assert.equal(search.files[0].path, agentPath(workspace.page));
  assert.equal(search.results[0].fileId, search.files[0].id);
  assert.equal(search.results[0].lineRange, "2");
  assert.equal(search.results[0].suggested, undefined);
  assert.equal(search.results[0].suggestions, undefined);
  assert.ok(search.suggestions.some((suggestion) => suggestion.includes("search")));

  const overview = runMcpTool("search", { file: workspace.packedHtml });
  assert.equal(overview.ok, true);
  assert.equal(overview.kind, "file-overview");
  assert.equal(overview.packed.detected, true);
  assert.equal(overview.parser, "markup");
  assert.equal(overview.markup.title, "Bundled Page");
  assert.equal(overview.markup.scripts[0].packed, true);
  assert.ok(overview.suggestions.some((suggestion) => suggestion.arguments?.query === "<script"));

  const packedInspect = runMcpTool("search", { file: workspace.packedHtml, lines: "1" });
  assert.equal(packedInspect.ok, true);
  assert.equal(packedInspect.packed.detected, true);
  assert.equal(packedInspect.lines[0].truncated, true);
  assert.ok(packedInspect.lines[0].text.length < 5000);

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
  assert.equal(edit.next[0], "call apply_dry_run with suggestedActions[0].arguments to apply");
  assert.equal(edit.suggestedActions[0].tool, "apply_dry_run");

  const applyDryRun = runMcpTool("apply_dry_run", edit.suggestedActions[0].arguments);
  assertMutationContract(applyDryRun, workspace.notes, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.equal(readFileSync(workspace.notes, "utf8"), "# Notes\nstatus: final\n");
  writeFileSync(workspace.notes, "# Notes\nstatus: draft\n");

  const defaultEdit = runMcpTool("edit", { file: workspace.defaultEdit, find: "old", replace: "new", diffMode: "stats" });
  assertMutationContract(defaultEdit, workspace.defaultEdit, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.equal(readFileSync(workspace.defaultEdit, "utf8"), "new\n");

  const defaultMultiedit = runMcpTool("multiedit", { edits: [{ file: workspace.multiA, find: "old-a", replace: "new-a" }, { file: workspace.multiB, find: "old-b", replace: "new-b" }], diffMode: "stats" });
  assertMutationContract(defaultMultiedit, undefined, { changedCount: 2, writtenCount: 2, persisted: true });
  assert.equal(readFileSync(workspace.multiA, "utf8"), "new-a\n");
  assert.equal(readFileSync(workspace.multiB, "utf8"), "new-b\n");

  const defaultFlow = runMcpTool("flow", { steps: [{ action: "edit", file: workspace.flowText, find: "old", replace: "new" }], diffMode: "stats" });
  assertMutationContract(defaultFlow, workspace.flowText, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.equal(readFileSync(workspace.flowText, "utf8"), "new\n");

  const defaultTsEdit = runMcpTool("mutate", { file: workspace.tsDefault, target: "fn:target", "body.replace": { body: "return 2;" }, diffMode: "stats" });
  assertMutationContract(defaultTsEdit, workspace.tsDefault, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.match(readFileSync(workspace.tsDefault, "utf8"), /return 2;/);

  const staleDryRun = runMcpTool("edit", { file: workspace.notes, find: "draft", replace: "stale", dryRun: true, diffMode: "stats" });
  writeFileSync(workspace.notes, "# Notes\nstatus: changed\n");
  assert.throws(() => runMcpTool("apply_dry_run", staleDryRun.suggestedActions[0].arguments), (err) => err.code === "DRY_RUN_SOURCE_CHANGED");
  writeFileSync(workspace.notes, "# Notes\nstatus: draft\n");

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
    diffMode: "stats",
  });
  assertMutationContract(patch, workspace.notes, { changedCount: 1, writtenCount: 0, persisted: false });
  assert.equal(readFileSync(workspace.notes, "utf8"), "# Notes\nstatus: draft\n");

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

  const mutateClass = runMcpTool("mutate", { file: workspace.mutatePage, op: "class.replace", target: "jsx:Button", args: { from: "old", to: "new" }, diffMode: "stats" });
  assertMutationContract(mutateClass, workspace.mutatePage, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.match(readFileSync(workspace.mutatePage, "utf8"), /className="new"/);
  const mutateClassName = runMcpTool("mutate", { file: workspace.mutatePage, op: "class.add", target: "jsx:Button", args: { className: "tracking-[-0.02em]" }, diffMode: "stats" });
  assertMutationContract(mutateClassName, workspace.mutatePage, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.match(readFileSync(workspace.mutatePage, "utf8"), /tracking-\[-0\.02em\]/);
  const mutatePropKey = runMcpTool("mutate", { file: workspace.mutatePage, target: "jsx:Button", "prop.set": { name: "data-short", value: true }, diffMode: "stats" });
  assertMutationContract(mutatePropKey, workspace.mutatePage, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.match(readFileSync(workspace.mutatePage, "utf8"), /data-short/);
  const mutateTsBody = runMcpTool("mutate", { file: workspace.server, op: "body.replace", target: "fn:startServer", args: { body: 'return "new";' }, diffMode: "stats" });
  assertMutationContract(mutateTsBody, workspace.server, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.match(readFileSync(workspace.server, "utf8"), /return "new";/);
  const mutateTsRename = runMcpTool("mutate", { file: workspace.server, target: "fn:startServer", "declaration.rename": { to: "bootServer" }, diffMode: "stats" });
  assertMutationContract(mutateTsRename, workspace.server, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.match(readFileSync(workspace.server, "utf8"), /function bootServer/);
  assert.ok(mutateTsRename.warnings.some((warning) => warning.code === "TS_RENAME_EXPORTED_SYMBOL"));
  const mutateImport = runMcpTool("mutate", { file: workspace.mutatePage, op: "imports.rename", args: { from: "./old", name: "OldName", to: "NewName" }, diffMode: "stats" });
  assertMutationContract(mutateImport, workspace.mutatePage, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.match(readFileSync(workspace.mutatePage, "utf8"), /import \{ NewName \} from "\.\/old"/);
  const mutateAst = runMcpTool("mutate", { file: workspace.messages, op: "ast.replace", target: "objectKey:label", args: { replace: "Delete" }, diffMode: "stats" });
  assertMutationContract(mutateAst, workspace.messages, { changedCount: 1, writtenCount: 1, persisted: true });
  assert.match(readFileSync(workspace.messages, "utf8"), /label: "Delete"/);

  assert.throws(
    () => runMcpTool("mutate", { file: workspace.mutatePage, op: "bogus.op", target: "jsx:Button", args: {}, dryRun: true }),
    (err) => err.code === "INVALID_MCP_INPUT" && err.details?.supportedOps?.includes("body.replace"),
  );

  assert.throws(
    () => runMcpTool("mutate", { file: workspace.server, op: "body.replace", target: "ts:startServer", args: { body: "return ok;" }, dryRun: true }),
    (err) => err.code === "INVALID_MCP_INPUT" && err.details?.validPrefixes?.includes("fn:") && err.details?.didYouMean === "fn:startServer",
  );
  assert.throws(
    () => runMcpTool("mutate", { file: workspace.server, op: "text.replace", "text.replace": { find: "function startServer() { return old; }", replace: "function startServer() { return next; }" }, dryRun: true }),
    (err) => err.code === "INVALID_MCP_INPUT" && err.details?.suggestions?.some((item) => item.includes('op="body.replace" target="fn:startServer"')),
  );
  assert.throws(
    () => runMcpTool("mutate", { file: workspace.mutatePage, op: "imports.rename", args: { from: "./old", to: "NewName" }, dryRun: true }),
    (err) => err.code === "INVALID_MCP_INPUT" && /imports\.rename.*args\.from, args\.name, and args\.to/.test(err.message),
  );

  const deleted = runMcpTool("delete_file", { file: workspace.deleteMe, diffMode: "stats" });
  assertMutationContract(deleted, workspace.deleteMe, { changedCount: 1, writtenCount: 0, persisted: false });
  assert.equal(deleted.files[0].change, "deleted");
  assert.equal(existsSync(workspace.deleteMe), true);

  const renamePreview = runMcpTool("rename_file", { file: workspace.renameOld, to: workspace.renameNew, diffMode: "stats" });
  assertMutationContract(renamePreview, undefined, { changedCount: 2, writtenCount: 0, persisted: false });
  assert.equal(existsSync(workspace.renameOld), true);
  assert.equal(existsSync(workspace.renameNew), false);

  const renamed = runMcpTool("rename_file", { file: workspace.renameOld, to: workspace.renameNew, write: true, diffMode: "stats" });
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
  assert.equal(written.next[0], "call apply_dry_run with suggestedActions[0].arguments to apply");
  assert.equal(written.suggestedActions[0].tool, "apply_dry_run");
  assert.match(written.suggestedActions[0].arguments.id, /^dryrun_/);

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
    ...Array.from({ length: 180 }, (_, index) => `  "label-${String(index).padStart(3, "0")}",`),
    "];",
    "",
  ].join("\n"));

  const result = runMcpTool("scan_strings", { file: noisy });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "scan-strings");
  assert.equal(result.strings.$detail, true);
  assert.ok(result.strings.bytes > 4096);
  assert.match(result.strings.summary, /180 items/);
  assert.equal(result.strings.count, 180);
  assert.ok(result.strings.previewCount > 3);
  assert.equal(result.strings.remaining, 180 - result.strings.previewCount);
  assert.deepEqual(result.strings.readNext, {
    tool: "read_detail",
    id: result.strings.id,
    offset: result.strings.previewCount,
    limit: result.strings.previewCount,
  });
  assert.ok(existsSync(result.strings.path));
  assert.equal(result.strings.preview[0].id, "str_1");
  assert.equal(result.strings.preview[0].value, "label-000");

  const search = runMcpTool("search", { query: "label-", path: noisy, maxResults: 10, detailFieldMaxBytes: 4096 });
  assert.equal(Array.isArray(search.results), true);
  assert.equal(search.results.length, 10);
  assert.equal(search.results.$detail, undefined);

  assert.equal(readDetailValue(result.strings, { path: "0.value" }), "label-000");
  const nextPage = runMcpTool("read_detail", { id: result.strings.id, offset: result.strings.previewCount, limit: 2 });
  assert.equal(nextPage.kind, "detail");
  assert.equal(nextPage.offset, result.strings.previewCount);
  assert.equal(nextPage.limit, 2);
  assert.equal(nextPage.count, 2);
  assert.equal(nextPage.total, 180);
  assert.equal(nextPage.hasMore, true);
  assert.equal(nextPage.data[0].value, `label-${String(result.strings.previewCount).padStart(3, "0")}`);
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
  const mutatePage = join(src, "Mutate.tsx");
  const server = join(src, "server.ts");
  const messages = join(src, "messages.ts");
  const notes = join(root, "notes.md");
  const defaultEdit = join(root, "default-edit.txt");
  const multiA = join(root, "multi-a.txt");
  const multiB = join(root, "multi-b.txt");
  const flowText = join(root, "flow.txt");
  const tsDefault = join(src, "ts-default.ts");
  const config = join(root, "config.json");
  const python = join(root, "train.py");
  const generated = join(root, "generated.json");
  const statePage = join(src, "StatePage.tsx");
  const deleteMe = join(root, "delete-me.txt");
  const renameOld = join(root, "old-name.txt");
  const renameNew = join(root, "new-name.txt");
  const verifyPass = join(root, "verify-pass.txt");
  const verifyFail = join(root, "verify-fail.txt");
  const packedHtml = join(root, "packed.html");
  writeFileSync(page, "export function Page() {\n  return <button>삭제</button>;\n}\n");
  writeFileSync(mutatePage, "import { OldName } from \"./old\";\nexport function MutatePage() {\n  return <Button className=\"old\">Hello</Button>;\n}\n");
  writeFileSync(server, "export function startServer() {\n  return \"old\";\n}\n");
  writeFileSync(messages, "export const messages = { label: \"삭제\" };\n");
  writeFileSync(tsDefault, "export function target() {\n  return 1;\n}\n");
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
  writeFileSync(defaultEdit, "old\n");
  writeFileSync(multiA, "old-a\n");
  writeFileSync(multiB, "old-b\n");
  writeFileSync(flowText, "old\n");
  writeFileSync(config, "{\"enabled\":true}\n");
  writeFileSync(deleteMe, "remove me\n");
  writeFileSync(renameOld, "move me\n");
  writeFileSync(verifyPass, "before\n");
  writeFileSync(verifyFail, "before\n");
  writeFileSync(packedHtml, `<!doctype html><html><head><title>Bundled Page</title><style>${".".repeat(30_000)}</style></head><body><div id="app"></div><script>${"x".repeat(30_000)}</script></body></html>`);
  return { root, src, page, mutatePage, server, messages, statePage, python, notes, defaultEdit, multiA, multiB, flowText, tsDefault, config, generated, deleteMe, renameOld, renameNew, verifyPass, verifyFail, packedHtml };
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

function agentPath(value) {
  return value.split("\\").join("/");
}
