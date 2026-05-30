import { readFileSync, writeFileSync } from "node:fs";
import { parseVerificationFields, verifyParseForFile } from "./base-edit.js";
import { unifiedDiff } from "./diff.js";
import { fail } from "./errors.js";
import { qualityWarnings } from "./quality.js";
import { maybeWriteBackup, resolveWritePolicy, writePolicyReport, type BackupResult, type WritePolicyFlags } from "./write-policy.js";
import traverseModule, { type NodePath, type TraverseOptions } from "@babel/traverse";
import * as t from "@babel/types";
import * as recast from "recast";
import babelTsParser from "recast/parsers/babel-ts.js";

const traverseAst = ((traverseModule as unknown as { default?: unknown }).default ?? traverseModule) as (
  parent: t.Node,
  opts: TraverseOptions,
) => void;

type JsonRecord = Record<string, unknown>;
type Range = {
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  lineRange: string;
};

type AstFilter = {
  path: string[];
  op: "exists" | "eq" | "contains";
  value?: string;
};

type AstSelectorPart = {
  type?: string;
  filters: AstFilter[];
};

export type AstStringCandidate = {
  id: string;
  kind: "jsx_text" | "jsx_attribute" | "string_literal" | "template_literal";
  file: string;
  value: string;
  raw: string;
  range: Range;
  context: string;
  parent?: string;
  attr?: string;
  editable: boolean;
  excluded?: boolean;
  excludeReason?: string;
  preview: string;
  suggested: JsonRecord;
};

export type AstNodeMatch = {
  id: string;
  type: string;
  file: string;
  range: Range;
  value?: unknown;
  name?: string;
  context: string;
  editable: boolean;
  preview: string;
};

type ParsedAstSource = {
  ast: t.File;
  lineStarts: number[];
};

type ScanStringsOptions = {
  contains?: string;
  includeExcluded?: boolean;
  minLength?: number;
};

type AstEditOptions = WritePolicyFlags & {
  selector: string;
  replace: string;
};

type EditablePatch = {
  start: number;
  end: number;
  text: string;
};

export function runScanStrings(filePath: string, options: ScanStringsOptions = {}): JsonRecord {
  const source = readFileSync(filePath, "utf8");
  const parsed = parseAstSource(source);
  const all = scanStringCandidates(filePath, source, parsed, options);
  const selected = options.includeExcluded ? all : all.filter((candidate) => !candidate.excluded);
  const strings = selected.map((candidate, index) => ({ ...candidate, id: `str_${index + 1}` }));
  return {
    success: true,
    kind: "scan-strings",
    file: filePath,
    strings,
    count: strings.length,
    excludedCount: all.filter((candidate) => candidate.excluded).length,
  };
}

export function runAstSelect(filePath: string, selector: string): JsonRecord {
  const source = readFileSync(filePath, "utf8");
  const parsed = parseAstSource(source);
  const matches = selectAstNodes(filePath, source, parsed, selector);
  return {
    success: true,
    kind: "ast-select",
    file: filePath,
    selector,
    matches,
    count: matches.length,
  };
}

export function runAstEdit(filePath: string, options: AstEditOptions): JsonRecord {
  if (options.write && options.dryRun) fail("INVALID_AST_EDIT", "Use only one of write or dryRun.");
  const source = readFileSync(filePath, "utf8");
  const parsed = parseAstSource(source);
  const selector = options.selector;
  const paths = selectAstPaths(parsed.ast, selector);
  if (paths.length === 0) {
    const candidateHints = astRetryCandidates(filePath, source, parsed, selector);
    fail("AST_MATCH_NONE", `No AST node matched "${selector}".`, {
      selector,
      ...(candidateHints.length > 0 ? { candidates: candidateHints } : {}),
      next: [
        ...(candidateHints[0]?.suggested?.selector ? [`Try selector ${JSON.stringify(String(candidateHints[0].suggested.selector))}.`] : []),
        "Run tedit ast-select with the same selector to inspect matches.",
        "Use tedit scan-strings to locate string candidates first.",
      ].slice(0, 3),
    });
  }
  if (paths.length > 1) {
    fail("AST_MATCH_NOT_UNIQUE", `AST selector matched ${paths.length} nodes; ast-edit requires exactly one.`, {
      selector,
      matches: paths.slice(0, 10).map((path, index) => astMatchForPath(`ast_${index + 1}`, filePath, source, parsed, path)),
      next: [
        "Narrow the selector until ast-select returns one editable node.",
        "Add a [value=...] or [value*=...] filter when replacing string targets.",
      ],
    });
  }

  const match = astMatchForPath("ast_1", filePath, source, parsed, paths[0]);
  const patch = editablePatchForPath(paths[0], source, options.replace);
  if (!patch) {
    fail("AST_EDIT_UNSUPPORTED_NODE", `AST selector matched ${match.type}, which ast-edit cannot safely replace yet.`, {
      selector,
      match,
      supported: ["StringLiteral", "JSXText", "JSXAttribute with a string value", "ObjectProperty with a string value", "TemplateLiteral without expressions"],
      next: [
        "Select an editable child string node, for example CallExpression[...] > StringLiteral.",
        "Run scan-strings to find editable string candidates first.",
      ],
    });
  }

  const nextSource = applySinglePatch(source, patch);
  const changed = source !== nextSource;
  const diff = unifiedDiff(source, nextSource, filePath);
  const parseVerification = verifyParseForFile(filePath, nextSource);
  const warnings = qualityWarnings(filePath, source, nextSource);
  const policy = resolveWritePolicy(filePath, options);
  const shouldWrite = policy.write;
  let backup: BackupResult = {};
  if (shouldWrite && changed) {
    backup = maybeWriteBackup(filePath, source, policy, changed, nextSource);
    writeFileSync(filePath, nextSource);
  }

  return {
    success: true,
    file: filePath,
    selector,
    match,
    changed,
    written: shouldWrite && changed,
    ...parseVerificationFields(parseVerification),
    warnings,
    write_policy: writePolicyReport(policy, backup),
    ...(backup.path ? { backup: backup.path } : {}),
    ...(diff ? { diff } : {}),
  };
}

function scanStringCandidates(filePath: string, source: string, parsed: ParsedAstSource, options: ScanStringsOptions): AstStringCandidate[] {
  const candidates: AstStringCandidate[] = [];
  const minLength = options.minLength ?? 1;
  const contains = options.contains;

  traverseAst(parsed.ast, {
    JSXText(path) {
      const value = normalizeJsxText(path.node.value);
      if (value.length < minLength) return;
      if (contains && !value.includes(contains)) return;
      const range = jsxTextValueRange(path.node, source, parsed.lineStarts);
      addCandidate(candidates, {
        kind: "jsx_text",
        file: filePath,
        value,
        raw: source.slice(range.start, range.end),
        range,
        context: "jsx_text",
        editable: true,
        preview: preview(source, range.start, range.end),
        suggested: { tool: "ast_edit", selector: `JSXText[value*="${escapeSelectorValue(value)}"]`, replace: "<text>" },
      }, options);
    },
    StringLiteral(path) {
      const kind = path.parentPath?.isJSXAttribute() ? "jsx_attribute" : "string_literal";
      const attr = path.parentPath?.isJSXAttribute() ? jsxName(path.parentPath.node.name) : undefined;
      const value = path.node.value;
      if (value.length < minLength) return;
      if (contains && !value.includes(contains)) return;
      const range = nodeRange(path.node, parsed.lineStarts);
      const context = stringContext(path);
      addCandidate(candidates, {
        kind,
        file: filePath,
        value,
        raw: source.slice(path.node.start ?? range.start, path.node.end ?? range.end),
        range,
        context,
        ...(attr ? { attr } : {}),
        ...parentLabel(path),
        editable: true,
        preview: preview(source, range.start, range.end),
        suggested: { tool: "ast_edit", selector: selectorHintForString(path), replace: "<text>" },
      }, options);
    },
    TemplateLiteral(path) {
      if (path.node.quasis.length !== 1) return;
      const value = path.node.quasis[0]?.value.cooked ?? path.node.quasis[0]?.value.raw ?? "";
      if (value.length < minLength) return;
      if (contains && !value.includes(contains)) return;
      const range = nodeRange(path.node, parsed.lineStarts);
      addCandidate(candidates, {
        kind: "template_literal",
        file: filePath,
        value,
        raw: source.slice(path.node.start ?? range.start, path.node.end ?? range.end),
        range,
        context: stringContext(path),
        ...parentLabel(path),
        editable: true,
        preview: preview(source, range.start, range.end),
        suggested: { tool: "ast_edit", selector: "TemplateLiteral", replace: "<text>" },
      }, options);
    },
  });

  return candidates.map((candidate, index) => ({ ...candidate, id: `str_${index + 1}` }));
}

function addCandidate(candidates: Omit<AstStringCandidate, "id">[], candidate: Omit<AstStringCandidate, "id">, options: ScanStringsOptions): void {
  const reason = exclusionReason(candidate);
  if (reason && !options.includeExcluded) {
    candidates.push({ ...candidate, excluded: true, excludeReason: reason });
    return;
  }
  candidates.push(reason ? { ...candidate, excluded: true, excludeReason: reason } : candidate);
}

function exclusionReason(candidate: Omit<AstStringCandidate, "id">): string | undefined {
  const value = candidate.value.trim();
  if (!value) return "empty";
  if (candidate.attr && TECHNICAL_JSX_ATTRS.has(candidate.attr)) return "technical_jsx_attribute";
  if (candidate.context === "import_source" || candidate.context === "export_source") return "module_source";
  if (candidate.context === "object_key") return "object_key";
  if (candidate.context === "type_literal") return "type_literal";
  if (looksLikeUrl(value)) return "url";
  if (looksLikePath(value)) return "path";
  return undefined;
}

function selectAstNodes(filePath: string, source: string, parsed: ParsedAstSource, selector: string): AstNodeMatch[] {
  return selectAstPaths(parsed.ast, selector).map((path, index) => astMatchForPath(`ast_${index + 1}`, filePath, source, parsed, path));
}

function selectAstPaths(ast: t.File, selector: string): NodePath<t.Node>[] {
  const parts = parseAstSelector(selector);
  const matches: NodePath<t.Node>[] = [];
  traverseAst(ast, {
    enter(path) {
      if (matchesAstSelector(path as NodePath<t.Node>, parts)) matches.push(path as NodePath<t.Node>);
    },
  });
  return matches;
}

function parseAstSelector(selector: string): AstSelectorPart[] {
  const parts = splitTopLevel(selector, ">").map((part) => parseAstSelectorPart(part.trim()));
  if (parts.length === 0 || parts.some((part) => !part.type && part.filters.length === 0)) fail("INVALID_AST_SELECTOR", "AST selector cannot be empty.");
  return parts;
}

function parseAstSelectorPart(input: string): AstSelectorPart {
  if (!input) fail("INVALID_AST_SELECTOR", "AST selector part cannot be empty.");
  const typeMatch = input.match(/^([A-Za-z_$][\w$]*|\*)?/);
  const rawType = typeMatch?.[0] ?? "";
  let rest = input.slice(rawType.length);
  const filters: AstFilter[] = [];
  while (rest.length > 0) {
    if (!rest.startsWith("[")) fail("INVALID_AST_SELECTOR", `Unsupported AST selector syntax: ${input}`);
    const close = findBalancedClose(rest, 0, "[", "]");
    filters.push(parseAstFilter(rest.slice(1, close)));
    rest = rest.slice(close + 1);
  }
  return { ...(rawType && rawType !== "*" ? { type: rawType } : {}), filters };
}

function parseAstFilter(input: string): AstFilter {
  const match = input.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:(\*=|=)(?:(["'])(.*?)\3|([^\]]+)))?$/);
  if (!match) fail("INVALID_AST_SELECTOR", `Unsupported AST selector filter: [${input}]`);
  const [, path, op, , quoted, unquoted] = match;
  if (!op) return { path: path.split("."), op: "exists" };
  return {
    path: path.split("."),
    op: op === "*=" ? "contains" : "eq",
    value: quoted ?? unquoted ?? "",
  };
}

function matchesAstSelector(path: NodePath<t.Node>, parts: AstSelectorPart[]): boolean {
  let cursor: NodePath<t.Node> | null = path;
  for (let index = parts.length - 1; index >= 0; index--) {
    if (!cursor || !matchesAstSelectorPart(cursor.node, parts[index])) return false;
    cursor = index > 0 ? cursor.parentPath as NodePath<t.Node> | null : cursor;
  }
  return true;
}

function matchesAstSelectorPart(node: t.Node, part: AstSelectorPart): boolean {
  if (part.type && node.type !== part.type) return false;
  for (const filter of part.filters) {
    const value = comparableValue(readPath(node as unknown as JsonRecord, filter.path));
    if (filter.op === "exists") {
      if (value === undefined) return false;
    } else if (filter.op === "eq") {
      if (String(value) !== filter.value) return false;
    } else if (filter.op === "contains") {
      if (value === undefined || !String(value).includes(filter.value ?? "")) return false;
    }
  }
  return true;
}

function astMatchForPath(id: string, filePath: string, source: string, parsed: ParsedAstSource, path: NodePath<t.Node>): AstNodeMatch {
  const node = path.node;
  const range = nodeRange(node, parsed.lineStarts);
  const value = nodeValue(node);
  return {
    id,
    type: node.type,
    file: filePath,
    range,
    ...(value === undefined ? {} : { value }),
    ...nodeName(node),
    context: astContext(path),
    editable: editablePatchForPath(path, source, "<text>") !== null,
    preview: preview(source, range.start, range.end),
  };
}

function editablePatchForPath(path: NodePath<t.Node>, source: string, replacement: string): EditablePatch | null {
  const node = path.node;
  if (t.isJSXAttribute(node) && t.isStringLiteral(node.value)) {
    return nodePatch(node.value, quoteString(replacement, quoteAt(source, node.value.start)));
  }
  if (t.isObjectProperty(node) && t.isStringLiteral(node.value)) {
    return nodePatch(node.value, quoteString(replacement, quoteAt(source, node.value.start)));
  }
  if (t.isStringLiteral(node)) return nodePatch(node, quoteString(replacement, quoteAt(source, node.start)));
  if (t.isJSXText(node)) {
    const trimmed = trimmedTextOffsets(node.value);
    const start = (node.start ?? 0) + trimmed.leading;
    const end = (node.end ?? start) - trimmed.trailing;
    return { start, end, text: replacement };
  }
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return nodePatch(node, quoteTemplate(replacement));
  }
  return null;
}

function nodePatch(node: t.Node, text: string): EditablePatch {
  if (typeof node.start !== "number" || typeof node.end !== "number") fail("AST_RANGE_UNAVAILABLE", "AST node does not have source offsets.");
  return { start: node.start, end: node.end, text };
}

function applySinglePatch(source: string, patch: EditablePatch): string {
  return source.slice(0, patch.start) + patch.text + source.slice(patch.end);
}

function parseAstSource(source: string): ParsedAstSource {
  return {
    ast: recast.parse(source, { parser: babelTsParser }) as unknown as t.File,
    lineStarts: lineStarts(source),
  };
}

function nodeRange(node: t.Node, lineStartOffsets: number[]): Range {
  if (typeof node.start !== "number" || typeof node.end !== "number") fail("AST_RANGE_UNAVAILABLE", "AST node does not have source offsets.");
  return rangeForOffsets(node.start, node.end, lineStartOffsets);
}

function jsxTextValueRange(node: t.JSXText, source: string, lineStartOffsets: number[]): Range {
  const trimmed = trimmedTextOffsets(node.value);
  const start = (node.start ?? 0) + trimmed.leading;
  const end = (node.end ?? start) - trimmed.trailing;
  return rangeForOffsets(start, end, lineStartOffsets);
}

function rangeForOffsets(start: number, end: number, lineStartOffsets: number[]): Range {
  const loc = offsetLoc(start, lineStartOffsets);
  const endLoc = offsetLoc(end, lineStartOffsets);
  return {
    start,
    end,
    line: loc.line,
    column: loc.column,
    endLine: endLoc.line,
    endColumn: endLoc.column,
    lineRange: loc.line === endLoc.line ? String(loc.line) : `${loc.line}:${endLoc.line}`,
  };
}

function offsetLoc(offset: number, lineStartOffsets: number[]): { line: number; column: number } {
  let low = 0;
  let high = lineStartOffsets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStartOffsets[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  const index = Math.max(0, high);
  return { line: index + 1, column: offset - lineStartOffsets[index] };
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function trimmedTextOffsets(value: string): { leading: number; trailing: number } {
  const leading = value.match(/^\s*/)?.[0].length ?? 0;
  const trailing = value.match(/\s*$/)?.[0].length ?? 0;
  return { leading, trailing };
}

function normalizeJsxText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stringContext(path: NodePath<t.Node>): string {
  const parent = path.parentPath;
  if (!parent) return "unknown";
  if (parent.isJSXAttribute()) return "jsx_attribute";
  if (parent.isImportDeclaration()) return "import_source";
  if (parent.isExportNamedDeclaration() || parent.isExportAllDeclaration()) return "export_source";
  if (parent.isObjectProperty() && parent.node.key === path.node) return "object_key";
  if (parent.isObjectProperty() && parent.node.value === path.node) return "object_value";
  if (parent.isCallExpression()) return "call_argument";
  if (parent.isVariableDeclarator()) return "variable_initializer";
  if (parent.isTSLiteralType()) return "type_literal";
  return parent.node.type;
}

function astContext(path: NodePath<t.Node>): string {
  return path.parentPath?.node.type ?? "root";
}

function parentLabel(path: NodePath<t.Node>): { parent?: string } {
  const parent = path.parentPath;
  if (!parent) return {};
  if (parent.isObjectProperty()) return { parent: propertyKeyName(parent.node.key) };
  if (parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) return { parent: parent.node.id.name };
  if (parent.isCallExpression()) return { parent: calleeName(parent.node.callee) };
  return {};
}

function selectorHintForString(path: NodePath<t.StringLiteral>): string {
  const parent = path.parentPath;
  if (parent?.isJSXAttribute()) return `JSXAttribute[name="${jsxName(parent.node.name)}"]`;
  if (parent?.isObjectProperty()) return `ObjectProperty[key.name="${propertyKeyName(parent.node.key)}"]`;
  if (parent?.isCallExpression()) return `${callExpressionSelector(calleeName(parent.node.callee))} > StringLiteral[value="${escapeSelectorValue(path.node.value)}"]`;
  return `StringLiteral[value="${escapeSelectorValue(path.node.value)}"]`;
}

function nodeValue(node: t.Node): unknown {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isIdentifier(node)) return node.name;
  if (t.isJSXIdentifier(node)) return node.name;
  if (t.isJSXText(node)) return normalizeJsxText(node.value);
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  return undefined;
}

function astRetryCandidates(filePath: string, source: string, parsed: ParsedAstSource, selector: string): Array<Pick<AstStringCandidate, "id" | "kind" | "value" | "range" | "context" | "parent" | "attr" | "excluded" | "excludeReason" | "suggested">> {
  const needle = selectorNeedle(selector);
  if (!needle) return [];
  return scanStringCandidates(filePath, source, parsed, { contains: needle, includeExcluded: true })
    .slice(0, 5)
    .map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      value: candidate.value,
      range: candidate.range,
      context: candidate.context,
      ...(candidate.parent ? { parent: candidate.parent } : {}),
      ...(candidate.attr ? { attr: candidate.attr } : {}),
      ...(candidate.excluded ? { excluded: true } : {}),
      ...(candidate.excludeReason ? { excludeReason: candidate.excludeReason } : {}),
      suggested: candidate.suggested,
    }));
}

function selectorNeedle(selector: string): string | undefined {
  const quoted = selector.match(/\[[^\]=~*^$|]+[*^$|~]?=(["'])(.*?)\1\]/);
  if (quoted?.[2]) return quoted[2];
  const unquoted = selector.match(/\[[^\]=~*^$|]+[*^$|~]?=([^\]\s]+)\]/);
  return unquoted?.[1];
}

function nodeName(node: t.Node): { name?: string } {
  if (t.isIdentifier(node) || t.isJSXIdentifier(node)) return { name: node.name };
  if (t.isJSXAttribute(node)) return { name: jsxName(node.name) };
  if (t.isObjectProperty(node)) return { name: propertyKeyName(node.key) };
  if (t.isCallExpression(node)) return { name: calleeName(node.callee) };
  return {};
}

function readPath(value: unknown, path: string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as JsonRecord)[segment];
  }
  return cursor;
}

function comparableValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as JsonRecord;
  if (typeof record.name === "string") return record.name;
  if (typeof record.value === "string" || typeof record.value === "number" || typeof record.value === "boolean") return record.value;
  return undefined;
}

function jsxName(name: t.JSXIdentifier | t.JSXNamespacedName | t.JSXMemberExpression): string {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXNamespacedName(name)) return `${name.namespace.name}:${name.name.name}`;
  return `${jsxName(name.object)}.${jsxName(name.property)}`;
}

function propertyKeyName(key: t.ObjectProperty["key"]): string {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key) || t.isNumericLiteral(key)) return String(key.value);
  return key.type;
}

function calleeName(callee: t.CallExpression["callee"]): string {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isMemberExpression(callee)) {
    const objectName = t.isIdentifier(callee.object) ? callee.object.name : callee.object.type;
    const propertyName = t.isIdentifier(callee.property) ? callee.property.name : t.isStringLiteral(callee.property) ? callee.property.value : callee.property.type;
    return `${objectName}.${propertyName}`;
  }
  return callee.type;
}

function callExpressionSelector(name: string): string {
  const [objectName, propertyName, ...rest] = name.split(".");
  if (objectName && propertyName && rest.length === 0) {
    return `CallExpression[callee.object.name="${escapeSelectorValue(objectName)}"][callee.property.name="${escapeSelectorValue(propertyName)}"]`;
  }
  return `CallExpression[callee.name="${escapeSelectorValue(name)}"]`;
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let quote: string | null = null;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === "\\" && index + 1 < input.length) index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth--;
    else if (char === separator && bracketDepth === 0) {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function findBalancedClose(input: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openIndex; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === "\\" && index + 1 < input.length) index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return index;
    }
  }
  fail("INVALID_AST_SELECTOR", `Unclosed ${open}${close} selector segment.`);
}

function preview(source: string, start: number, end: number): string {
  const beforeStart = Math.max(0, source.lastIndexOf("\n", start - 1) + 1);
  const afterEnd = source.indexOf("\n", end);
  const lineEnd = afterEnd < 0 ? source.length : afterEnd;
  return source.slice(beforeStart, lineEnd).trim();
}

function quoteAt(source: string, offset: number | null | undefined): "\"" | "'" {
  return offset !== undefined && offset !== null && source[offset] === "'" ? "'" : "\"";
}

function quoteString(value: string, quote: "\"" | "'"): string {
  if (quote === "\"") return JSON.stringify(value);
  return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n") + "'";
}

function quoteTemplate(value: string): string {
  return "`" + value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
}

function escapeSelectorValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(mailto|tel):/i.test(value);
}

function looksLikePath(value: string): boolean {
  if (/\s/.test(value)) return false;
  return /^(\.?\.?\/|~\/|@\/)[\w./-]+$/.test(value) || /\.(png|jpe?g|gif|webp|svg|css|scss|ts|tsx|js|jsx|json|md)$/i.test(value);
}

const TECHNICAL_JSX_ATTRS = new Set([
  "class",
  "className",
  "id",
  "key",
  "data-testid",
  "data-test",
  "data-cy",
  "testID",
  "href",
  "src",
  "type",
  "role",
  "rel",
  "target",
  "width",
  "height",
]);
