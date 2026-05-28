import { getOptionalAdapterForFile } from "./core/registry.js";
import { unifiedDiff } from "./diff.js";
import { fail } from "./errors.js";
import { extname } from "node:path";

export const BASE_ACTIONS = [
  "edit.find",
  "edit.replace",
  "edit.insert-before",
  "edit.insert-after",
  "edit.delete",
] as const;

export type BaseFindStrategy =
  | { kind: "exact"; pattern: string; autoFuzzy?: boolean }
  | { kind: "fuzzy"; pattern: string; ignoreWhitespace?: boolean }
  | { kind: "anchor"; after: string; contains: string }
  | { kind: "regex"; pattern: string; flags?: string }
  | { kind: "lines"; start: number; end: number };

export type BaseEditMutation =
  | { kind: "replace"; text: string }
  | { kind: "insert-before"; text: string }
  | { kind: "insert-after"; text: string }
  | { kind: "delete" };

export type BaseMatch = {
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  lineRange: string;
  preview: string;
  context: string;
};

export type BaseEditOptions = {
  filePath: string;
  source: string;
  strategy: BaseFindStrategy;
  mutation: BaseEditMutation;
  replaceAll?: boolean;
  expectCount?: number;
  verifyParse?: boolean;
};

export type BaseEditPlan = {
  success: true;
  file: string;
  action: BaseEditMutation["kind"];
  strategy: BaseFindStrategy["kind"];
  matches: BaseMatch[];
  changed: boolean;
  source: string;
  nextSource: string;
  diff: string;
  parseVerified: boolean;
  parseVerification: BaseParseVerification;
};

export type BaseParseVerification = {
  verified: boolean;
  parser?: string;
};

type RawMatch = {
  start: number;
  end: number;
};

export function planBaseEdit(options: BaseEditOptions): BaseEditPlan {
  validateOptions(options);

  const matches = findRawMatches(options.source, options.strategy);
  if (matches.length === 0) {
    failNoMatch(options);
  }

  if (options.expectCount !== undefined && matches.length !== options.expectCount) {
    fail("MATCH_COUNT_MISMATCH", `Expected ${options.expectCount} match(es), found ${matches.length}.`, {
      tried_strategy: describeStrategy(options.strategy),
      expected_count: options.expectCount,
      actual_count: matches.length,
      matches: summarizeMatches(options.source, matches),
      suggestions: countSuggestions(matches.length),
      next_step_hint: "Adjust --expect-count, narrow the match, or use --replace-all intentionally.",
    });
  }

  if (matches.length > 1 && !options.replaceAll) {
    fail("MATCH_NOT_UNIQUE", `Match is not unique; found ${matches.length} candidates.`, {
      tried_strategy: describeStrategy(options.strategy),
      matches: summarizeMatches(options.source, matches),
      suggestions: notUniqueSuggestions(matches.length),
      next_step_hint: "Re-run with a narrower strategy or pass --replace-all if every match is intended.",
    });
  }

  const nextSource = applyMutation(options.source, matches, options.mutation, Boolean(options.replaceAll));
  const parseVerification = verifyParseForFile(options.filePath, nextSource, options.verifyParse !== false);
  const diff = unifiedDiff(options.source, nextSource, options.filePath);

  return {
    success: true,
    file: options.filePath,
    action: options.mutation.kind,
    strategy: options.strategy.kind,
    matches: summarizeMatches(options.source, matches),
    changed: nextSource !== options.source,
    source: options.source,
    nextSource,
    diff,
    parseVerified: parseVerification.verified,
    parseVerification,
  };
}

export function parseLineRange(value: string): { start: number; end: number } {
  const match = value.match(/^(\d+)(?::(\d+))?$/);
  if (!match) fail("INVALID_LINE_RANGE", `Invalid line range "${value}". Expected N or N:M.`);
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    fail("INVALID_LINE_RANGE", `Invalid line range "${value}". Expected 1-based N or N:M.`);
  }
  return { start, end };
}

function validateOptions(options: BaseEditOptions): void {
  if (options.replaceAll && options.strategy.kind === "lines") {
    fail("INVALID_BASE_EDIT", "--replace-all is not meaningful with --find-lines.");
  }
  if (options.expectCount !== undefined && (!Number.isInteger(options.expectCount) || options.expectCount < 0)) {
    fail("INVALID_BASE_EDIT", "--expect-count must be a non-negative integer.");
  }
}

function failNoMatch(options: BaseEditOptions): never {
  if (options.strategy.kind === "exact" && options.strategy.autoFuzzy !== false) {
    const fuzzyMatches = findRawMatches(options.source, { kind: "fuzzy", pattern: options.strategy.pattern });
    if (fuzzyMatches.length === 1) {
      fail("MATCH_FUZZY_ONLY", "Exact match failed, but one whitespace-insensitive match is available.", {
        tried_strategy: describeStrategy(options.strategy),
        fuzzy_strategy: { kind: "fuzzy", ignoreWhitespace: true },
        matches: summarizeMatches(options.source, fuzzyMatches),
        fuzzy_candidates: fuzzyCandidateHints(options.source, options.strategy.pattern, fuzzyMatches),
        suggestions: [
          "Re-run with --find-fuzzy to accept a whitespace-insensitive match.",
          "Use --find-lines N:M if the exact source range is already known.",
        ],
        next_step_hint: "tedit refused to guess. Choose the fuzzy match explicitly or provide more context.",
      });
    }
    if (fuzzyMatches.length > 1) {
      fail("MATCH_NOT_UNIQUE", `Exact match failed, and fuzzy fallback found ${fuzzyMatches.length} candidates.`, {
        tried_strategy: describeStrategy(options.strategy),
        fuzzy_strategy: { kind: "fuzzy", ignoreWhitespace: true },
        matches: summarizeMatches(options.source, fuzzyMatches),
        fuzzy_candidates: fuzzyCandidateHints(options.source, options.strategy.pattern, fuzzyMatches),
        suggestions: notUniqueSuggestions(fuzzyMatches.length),
        next_step_hint: "Use an anchor, a line range, or a more specific literal.",
      });
    }
  }

  fail("MATCH_NONE", "No match found.", {
    tried_strategy: describeStrategy(options.strategy),
    matches: [],
    suggestions: [
      "Check the literal text for stale whitespace or punctuation.",
      "Use --find-fuzzy for whitespace-insensitive matching.",
      "Use --find-anchor-after with --find when the target is in a known section.",
      "Use --find-lines N:M as a last resort when a diagnostic already gave line numbers.",
    ],
    next_step_hint: "Re-run with a strategy that can identify exactly one target span.",
  });
}

function findRawMatches(source: string, strategy: BaseFindStrategy): RawMatch[] {
  switch (strategy.kind) {
    case "exact":
      return findExact(source, strategy.pattern);
    case "fuzzy":
      return findFuzzy(source, strategy.pattern);
    case "anchor":
      return findAnchored(source, strategy.after, strategy.contains);
    case "regex":
      return findRegex(source, strategy.pattern, strategy.flags);
    case "lines":
      return [findLineRange(source, strategy.start, strategy.end)];
  }
}

function findExact(source: string, pattern: string): RawMatch[] {
  if (pattern.length === 0) fail("INVALID_BASE_EDIT", "Find pattern cannot be empty.");

  const matches: RawMatch[] = [];
  let cursor = 0;
  while (cursor <= source.length) {
    const start = source.indexOf(pattern, cursor);
    if (start < 0) break;
    matches.push({ start, end: start + pattern.length });
    cursor = start + Math.max(pattern.length, 1);
  }
  return matches;
}

function findFuzzy(source: string, pattern: string): RawMatch[] {
  const normalizedPattern = normalizeWhitespace(pattern, true);
  if (normalizedPattern.text.length === 0) fail("INVALID_BASE_EDIT", "Fuzzy find pattern cannot be empty.");

  const normalizedSource = normalizeWhitespace(source, false);
  const matches: RawMatch[] = [];
  let cursor = 0;
  while (cursor <= normalizedSource.text.length) {
    const normalizedStart = normalizedSource.text.indexOf(normalizedPattern.text, cursor);
    if (normalizedStart < 0) break;
    const normalizedEnd = normalizedStart + normalizedPattern.text.length - 1;
    matches.push({
      start: normalizedSource.starts[normalizedStart],
      end: normalizedSource.ends[normalizedEnd],
    });
    cursor = normalizedStart + Math.max(normalizedPattern.text.length, 1);
  }
  return dedupeMatches(matches);
}

function findAnchored(source: string, after: string, contains: string): RawMatch[] {
  if (!after) fail("INVALID_BASE_EDIT", "--find-anchor-after cannot be empty.");
  if (!contains) fail("INVALID_BASE_EDIT", "Anchor strategy requires --find or --contains.");

  const anchors = findExact(source, after);
  const matches: RawMatch[] = [];
  anchors.forEach((anchor, index) => {
    const sectionStart = anchor.end;
    const sectionEnd = anchors[index + 1]?.start ?? source.length;
    let cursor = sectionStart;
    while (cursor <= sectionEnd) {
      const start = source.indexOf(contains, cursor);
      if (start < 0 || start + contains.length > sectionEnd) break;
      matches.push({ start, end: start + contains.length });
      cursor = start + Math.max(contains.length, 1);
    }
  });
  return dedupeMatches(matches);
}

function findRegex(source: string, pattern: string, flags = ""): RawMatch[] {
  if (!pattern) fail("INVALID_BASE_EDIT", "--find-regex cannot be empty.");
  const regexFlags = flags.includes("g") ? flags : `${flags}g`;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, regexFlags);
  } catch (error) {
    fail("INVALID_REGEX", error instanceof Error ? error.message : String(error));
  }

  const matches: RawMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) regex.lastIndex++;
  }
  return matches;
}

function findLineRange(source: string, startLine: number, endLine: number): RawMatch {
  const starts = lineStarts(source);
  const lineCount = countLines(source);
  if (startLine > lineCount || endLine > lineCount) {
    fail("LINE_RANGE_OUT_OF_BOUNDS", `Line range ${startLine}:${endLine} is outside the file (${lineCount} lines).`);
  }

  const start = starts[startLine - 1];
  const end = endLine < lineCount ? starts[endLine] : source.length;
  return { start, end };
}

function applyMutation(source: string, matches: RawMatch[], mutation: BaseEditMutation, replaceAll: boolean): string {
  const selected = replaceAll ? matches : matches.slice(0, 1);
  let next = source;
  [...selected].reverse().forEach((match) => {
    const before = next.slice(0, match.start);
    const current = next.slice(match.start, match.end);
    const after = next.slice(match.end);
    switch (mutation.kind) {
      case "replace":
        next = `${before}${mutation.text}${after}`;
        break;
      case "insert-before":
        next = `${before}${mutation.text}${current}${after}`;
        break;
      case "insert-after":
        next = `${before}${current}${mutation.text}${after}`;
        break;
      case "delete":
        next = `${before}${after}`;
        break;
    }
  });
  return next;
}

export function verifyParseForFile(filePath: string, source: string, enabled = true): BaseParseVerification {
  if (!enabled) return { verified: false };
  const adapter = getOptionalAdapterForFile(filePath);
  const extension = extname(filePath).toLowerCase();
  const adapterVerifier = adapter?.verify;
  const parser = adapterVerifier ? adapter.rule.name : parserForExtension(extension);
  if (!parser) return { verified: false };

  try {
    if (adapterVerifier) adapterVerifier(filePath, source);
    else if (parser === "json") JSON.parse(source);
    else if (parser === "markdown-lite") verifyMarkdownLite(source);
    else if (parser === "yaml-lite") verifyYamlLite(source);
    return { verified: true, parser };
  } catch (error) {
    fail("PARSE_BROKEN_AFTER_EDIT", "Edit would produce invalid syntax for this file type; no write was performed.", {
      rule: parser,
      parser,
      parser_error: error instanceof Error ? error.message : String(error),
      ...parseErrorLocation(error, source),
      ...(parser === "json" ? jsonParseLocation(error) : {}),
      next_step_hint: "Inspect the reported line, fix the syntax, then rerun the same tedit command.",
    });
  }
}

function parserForExtension(extension: string): string | undefined {
  if (extension === ".json") return "json";
  if (extension === ".md" || extension === ".markdown" || extension === ".mdx") return "markdown-lite";
  if (extension === ".yaml" || extension === ".yml") return "yaml-lite";
  return undefined;
}

function jsonParseLocation(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/position\s+(\d+)/i);
  if (!match) return {};
  return { parser_position: Number(match[1]) };
}

function parseErrorLocation(error: unknown, source: string): Record<string, unknown> {
  const line = errorLine(error, source);
  if (!line) return {};
  return { line, snippet: sourceLine(source, line) };
}

function errorLine(error: unknown, source: string): number | undefined {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const loc = record.loc;
    if (loc && typeof loc === "object" && typeof (loc as Record<string, unknown>).line === "number") return (loc as Record<string, number>).line;
    if (typeof record.line === "number") return record.line;
    if (typeof record.lineNumber === "number") return record.lineNumber;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lineMatch = message.match(/line\s+(\d+)/i);
  if (lineMatch) return Number(lineMatch[1]);
  const positionMatch = message.match(/position\s+(\d+)/i);
  if (positionMatch) return lineForOffset(source, Number(positionMatch[1]));
  return undefined;
}

function lineForOffset(source: string, offset: number): number {
  return source.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

function sourceLine(source: string, line: number): string {
  return source.split(/\r?\n/)[line - 1] ?? "";
}

function verifyMarkdownLite(source: string): void {
  const lines = source.split(/\r?\n/);
  verifyFrontmatterFence(lines);
  verifyCodeFences(lines);
}

function verifyFrontmatterFence(lines: string[]): void {
  if (lines.length === 0) return;
  const first = lines[0].replace(/^\uFEFF/, "");
  if (first.trim() !== "---") return;

  const status = frontmatterStatus(lines);
  if (status === "unclosed") throw new Error("Unclosed frontmatter fence opened at line 1.");
}

function frontmatterStatus(lines: string[]): "closed" | "unclosed" | "not-frontmatter" {
  let hasFrontmatterContent = false;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "---" || line === "...") return hasFrontmatterContent ? "closed" : "not-frontmatter";
    if (/^[^:#][^:]*:\s*.*$/.test(line)) {
      hasFrontmatterContent = true;
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    return hasFrontmatterContent ? "unclosed" : "not-frontmatter";
  }
  return hasFrontmatterContent ? "unclosed" : "not-frontmatter";
}

function verifyYamlLite(source: string): void {
  const stack: Array<{ indent: number; acceptsChildren: boolean; line: number; keys: Set<string> }> = [{ indent: -1, acceptsChildren: true, line: 0, keys: new Set() }];
  const lines = source.split(/\r?\n/);
  let sawContent = false;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const trimmed = raw.trimStart();
    if (trimmed === "---") {
      if (sawContent) throw new Error(`Multiple YAML documents are not supported at line ${index + 1}.`);
      sawContent = true;
      continue;
    }
    if (trimmed === "...") {
      const remaining = lines.slice(index + 1).some((line) => line.trim() && !line.trimStart().startsWith("#"));
      if (remaining) throw new Error(`YAML content after document end marker is not supported at line ${index + 1}.`);
      return;
    }
    sawContent = true;
    if (/^[ \t]*\t/.test(raw)) throw new Error(`YAML tabs are not supported at line ${index + 1}.`);
    const indent = raw.match(/^ */)?.[0].length ?? 0;
    if (indent % 2 !== 0) throw new Error(`YAML indentation must use multiples of two spaces at line ${index + 1}.`);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (indent > parent.indent && !parent.acceptsChildren) {
      throw new Error(`Indented child under scalar YAML value at line ${index + 1}.`);
    }
    const sequence = trimmed.match(/^-\s+(.*)$/);
    if (sequence) {
      const value = sequence[1].trim();
      stack.push({ indent, acceptsChildren: value.length === 0, line: index + 1, keys: new Set() });
      continue;
    }
    const mapping = trimmed.match(/^([^:#][^:]*):(\s*(.*))?$/);
    if (!mapping) continue;
    const key = mapping[1].trim();
    if (parent.keys.has(key)) throw new Error(`Duplicate YAML key "${key}" at line ${index + 1}.`);
    parent.keys.add(key);
    const value = (mapping[3] ?? "").trim();
    stack.push({ indent, acceptsChildren: value.length === 0, line: index + 1, keys: new Set() });
  }
}

function verifyCodeFences(lines: string[]): void {
  let open: { line: number; marker: "`" | "~"; length: number } | undefined;

  lines.forEach((line, index) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) return;

    const fence = match[1];
    const marker = fence[0] as "`" | "~";
    if (!open) {
      open = { line: index + 1, marker, length: fence.length };
      return;
    }

    if (open.marker === marker && fence.length >= open.length) {
      open = undefined;
    }
  });

  if (open) {
    throw new Error(`Unclosed ${open.marker.repeat(open.length)} code fence opened at line ${open.line}.`);
  }
}

function summarizeMatches(source: string, matches: RawMatch[]): BaseMatch[] {
  return matches.map((match) => {
    const loc = offsetToLineColumn(source, match.start);
    const endLoc = offsetToLineColumn(source, Math.max(match.start, match.end - 1));
    return {
      ...match,
      line: loc.line,
      column: loc.column,
      endLine: endLoc.line,
      endColumn: endLoc.column,
      lineRange: loc.line === endLoc.line ? String(loc.line) : `${loc.line}:${endLoc.line}`,
      preview: previewForSpan(source, match.start, match.end),
      context: contextForLine(source, loc.line),
    };
  });
}

function fuzzyCandidateHints(source: string, pattern: string, matches: RawMatch[]): Array<Record<string, unknown>> {
  return matches.map((match) => {
    const start = offsetToLineColumn(source, match.start);
    const end = offsetToLineColumn(source, Math.max(match.start, match.end - 1));
    const actual = source.slice(match.start, match.end);
    return {
      line_range: start.line === end.line ? String(start.line) : `${start.line}:${end.line}`,
      find_lines: start.line === end.line ? String(start.line) : `${start.line}:${end.line}`,
      requested_chars: pattern.length,
      actual_chars: actual.length,
      whitespace_drift: {
        requested_runs: whitespaceRuns(pattern),
        actual_runs: whitespaceRuns(actual),
      },
      preview: previewForSpan(source, match.start, match.end),
    };
  });
}

function whitespaceRuns(value: string): number[] {
  return (value.match(/\s+/g) ?? []).map((run) => run.length);
}

function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    if (source[index] === "\n") {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function previewForSpan(source: string, start: number, end: number): string {
  const text = source.slice(start, end).replace(/\s+/g, " ").trim();
  if (text.length <= 120) return text;
  return `${text.slice(0, 117)}...`;
}

function contextForLine(source: string, line: number): string {
  const lines = source.split(/\r?\n/);
  const start = Math.max(0, line - 2);
  const end = Math.min(lines.length, line + 1);
  return lines.slice(start, end).map((item, index) => `${start + index + 1}: ${item}`).join("\n");
}

function describeStrategy(strategy: BaseFindStrategy): Record<string, unknown> {
  switch (strategy.kind) {
    case "exact":
      return { kind: "exact", pattern: strategy.pattern };
    case "fuzzy":
      return { kind: "fuzzy", pattern: strategy.pattern, ignoreWhitespace: strategy.ignoreWhitespace !== false };
    case "anchor":
      return { kind: "anchor", after: strategy.after, contains: strategy.contains };
    case "regex":
      return { kind: "regex", pattern: strategy.pattern, flags: strategy.flags ?? "" };
    case "lines":
      return { kind: "lines", start: strategy.start, end: strategy.end };
  }
}

function notUniqueSuggestions(count: number): string[] {
  return [
    "Add surrounding context to the find text.",
    "Use --find-anchor-after when the target is inside a known section.",
    `Use --replace-all if all ${count} locations are intended.`,
    "Use --find-lines N:M as a last resort if you already know the source range.",
  ];
}

function countSuggestions(actual: number): string[] {
  if (actual === 0) {
    return ["Check the find strategy or remove --expect-count if zero matches is acceptable."];
  }
  return [
    "Narrow the match when fewer edits are intended.",
    "Use --replace-all when every matched location should change.",
    "Update --expect-count to the intended match count.",
  ];
}

function dedupeMatches(matches: RawMatch[]): RawMatch[] {
  const seen = new Set<string>();
  const result: RawMatch[] = [];
  matches.forEach((match) => {
    const key = `${match.start}:${match.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(match);
  });
  return result;
}

function normalizeWhitespace(input: string, trim: boolean): { text: string; starts: number[]; ends: number[] } {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      const start = index;
      while (index < input.length && /\s/.test(input[index])) index++;
      const end = index;
      if (trim && text.length === 0) continue;
      text += " ";
      starts.push(start);
      ends.push(end);
      continue;
    }
    text += char;
    starts.push(index);
    ends.push(index + 1);
    index++;
  }

  if (trim && text.endsWith(" ")) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }

  return { text, starts, ends };
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function countLines(source: string): number {
  if (source.length === 0) return 1;
  return source.split(/\r?\n/).length;
}
