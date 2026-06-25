import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runMcpTool } from "../dist/mcp-tools.js";
import { applyRefactorPlan } from "../dist/refactor-plan.js";
import { buildModuleSplitPlan, buildTsModuleGraph, runExtractArrayEntries, runMoveSymbols } from "../dist/ts-module-refactor.js";

function workspace(name) {
  return mkdtempSync(join(tmpdir(), name));
}

function sourceFixture() {
  return [
    "import { parse } from \"./parser.js\";",
    "",
    "const LOCAL_PREFIX = \"tool\";",
    "",
    "export type TeditMcpTool = { name: string; category: \"edit\" | \"discover\"; handler: () => string };",
    "",
    "export function runEditTool() {",
    "  return parse(LOCAL_PREFIX + \":edit\");",
    "}",
    "",
    "function runPatchTool() {",
    "  return parse(LOCAL_PREFIX + \":patch\");",
    "}",
    "",
    "function runSearchTextTool() {",
    "  return parse(LOCAL_PREFIX + \":search\");",
    "}",
    "",
    "export const TEDIT_MCP_ALL_TOOLS: readonly TeditMcpTool[] = [",
    "  { name: \"edit\", category: \"edit\", handler: runEditTool },",
    "  { name: \"patch\", category: \"edit\", handler: runPatchTool },",
    "  { name: \"search_text\", category: \"discover\", handler: runSearchTextTool },",
    "];",
    "",
  ].join("\n");
}

test("TS module graph tracks top-level symbols, local deps, and external imports", () => {
  const dir = workspace("tedit-ts-graph-");
  const file = join(dir, "mcp-tools.ts");
  writeFileSync(file, sourceFixture());

  const graph = buildTsModuleGraph(file);
  assert.equal(graph.success, true);
  assert.equal(graph.kind, "ts-symbol-graph");
  const editTool = graph.symbols.find((symbol) => symbol.name === "runEditTool");
  assert.ok(editTool);
  assert.deepEqual(editTool.dependsOn, ["LOCAL_PREFIX"]);
  assert.deepEqual(editTool.externalImports, ["parse"]);
  const registry = graph.symbols.find((symbol) => symbol.name === "TEDIT_MCP_ALL_TOOLS");
  assert.ok(registry.dependsOn.includes("runEditTool"));
  assert.ok(registry.dependsOn.includes("runPatchTool"));
  const toolRegistry = graph.registries.find((item) => item.name === "TEDIT_MCP_ALL_TOOLS");
  assert.deepEqual(toolRegistry.entries.map((entry) => entry.name), ["edit", "patch", "search_text"]);
  assert.deepEqual(toolRegistry.entries[0].dependsOn, ["runEditTool"]);
  assert.deepEqual(graph.suggestedActions[0].input, {
    file,
    array: "TEDIT_MCP_ALL_TOOLS",
    to: join(dir, "mcp-edit-tools.ts"),
    exportName: "EDIT_TOOLS",
    entries: ["edit", "patch"],
    write: false,
  });
});

test("move_symbols preserves mixed value/type imports on partial import repair", () => {
  const dir = workspace("tedit-ts-mixed-imports-");
  const from = join(dir, "source.ts");
  const to = join(dir, "target.ts");
  writeFileSync(from, [
    "import { parseValue, unusedParser, type ToolSpec } from \"./parser.js\";",
    "",
    "export function makeTool(input: ToolSpec) {",
    "  return parseValue(input.name);",
    "}",
    "",
  ].join("\n"));

  const result = runMoveSymbols({ from, to, symbols: ["makeTool"], dryRun: true, noBackup: true });
  const targetDiff = result.files.find((file) => file.file === to).diff;
  assert.match(targetDiff, /import \{ parseValue \} from "\.\/parser\.js"/);
  assert.match(targetDiff, /import type \{ ToolSpec \} from "\.\/parser\.js"/);
});

test("move_symbols dry-run splits a top-level symbol with import/export repair", () => {
  const dir = workspace("tedit-ts-move-symbols-");
  const from = join(dir, "mcp-tools.ts");
  const to = join(dir, "mcp-edit-tools.ts");
  writeFileSync(from, sourceFixture());

  const result = runMoveSymbols({ from, to, symbols: ["runEditTool"], dryRun: true, noBackup: true });
  assert.equal(result.changed, true);
  assert.equal(result.written, false);
  assert.equal(existsSync(to), false);
  assert.match(result.files.find((file) => file.file === to).diff, /export function runEditTool/);
  assert.match(result.files.find((file) => file.file === to).diff, /import \{ LOCAL_PREFIX \} from "\.\/mcp-tools\.js"/);
  assert.match(result.files.find((file) => file.file === from).diff, /export const LOCAL_PREFIX/);
  assert.equal(readFileSync(from, "utf8"), sourceFixture());
});

test("extract_array_entries writes contiguous registry entries into a new module", () => {
  const dir = workspace("tedit-ts-extract-array-");
  const file = join(dir, "mcp-tools.ts");
  const to = join(dir, "mcp-edit-tools.ts");
  writeFileSync(file, sourceFixture());

  const result = runExtractArrayEntries({
    file,
    array: "TEDIT_MCP_ALL_TOOLS",
    to,
    exportName: "EDIT_TOOLS",
    where: { category: "edit" },
    write: true,
    noBackup: true,
  });
  assert.equal(result.changed, true);
  assert.equal(result.written, true);
  assert.match(readFileSync(file, "utf8"), /import \{ makeEDIT_TOOLS \} from "\.\/mcp-edit-tools\.js"/);
  assert.match(readFileSync(file, "utf8"), /\.\.\.makeEDIT_TOOLS\(\{ runEditTool, runPatchTool \}\)/);
  assert.match(readFileSync(to, "utf8"), /import type \{ TeditMcpTool \} from "\.\/mcp-tools\.js"/);
  assert.match(readFileSync(to, "utf8"), /export function makeEDIT_TOOLS/);
  assert.match(readFileSync(to, "utf8"), /name: "edit"/);
  assert.match(readFileSync(to, "utf8"), /satisfies readonly TeditMcpTool\[\]/);
  assert.doesNotMatch(readFileSync(to, "utf8"), /import \{ runEditTool, runPatchTool \} from "\.\/mcp-tools\.js"/);
});

test("extract_array_entries lets explicit entries override broad where filters", () => {
  const dir = workspace("tedit-ts-extract-entries-precedence-");
  const file = join(dir, "mcp-tools.ts");
  const to = join(dir, "mcp-edit-tools.ts");
  writeFileSync(file, sourceFixture());

  const result = runExtractArrayEntries({
    file,
    array: "TEDIT_MCP_ALL_TOOLS",
    to,
    exportName: "EDIT_TOOLS",
    entries: ["edit", "patch"],
    where: { category: "discover" },
    write: true,
    noBackup: true,
  });
  assert.equal(result.changed, true);
  assert.match(readFileSync(file, "utf8"), /\.\.\.makeEDIT_TOOLS\(\{ runEditTool, runPatchTool \}\)/);
  assert.match(readFileSync(to, "utf8"), /name: "edit"/);
  assert.match(readFileSync(to, "utf8"), /name: "patch"/);
  assert.doesNotMatch(readFileSync(to, "utf8"), /search_text/);
});

test("module-split plans round-trip through apply_plan and MCP refactor facade", () => {
  const dir = workspace("tedit-ts-module-plan-");
  const from = join(dir, "mcp-tools.ts");
  const to = join(dir, "mcp-edit-tools.ts");
  const planPath = join(dir, "module-split.plan.json");
  writeFileSync(from, sourceFixture());

  const plan = buildModuleSplitPlan(from, [{ action: "move_symbols", from, to, symbols: ["runEditTool"] }]);
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const dryRun = applyRefactorPlan(planPath, { dryRun: true, noBackup: true });
  assert.equal(dryRun.kind, "module-split");
  assert.equal(dryRun.changed, true);

  const created = runMcpTool("refactor", {
    kind: "module_split_plan",
    file: from,
    planOut: join(dir, "created.plan.json"),
    operations: [{ action: "move_symbols", from, to, symbols: ["runEditTool"] }],
    output: "detailed",
  });
  assert.equal(created.success, true);
  assert.equal(created.kind, "module-split-plan");

  const graph = runMcpTool("refactor", { kind: "symbol_graph", file: from, output: "detailed" });
  assert.equal(graph.success, true);
  assert.ok(graph.symbols.some((symbol) => symbol.name === "TEDIT_MCP_ALL_TOOLS"));
});

test("move_symbols verify rollback restores source and removes new target", () => {
  const dir = workspace("tedit-ts-move-rollback-");
  const from = join(dir, "mcp-tools.ts");
  const to = join(dir, "mcp-edit-tools.ts");
  const original = sourceFixture();
  writeFileSync(from, original);

  const result = runMcpTool("refactor", {
    kind: "move_symbols",
    from,
    to,
    symbols: ["runEditTool"],
    write: true,
    noBackup: true,
    verify: { cmd: [process.execPath, "-e", "process.exit(7)"], rollbackOnFail: true },
    output: "detailed",
  });

  assert.equal(result.success, true);
  assert.equal(result.verify.passed, false);
  assert.equal(result.verify.exitCode, 7);
  assert.equal(result.verify.rollback.attempted, true);
  assert.equal(readFileSync(from, "utf8"), original);
  assert.equal(existsSync(to), false);
});
