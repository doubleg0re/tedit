import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { parse } from "@babel/parser";
import traverseModule, { type NodePath, type TraverseOptions } from "@babel/traverse";
import * as t from "@babel/types";
import { parseVerificationFields, verifyParseForFile } from "./base-edit.js";
import { unifiedDiff } from "./diff.js";
import { fail } from "./errors.js";
import { qualityWarnings } from "./quality.js";
import { maybeWriteBackup, resolveWritePolicy, writePolicyReport, type BackupResult, type WritePolicyFlags } from "./write-policy.js";

const traverseAst = ((traverseModule as unknown as { default?: unknown }).default ?? traverseModule) as (
  parent: t.Node,
  opts: TraverseOptions,
) => void;

type JsonRecord = Record<string, unknown>;
type SymbolKind = "function" | "const" | "let" | "var" | "type" | "interface" | "class" | "enum";
type RefactorOp = MoveSymbolsOperation | ExtractArrayEntriesOperation;

export type TsModuleSymbol = {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  range: { start: number; end: number; line: number; endLine: number; lineRange: string };
  dependsOn: string[];
  usedBy: string[];
  externalImports: string[];
};

export type TsModuleGraph = {
  success: true;
  kind: "ts-symbol-graph";
  file: string;
  symbols: TsModuleSymbol[];
  imports: Array<{ source: string; locals: string[]; importKind?: string }>;
};

export type MoveSymbolsOptions = WritePolicyFlags & {
  from: string;
  to: string;
  symbols: string[];
  closure?: "none" | "helpers" | "ask";
};

export type ExtractArrayEntriesOptions = WritePolicyFlags & {
  file: string;
  array: string;
  to: string;
  exportName: string;
  where?: JsonRecord;
  entries?: string[];
};

export type MoveSymbolsOperation = {
  action: "move_symbols";
  from: string;
  to: string;
  symbols: string[];
  closure?: "none" | "helpers" | "ask";
};

export type ExtractArrayEntriesOperation = {
  action: "extract_array_entries";
  file: string;
  array: string;
  to: string;
  exportName: string;
  where?: JsonRecord;
  entries?: string[];
};

export type ModuleSplitPlanFile = {
  kind: "module-split-plan";
  version: 1;
  created_by: "tedit";
  source: string;
  source_hash: string;
  target: null;
  target_hash: null;
  operations: RefactorOp[];
  steps: Array<{ id: string; kind: "move-symbol" | "edit-file" | "write-file"; risk: "low" | "medium" | "high"; file?: string; symbol?: string; reason?: string }>;
};

export type TsModuleRefactorResult = {
  success: true;
  kind: "move-symbols" | "extract-array-entries" | "module-split";
  changed: boolean;
  written: boolean;
  files: Array<{ file: string; changed: boolean; written: boolean; diff?: string; parse_verified?: boolean; parser?: string; warnings: unknown[]; write_policy: Record<string, unknown> }>;
  moved?: string[];
  extracted?: string[];
  importsAdded: Record<string, string[]>;
  exportsAdded: Record<string, string[]>;
};

export function buildTsModuleGraph(filePath: string): TsModuleGraph {
  const source = readFileSync(filePath, "utf8");
  const model = buildModel(filePath, source);
  const symbols = [...model.symbols.values()].map((symbol) => {
    const dependsOn = [...symbol.refs].filter((name) => model.symbols.has(name) && name !== symbol.name).sort();
    return {
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
      range: publicRange(symbol.range, model.lineStarts),
      dependsOn,
      usedBy: [...model.symbols.values()].filter((candidate) => candidate.refs.has(symbol.name)).map((candidate) => candidate.name).sort(),
      externalImports: [...symbol.refs].filter((name) => model.importsByLocal.has(name)).sort(),
    };
  }).sort((a, b) => a.range.start - b.range.start);
  return {
    success: true,
    kind: "ts-symbol-graph",
    file: filePath,
    symbols,
    imports: model.imports.map((item) => ({ source: item.source, locals: item.specifiers.map((specifier) => specifier.local), ...(item.importKind ? { importKind: item.importKind } : {}) })),
  };
}

export function runMoveSymbols(options: MoveSymbolsOptions): TsModuleRefactorResult {
  return applyMoveSymbols(options, { write: Boolean(options.write) && !options.dryRun, dryRun: Boolean(options.dryRun) || !options.write });
}

export function runExtractArrayEntries(options: ExtractArrayEntriesOptions): TsModuleRefactorResult {
  return applyExtractArrayEntries(options, { write: Boolean(options.write) && !options.dryRun, dryRun: Boolean(options.dryRun) || !options.write });
}

export function buildModuleSplitPlan(sourceFile: string, operations: RefactorOp[]): ModuleSplitPlanFile {
  const source = readFileSync(sourceFile, "utf8");
  return {
    kind: "module-split-plan",
    version: 1,
    created_by: "tedit",
    source: sourceFile,
    source_hash: sha256(source),
    target: null,
    target_hash: null,
    operations,
    steps: operations.flatMap((operation, index) => operationSteps(operation, index)),
  };
}

export function applyModuleSplitPlan(planPath: string, plan: ModuleSplitPlanFile, options: WritePolicyFlags = {}): TsModuleRefactorResult {
  const source = readFileSync(plan.source, "utf8");
  if (sha256(source) !== plan.source_hash) fail("PLAN_STALE_SOURCE", `Plan source changed since it was generated: ${plan.source}.`, { expected: plan.source_hash, actual: sha256(source) });
  const write = Boolean(options.write) && !options.dryRun;
  const results = plan.operations.map((operation) => {
    if (operation.action === "move_symbols") return applyMoveSymbols({ ...operation, ...options }, { write, dryRun: !write });
    return applyExtractArrayEntries({ ...operation, ...options }, { write, dryRun: !write });
  });
  return mergeResults("module-split", results, planPath);
}

function applyMoveSymbols(options: MoveSymbolsOptions, mode: { write: boolean; dryRun: boolean }): TsModuleRefactorResult {
  const source = readFileSync(options.from, "utf8");
  const targetSource = existsSync(options.to) ? readFileSync(options.to, "utf8") : "";
  const model = buildModel(options.from, source);
  const moved = options.symbols.map((name) => requireSymbol(model, name));
  const movedNames = new Set(moved.map((symbol) => symbol.name));
  const referenced = unionRefs(moved);
  const localDeps = [...referenced].filter((name) => model.symbols.has(name) && !movedNames.has(name));
  const importNames = [...referenced].filter((name) => model.importsByLocal.has(name));
  const sourceStillUsesMoved = [...model.symbols.values()].some((symbol) => !movedNames.has(symbol.name) && [...movedNames].some((name) => symbol.refs.has(name)));
  const patches: Patch[] = [];

  for (const symbol of moved) patches.push({ start: expandDeleteStart(source, symbol.range.start), end: expandDeleteEnd(source, symbol.range.end), text: "" });
  for (const name of localDeps) {
    const dep = model.symbols.get(name);
    if (dep && !dep.exported) patches.push({ start: dep.range.start, end: dep.range.start, text: "export " });
  }
  if (sourceStillUsesMoved) patches.push({ start: importInsertOffset(model), end: importInsertOffset(model), text: `import { ${[...movedNames].sort().join(", ")} } from "${moduleSpecifier(options.from, options.to)}";\n` });
  const reExports = moved.filter((symbol) => symbol.exported).map((symbol) => symbol.name);
  if (reExports.length > 0) patches.push({ start: importInsertOffset(model), end: importInsertOffset(model), text: `export { ${reExports.sort().join(", ")} } from "${moduleSpecifier(options.from, options.to)}";\n` });

  const nextSource = applyPatches(source, patches);
  const targetAdd = [
    ...externalImportLines(model, importNames),
    ...(localDeps.length > 0 ? [`import { ${localDeps.sort().join(", ")} } from "${moduleSpecifier(options.to, options.from)}";`] : []),
    "",
    ...moved.map((symbol) => ensureExport(source.slice(symbol.range.start, symbol.range.end))),
  ].join("\n").trimEnd() + "\n";
  const nextTarget = targetSource ? `${targetSource.trimEnd()}\n\n${targetAdd}` : targetAdd;
  return writeResult("move-symbols", [
    fileChange(options.from, source, nextSource, mode),
    fileChange(options.to, targetSource, nextTarget, mode),
  ], { moved: [...movedNames], importsAdded: { [options.to]: [...importNames, ...localDeps], ...(sourceStillUsesMoved ? { [options.from]: [...movedNames] } : {}) }, exportsAdded: { [options.to]: [...movedNames], ...(localDeps.length > 0 ? { [options.from]: localDeps } : {}) } });
}

function applyExtractArrayEntries(options: ExtractArrayEntriesOptions, mode: { write: boolean; dryRun: boolean }): TsModuleRefactorResult {
  const source = readFileSync(options.file, "utf8");
  const targetSource = existsSync(options.to) ? readFileSync(options.to, "utf8") : "";
  const model = buildModel(options.file, source);
  const array = requireSymbol(model, options.array);
  const elements = arrayElements(array.path).filter((element) => t.isObjectExpression(element.node));
  const selected = elements.filter((element) => entryMatches(element.node as t.ObjectExpression, options));
  if (selected.length === 0) fail("NO_ARRAY_ENTRIES", `No entries matched ${options.array}.`);
  assertContiguous(elements, selected);
  const refs = new Set<string>();
  for (const element of selected) collectRefs(element, refs);
  const importNames = [...refs].filter((name) => model.importsByLocal.has(name));
  const localDeps = [...refs].filter((name) => model.symbols.has(name) && name !== options.array);
  const patches: Patch[] = [];
  for (const name of localDeps) {
    const dep = model.symbols.get(name);
    if (dep && !dep.exported) patches.push({ start: dep.range.start, end: dep.range.start, text: "export " });
  }
  patches.push({ start: importInsertOffset(model), end: importInsertOffset(model), text: `import { ${options.exportName} } from "${moduleSpecifier(options.file, options.to)}";\n` });
  patches.push({ start: nodeStart(selected[0].node), end: nodeEnd(selected[selected.length - 1].node), text: `...${options.exportName}` });
  const nextSource = applyPatches(source, patches);
  const entriesSource = selected.map((element) => source.slice(nodeStart(element.node), nodeEnd(element.node))).join(",\n");
  const targetAdd = [
    ...externalImportLines(model, importNames),
    ...(localDeps.length > 0 ? [`import { ${localDeps.sort().join(", ")} } from "${moduleSpecifier(options.to, options.file)}";`] : []),
    "",
    `export const ${options.exportName} = [`,
    indent(entriesSource, "  "),
    `];`,
  ].join("\n").trimEnd() + "\n";
  const nextTarget = targetSource ? `${targetSource.trimEnd()}\n\n${targetAdd}` : targetAdd;
  return writeResult("extract-array-entries", [
    fileChange(options.file, source, nextSource, mode),
    fileChange(options.to, targetSource, nextTarget, mode),
  ], { extracted: entryNames(selected.map((item) => item.node as t.ObjectExpression)), importsAdded: { [options.to]: [...importNames, ...localDeps], [options.file]: [options.exportName] }, exportsAdded: { [options.to]: [options.exportName], ...(localDeps.length > 0 ? { [options.file]: localDeps } : {}) } });
}

type Model = {
  file: string;
  source: string;
  ast: t.File;
  lineStarts: number[];
  imports: ImportInfo[];
  importsByLocal: Map<string, ImportInfo>;
  symbols: Map<string, SymbolInfo>;
};

type SymbolInfo = { name: string; kind: SymbolKind; exported: boolean; range: { start: number; end: number }; refs: Set<string>; path: NodePath<t.Node> };
type ImportInfo = { source: string; importKind?: string; code: string; specifiers: Array<{ local: string; imported?: string; importKind?: string; named: boolean }> };
type Patch = { start: number; end: number; text: string };

type FileChange = ReturnType<typeof fileChange>;

function buildModel(file: string, source: string): Model {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] }) as unknown as t.File;
  const lineStarts = lineStartOffsets(source);
  const symbols = new Map<string, SymbolInfo>();
  const imports: ImportInfo[] = [];
  const importsByLocal = new Map<string, ImportInfo>();
  traverseAst(ast, {
    Program(path) {
      for (const child of path.get("body")) {
        if (child.isImportDeclaration()) {
          const info: ImportInfo = {
            source: String(child.node.source.value),
            importKind: child.node.importKind ?? undefined,
            code: source.slice(nodeStart(child.node), nodeEnd(child.node)),
            specifiers: child.node.specifiers.map((specifier) => ({
              local: specifier.local.name,
              imported: t.isImportSpecifier(specifier) ? importName(specifier.imported) : undefined,
              importKind: t.isImportSpecifier(specifier) ? specifier.importKind ?? undefined : undefined,
              named: t.isImportSpecifier(specifier),
            })),
          };
          imports.push(info);
          for (const specifier of info.specifiers) importsByLocal.set(specifier.local, info);
          continue;
        }
        const exported = child.isExportNamedDeclaration() || child.isExportDefaultDeclaration();
        const declaration = exported && child.isExportNamedDeclaration() ? child.get("declaration") : exported && child.isExportDefaultDeclaration() ? child.get("declaration") : child;
        if (Array.isArray(declaration) || !declaration.node) continue;
        addTopLevelSymbol(source, symbols, declaration as NodePath<t.Node>, exported ? child as NodePath<t.Node> : undefined);
      }
    },
  });
  for (const symbol of symbols.values()) collectRefs(symbol.path, symbol.refs);
  return { file, source, ast, lineStarts, imports, importsByLocal, symbols };
}

function addTopLevelSymbol(source: string, symbols: Map<string, SymbolInfo>, path: NodePath<t.Node>, exportPath?: NodePath<t.Node>): void {
  const rangeNode = exportPath?.node ?? path.node;
  const exported = Boolean(exportPath);
  const push = (name: string, kind: SymbolKind) => symbols.set(name, { name, kind, exported, range: { start: nodeStart(rangeNode), end: nodeEnd(rangeNode) }, refs: new Set(), path });
  if (path.isFunctionDeclaration() && path.node.id) push(path.node.id.name, "function");
  else if (path.isClassDeclaration() && path.node.id) push(path.node.id.name, "class");
  else if (path.isTSTypeAliasDeclaration()) push(path.node.id.name, "type");
  else if (path.isTSInterfaceDeclaration()) push(path.node.id.name, "interface");
  else if (path.isTSEnumDeclaration()) push(path.node.id.name, "enum");
  else if (path.isVariableDeclaration()) {
    for (const declaration of path.node.declarations) if (t.isIdentifier(declaration.id)) push(declaration.id.name, variableKind(path.node.kind));
  }
}

function variableKind(kind: string): SymbolKind {
  return kind === "let" || kind === "var" ? kind : "const";
}

function collectRefs(path: NodePath<t.Node>, refs: Set<string>): void {
  path.traverse({
    Identifier(identifierPath) {
      if (identifierPath.isReferencedIdentifier()) refs.add(identifierPath.node.name);
    },
    TSTypeReference(typePath) {
      const name = typePath.node.typeName;
      if (t.isIdentifier(name)) refs.add(name.name);
    },
  });
}

function requireSymbol(model: Model, name: string): SymbolInfo {
  const symbol = model.symbols.get(name);
  if (!symbol) fail("SYMBOL_NOT_FOUND", `No top-level symbol named ${name} in ${model.file}.`, { available: [...model.symbols.keys()].sort() });
  return symbol;
}

function arrayElements(path: NodePath<t.Node>): NodePath<t.Node>[] {
  const node = path.node;
  if (!t.isVariableDeclaration(node)) fail("NOT_ARRAY_REGISTRY", "Array extraction requires a top-level const/let/var array.");
  const declarator = node.declarations[0];
  if (!declarator || !t.isArrayExpression(declarator.init)) fail("NOT_ARRAY_REGISTRY", "Selected symbol is not initialized to an array.");
  const initPath = path.get("declarations.0.init") as NodePath<t.ArrayExpression>;
  return initPath.get("elements").filter((element) => !Array.isArray(element) && Boolean(element.node)) as unknown as NodePath<t.Node>[];
}

function entryMatches(node: t.ObjectExpression, options: ExtractArrayEntriesOptions): boolean {
  const name = literalProp(node, "name");
  if (options.entries && typeof name === "string" && options.entries.includes(name)) return true;
  if (!options.where) return false;
  return Object.entries(options.where).every(([key, value]) => literalProp(node, key) === value);
}

function literalProp(node: t.ObjectExpression, key: string): unknown {
  for (const prop of node.properties) {
    if (!t.isObjectProperty(prop)) continue;
    const propKey = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : undefined;
    if (propKey !== key) continue;
    const value = prop.value;
    if (t.isStringLiteral(value) || t.isBooleanLiteral(value) || t.isNumericLiteral(value)) return value.value;
  }
  return undefined;
}

function assertContiguous(all: NodePath<t.Node>[], selected: NodePath<t.Node>[]): void {
  const indexes = selected.map((item) => all.indexOf(item)).sort((a, b) => a - b);
  for (let index = 1; index < indexes.length; index++) if (indexes[index] !== indexes[index - 1] + 1) fail("NON_CONTIGUOUS_ARRAY_ENTRIES", "extract_array_entries currently requires matched entries to be contiguous.");
}

function externalImportLines(model: Model, names: string[]): string[] {
  const grouped = new Map<ImportInfo, string[]>();
  for (const name of names) {
    const info = model.importsByLocal.get(name);
    if (!info) continue;
    const group = grouped.get(info) ?? [];
    group.push(name);
    grouped.set(info, group);
  }
  return [...grouped.entries()].flatMap(([info, locals]) => {
    if (locals.length === info.specifiers.length) return [info.code];
    const selected = locals.map((local) => info.specifiers.find((specifier) => specifier.local === local)).filter((specifier): specifier is ImportInfo["specifiers"][number] => Boolean(specifier));
    if (selected.some((specifier) => !specifier.named)) return [info.code];
    const typeOnly = selected.filter((specifier) => info.importKind === "type" || specifier.importKind === "type");
    const values = selected.filter((specifier) => info.importKind !== "type" && specifier.importKind !== "type");
    return [
      ...(values.length > 0 ? [`import { ${values.map(importClause).sort().join(", ")} } from "${info.source}";`] : []),
      ...(typeOnly.length > 0 ? [`import type { ${typeOnly.map(importClause).sort().join(", ")} } from "${info.source}";`] : []),
    ];
  });
}

function importClause(specifier: ImportInfo["specifiers"][number]): string {
  if (!specifier.imported || specifier.imported === specifier.local) return specifier.local;
  return `${specifier.imported} as ${specifier.local}`;
}

function importName(node: t.Identifier | t.StringLiteral): string {
  return t.isIdentifier(node) ? node.name : node.value;
}

function fileChange(file: string, before: string, after: string, mode: { write: boolean; dryRun: boolean }) {
  const changed = before !== after;
  const verification = verifyParseForFile(file, after);
  const policy = resolveWritePolicy(file, { write: mode.write, dryRun: mode.dryRun });
  let backup: BackupResult = {};
  if (policy.write && changed) {
    backup = maybeWriteBackup(file, before, policy, changed, after);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, after);
  }
  return {
    file,
    changed,
    written: policy.write && changed,
    before,
    after,
    ...parseVerificationFields(verification),
    warnings: qualityWarnings(file, before, after),
    write_policy: writePolicyReport(policy, backup),
    ...(unifiedDiff(before, after, file) ? { diff: unifiedDiff(before, after, file) } : {}),
  };
}

function writeResult(kind: TsModuleRefactorResult["kind"], changes: FileChange[], extra: Partial<TsModuleRefactorResult>): TsModuleRefactorResult {
  return {
    success: true,
    kind,
    changed: changes.some((change) => change.changed),
    written: changes.some((change) => change.written),
    files: changes.map(({ before: _before, after: _after, ...change }) => change),
    importsAdded: extra.importsAdded ?? {},
    exportsAdded: extra.exportsAdded ?? {},
    ...(extra.moved ? { moved: extra.moved } : {}),
    ...(extra.extracted ? { extracted: extra.extracted } : {}),
  };
}

function mergeResults(kind: "module-split", results: TsModuleRefactorResult[], planPath: string): TsModuleRefactorResult {
  return {
    success: true,
    kind,
    changed: results.some((result) => result.changed),
    written: results.some((result) => result.written),
    files: results.flatMap((result) => result.files),
    importsAdded: Object.assign({}, ...results.map((result) => result.importsAdded)),
    exportsAdded: Object.assign({}, ...results.map((result) => result.exportsAdded)),
    extracted: [planPath],
  };
}

function unionRefs(symbols: SymbolInfo[]): Set<string> {
  const refs = new Set<string>();
  for (const symbol of symbols) for (const ref of symbol.refs) refs.add(ref);
  return refs;
}

function applyPatches(source: string, patches: Patch[]): string {
  return [...patches].sort((a, b) => b.start - a.start || b.end - a.end).reduce((text, patch) => text.slice(0, patch.start) + patch.text + text.slice(patch.end), source);
}

function ensureExport(code: string): string {
  return /^\s*export\b/.test(code) ? code.trim() : `export ${code.trim()}`;
}

function importInsertOffset(model: Model): number {
  return model.imports.length > 0 ? nodeEnd((model.ast.program.body.filter((node) => t.isImportDeclaration(node)).at(-1) as t.ImportDeclaration)) + newlineAfter(model.source, nodeEnd((model.ast.program.body.filter((node) => t.isImportDeclaration(node)).at(-1) as t.ImportDeclaration))) : 0;
}

function newlineAfter(source: string, offset: number): number {
  return source[offset] === "\r" && source[offset + 1] === "\n" ? 2 : source[offset] === "\n" ? 1 : 0;
}

function moduleSpecifier(fromFile: string, toFile: string): string {
  let spec = relative(dirname(fromFile), toFile).replace(/\\/g, "/").replace(/\.[cm]?[jt]sx?$/, ".js");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  return spec;
}

function publicRange(range: { start: number; end: number }, lineStarts: number[]): TsModuleSymbol["range"] {
  const start = loc(range.start, lineStarts).line;
  const end = loc(Math.max(range.start, range.end - 1), lineStarts).line;
  return { start: range.start, end: range.end, line: start, endLine: end, lineRange: start === end ? String(start) : `${start}:${end}` };
}

function loc(offset: number, lineStarts: number[]): { line: number } {
  let line = 1;
  for (let index = 0; index < lineStarts.length; index++) if (lineStarts[index] <= offset) line = index + 1;
  return { line };
}

function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === "\n") starts.push(index + 1);
  return starts;
}

function nodeStart(node: t.Node): number {
  if (typeof node.start !== "number") fail("TS_RANGE_UNAVAILABLE", "AST node does not have a start offset.");
  return node.start;
}

function nodeEnd(node: t.Node): number {
  if (typeof node.end !== "number") fail("TS_RANGE_UNAVAILABLE", "AST node does not have an end offset.");
  return node.end;
}

function expandDeleteStart(source: string, start: number): number {
  let cursor = start;
  while (cursor > 0 && source[cursor - 1] !== "\n") cursor--;
  return cursor;
}

function expandDeleteEnd(source: string, end: number): number {
  let cursor = end;
  while (cursor < source.length && (source[cursor] === "\r" || source[cursor] === "\n")) cursor++;
  return cursor;
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((line) => line ? prefix + line : line).join("\n");
}

function entryNames(entries: t.ObjectExpression[]): string[] {
  return entries.map((entry) => literalProp(entry, "name")).filter((name): name is string => typeof name === "string");
}

function operationSteps(operation: RefactorOp, index: number): ModuleSplitPlanFile["steps"] {
  if (operation.action === "move_symbols") return operation.symbols.map((symbol) => ({ id: `move-${index}-${symbol}`, kind: "move-symbol", risk: "medium", file: operation.from, symbol, reason: `move ${symbol} to ${operation.to}` }));
  return [{ id: `extract-array-${index}-${operation.exportName}`, kind: "edit-file", risk: "medium", file: operation.file, symbol: operation.array, reason: `extract ${operation.array} entries to ${operation.to}` }];
}

function sha256(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}
