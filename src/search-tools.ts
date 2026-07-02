import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { agentPath, relativeAgentPath } from "./agent-path.js";
import { parseLineRange, parseVerificationFields, verifyParseForFile } from "./base-edit.js";
import { lineStartOffsets } from "./source-range.js";

type JsonRecord = Record<string, unknown>;

type LineRange = {
  start: number;
  end: number;
};

type SourceLine = {
  number: number;
  text: string;
};

type SourceRange = {
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  lineRange: string;
};

type InspectRangeOptions = {
  lines?: string;
  head?: number;
  tail?: number;
  context?: number;
};

type SearchTextOptions = {
  query: string;
  paths?: string[];
  regex?: boolean;
  glob?: string;
  maxResults?: number;
  context?: number;
  multieditSpec?: boolean;
  replace?: string;
  caseSensitive?: boolean;
  includeHidden?: boolean;
};

type SearchContext = {
  expanded: LineRange;
  lines: SourceLine[];
};

type SearchCandidate = {
  id: string;
  file: string;
  path: string;
  match: string;
  range: SourceRange;
  preview: string;
  context?: SearchContext;
  suggested: JsonRecord;
  suggestions: JsonRecord[];
};

type MultieditSpec = {
  edits: JsonRecord[];
  count: number;
  editCount: number;
  fileCount: number;
  matchCount: number;
  replace: string;
  truncated: boolean;
};

type MarkupBlockSummary = {
  tag: string;
  attrs?: string;
  lineRange: string;
  bytes: number;
  chars: number;
  packed: boolean;
  preview: string;
};

const DEFAULT_SEARCH_EXCLUDES = new Set([".git", "node_modules", "dist", "build", "coverage", ".tedit-cache"]);
const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".pyw",
  ".json", ".jsonl", ".md", ".mdx", ".txt", ".css", ".scss",
  ".html", ".xml", ".yml", ".yaml",
]);
const MAX_INSPECT_LINE_TEXT = 4000;
const PACKED_LINE_CHARS = 20_000;

export function inspectFileOverview(filePath: string): JsonRecord {
  const source = readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  const longLines = largestLines(lines).filter((line) => Number(line.chars) >= PACKED_LINE_CHARS);
  const verification = verifyParseForFile(filePath, source);

  return {
    success: true,
    kind: "file-overview",
    file: filePath,
    path: relativeAgentPath(process.cwd(), filePath),
    bytes: Buffer.byteLength(source, "utf8"),
    chars: source.length,
    lineCount: lines.length,
    packed: {
      detected: longLines.length > 0,
      reason: longLines.length > 0 ? "one or more very long lines; inspect/search returns previews instead of dumping full packed content" : "none",
      longLines,
    },
    ...parseVerificationFields(verification),
    ...(isMarkupFile(filePath) ? { markup: markupOverview(source) } : {}),
    suggestions: [
      { tool: "search", arguments: { file: filePath, head: 40 }, reason: "read the human-authored wrapper/header first" },
      { tool: "search", arguments: { file: filePath, query: "<script", maxResults: 10 }, reason: "locate bundled script blocks without reading the whole bundle" },
      { tool: "search", arguments: { file: filePath, query: "id=", maxResults: 20 }, reason: "find stable DOM anchors inside packed HTML" },
    ],
  };
}

export function inspectRange(filePath: string, options: InspectRangeOptions): JsonRecord {
  const source = readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  const requested = inspectRequestedRange(lines, options);
  const context = Math.max(0, options.context ?? 0);
  const expanded: LineRange = {
    start: Math.max(1, requested.start - context),
    end: Math.min(lines.length, requested.end + context),
  };
  const byteRange = byteRangeForLines(source, expanded);
  const verification = verifyParseForFile(filePath, source);
  const packedLines = packedLinesInRange(lines, expanded);

  return {
    success: true,
    kind: "inspect-range",
    file: filePath,
    requested,
    expanded,
    byteRange,
    lines: lineObjects(lines, expanded),
    ...(packedLines.length > 0 ? { packed: { detected: true, longLines: packedLines } } : {}),
    ...parseVerificationFields(verification),
    suggested: {
      tool: "edit",
      file: filePath,
      findLines: `${requested.start}:${requested.end}`,
      replaceHint: "findLines replaces whole lines; include the trailing newline unless replacing the final line.",
    },
    suggestions: [
      { tool: "edit", arguments: { file: filePath, findLines: `${requested.start}:${requested.end}`, replace: "<replacement including trailing newline>" } },
    ],
  };
}

function inspectRequestedRange(lines: string[], options: InspectRangeOptions): LineRange {
  const requestedModes = [options.lines !== undefined, options.head !== undefined, options.tail !== undefined].filter(Boolean).length;
  if (requestedModes !== 1) throw new Error("inspect_range requires exactly one of lines, head, or tail.");
  if (options.lines !== undefined) return parseLineRange(options.lines);

  const lineCount = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (options.head !== undefined) {
    const count = Math.max(0, Math.min(lineCount, options.head));
    return { start: 1, end: count };
  }

  const count = Math.max(0, Math.min(lineCount, options.tail ?? 0));
  return { start: Math.max(1, lineCount - count + 1), end: lineCount };
}

export function searchText(options: SearchTextOptions): JsonRecord {
  const paths = options.paths && options.paths.length > 0 ? options.paths : [process.cwd()];
  const files = paths.flatMap((path) => filesForSearchPath(path, options));
  const matcher = buildMatcher(options);
  const maxResults = options.maxResults ?? 100;
  const context = Math.max(0, options.context ?? 0);
  const results: SearchCandidate[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const sourceLines = source.split(/\r?\n/);
    for (const match of findMatches(source, matcher, options)) {
      results.push(candidateForMatch(results.length + 1, file, source, sourceLines, match.start, match.end, context));
      if (results.length >= maxResults) break;
    }
    if (results.length >= maxResults) break;
  }

  return {
    success: true,
    kind: "search-text",
    query: options.query,
    regex: options.regex === true,
    paths,
    ...(options.glob ? { glob: options.glob } : {}),
    ...(context > 0 ? { context } : {}),
    ...(options.multieditSpec ? { multiedit: multieditSpecForSearch(options, results, results.length >= maxResults) } : {}),
    results,
    count: results.length,
    matchCount: results.length,
    fileCount: uniqueFileCount(results),
    truncated: results.length >= maxResults,
  };
}

function multieditSpecForSearch(options: SearchTextOptions, results: SearchCandidate[], truncated: boolean): MultieditSpec {
  const replace = options.replace ?? "<replacement>";
  const find = multieditFindForSearch(options);
  const files = new Set(results.map((result) => result.file));
  let matchCount = 0;
  const edits = [...files].flatMap((file) => {
    const count = countMultieditMatches(readFileSync(file, "utf8"), find);
    if (count === 0) return [];
    matchCount += count;
    return [{
      file: agentPath(file),
      ...find,
      replace,
      replaceAll: true,
      expectCount: count,
    }];
  });
  return { edits, count: edits.length, editCount: edits.length, fileCount: files.size, matchCount, replace, truncated };
}

function uniqueFileCount(results: SearchCandidate[]): number {
  return new Set(results.map((result) => result.file)).size;
}

function multieditFindForSearch(options: SearchTextOptions): JsonRecord {
  if (options.regex) return { findRegex: options.query };
  if (isAsciiIdentifier(options.query)) return { findRegex: `\\b${escapeRegExp(options.query)}\\b` };
  return { findExact: options.query };
}

function countMultieditMatches(source: string, find: JsonRecord): number {
  if (typeof find.findExact === "string") return countExactMatches(source, find.findExact);
  if (typeof find.findRegex !== "string") return 0;
  const flags = typeof find.flags === "string" ? find.flags : "";
  const regex = new RegExp(find.findRegex, flags.includes("g") ? flags : `${flags}g`);
  let count = 0;
  for (let match = regex.exec(source); match; match = regex.exec(source)) {
    count += 1;
    if (match[0] === "") regex.lastIndex += 1;
  }
  return count;
}

function countExactMatches(source: string, query: string): number {
  if (query === "") return 0;
  let count = 0;
  for (let index = source.indexOf(query); index >= 0; index = source.indexOf(query, index + query.length)) count += 1;
  return count;
}

function isAsciiIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function filesForSearchPath(pathInput: string, options: SearchTextOptions): string[] {
  const root = resolve(pathInput);
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return isSearchableFile(root, options) ? [root] : [];
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  walk(root, options, files);
  return files.sort();
}

function walk(dir: string, options: SearchTextOptions, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!options.includeHidden && entry.name.startsWith(".")) {
      if (entry.name !== ".") continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_SEARCH_EXCLUDES.has(entry.name) || (entry.name === "cache" && basename(dir) === ".tedit")) continue;
      walk(fullPath, options, files);
    } else if (entry.isFile() && isSearchableFile(fullPath, options)) {
      files.push(fullPath);
    }
  }
}

function isSearchableFile(filePath: string, options: SearchTextOptions): boolean {
  if (options.glob && !matchesGlob(filePath, options.glob)) return false;
  const extension = extname(filePath);
  if (TEXT_EXTENSIONS.has(extension)) return true;
  if (extension === "") {
    try {
      const source = readFileSync(filePath);
      return !source.subarray(0, 1024).includes(0);
    } catch {
      return false;
    }
  }
  return false;
}

function buildMatcher(options: SearchTextOptions): RegExp | string {
  if (options.regex) {
    return new RegExp(options.query, options.caseSensitive ? "g" : "gi");
  }
  return options.caseSensitive ? options.query : options.query.toLowerCase();
}

function findMatches(source: string, matcher: RegExp | string, options: SearchTextOptions): Array<{ start: number; end: number }> {
  if (matcher instanceof RegExp) {
    const matches: Array<{ start: number; end: number }> = [];
    matcher.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(source)) !== null) {
      const text = match[0];
      matches.push({ start: match.index, end: match.index + text.length });
      if (text.length === 0) matcher.lastIndex++;
    }
    return matches;
  }

  const haystack = options.caseSensitive ? source : source.toLowerCase();
  const needle = matcher;
  const matches: Array<{ start: number; end: number }> = [];
  if (needle.length === 0) return matches;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    matches.push({ start: index, end: index + needle.length });
    index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
  }
  return matches;
}

function candidateForMatch(index: number, filePath: string, source: string, lines: string[], start: number, end: number, context: number): SearchCandidate {
  const range = rangeForOffsets(source, start, end);
  const path = relativeAgentPath(process.cwd(), filePath);
  const displayFile = agentPath(filePath);
  const contextRange: LineRange = {
    start: Math.max(1, range.line - context),
    end: Math.min(lines.length, range.endLine + context),
  };
  const candidate: SearchCandidate = {
    id: `text_${index}`,
    file: displayFile,
    path,
    match: source.slice(start, end),
    range,
    preview: lines[range.line - 1] ?? "",
    suggested: {
      tool: "edit",
      file: filePath,
      findLines: range.lineRange,
      replaceHint: "findLines replaces whole lines; include the trailing newline unless replacing the final line.",
    },
    suggestions: [
      { tool: "search", cliCommand: "inspect-range", arguments: { file: displayFile, lines: range.lineRange, context: context > 0 ? context : 3 } },
      { tool: "edit", arguments: { file: displayFile, findLines: range.lineRange, replace: "<replacement including trailing newline>" } },
    ],
  };
  if (context > 0) {
    candidate.context = {
      expanded: contextRange,
      lines: lineObjects(lines, contextRange),
    };
  }
  return candidate;
}

function rangeForOffsets(source: string, start: number, end: number): SourceRange {
  const starts = lineStartOffsets(source);
  const loc = offsetLoc(start, starts);
  const endLoc = offsetLoc(Math.max(start, end - 1), starts);
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

function lineObjects(lines: string[], range: LineRange): SourceLine[] {
  const output: SourceLine[] = [];
  for (let line = range.start; line <= range.end; line++) {
    output.push(lineObject(line, lines[line - 1] ?? "") as SourceLine);
  }
  return output;
}

function lineObject(number: number, text: string): JsonRecord {
  if (text.length <= MAX_INSPECT_LINE_TEXT) return { number, text };
  return {
    number,
    text: `${text.slice(0, MAX_INSPECT_LINE_TEXT)}…`,
    truncated: true,
    chars: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function packedLinesInRange(lines: string[], range: LineRange): JsonRecord[] {
  const packed: JsonRecord[] = [];
  for (let line = range.start; line <= range.end; line++) {
    const text = lines[line - 1] ?? "";
    if (text.length >= PACKED_LINE_CHARS) packed.push(lineStats(line, text));
  }
  return packed;
}

function largestLines(lines: string[]): JsonRecord[] {
  return lines
    .map((text, index) => lineStats(index + 1, text))
    .sort((a, b) => Number(b.chars) - Number(a.chars))
    .slice(0, 5);
}

function lineStats(number: number, text: string): JsonRecord {
  return {
    number,
    chars: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    preview: text.slice(0, 160),
  };
}

function isMarkupFile(filePath: string): boolean {
  return [".html", ".htm", ".xml", ".svg"].includes(extname(filePath));
}

function markupOverview(source: string): JsonRecord {
  const title = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const tags = new Map<string, number>();
  for (const match of source.matchAll(/<([A-Za-z][\w:-]*)\b/g)) {
    const tag = match[1].toLowerCase();
    tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  const ids = [...source.matchAll(/\bid=(['"])(.*?)\1/g)].slice(0, 30).map((match) => match[2]);
  const blocks = markupBlocks(source);
  return {
    ...(title ? { title } : {}),
    topTags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, count]) => ({ tag, count })),
    ids,
    scripts: blocks.filter((block) => block.tag === "script"),
    styles: blocks.filter((block) => block.tag === "style"),
  };
}

function markupBlocks(source: string): MarkupBlockSummary[] {
  const blocks: MarkupBlockSummary[] = [];
  const regex = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of source.matchAll(regex)) {
    const raw = match[0];
    const content = match[3] ?? "";
    blocks.push({
      tag: match[1].toLowerCase(),
      ...(match[2]?.trim() ? { attrs: match[2].trim().slice(0, 200) } : {}),
      lineRange: rangeForOffsets(source, match.index ?? 0, (match.index ?? 0) + raw.length).lineRange,
      bytes: Buffer.byteLength(raw, "utf8"),
      chars: raw.length,
      packed: hasPackedLine(content),
      preview: content.trim().slice(0, 180),
    });
  }
  return blocks.sort((a, b) => b.bytes - a.bytes).slice(0, 10);
}

function hasPackedLine(source: string): boolean {
  if (source.length < PACKED_LINE_CHARS) return false;
  return source.split(/\r?\n/).some((line) => line.length >= PACKED_LINE_CHARS);
}

function offsetLoc(offset: number, starts: number[]): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  const index = Math.max(0, high);
  return { line: index + 1, column: offset - starts[index] + 1 };
}

function byteRangeForLines(source: string, range: LineRange): SourceRange {
  const lineStarts = lineStartOffsets(source);
  const start = lineStarts[Math.max(0, range.start - 1)] ?? source.length;
  const end = range.end >= lineStarts.length ? source.length : Math.max(0, lineStarts[range.end] - 1);
  return rangeForOffsets(source, start, end);
}

function matchesGlob(filePath: string, glob: string): boolean {
  const normalized = filePath.split("\\").join("/");
  const cwdRelative = relativeAgentPath(process.cwd(), filePath);
  const regex = globToRegExp(glob);
  return regex.test(normalized) || regex.test(cwdRelative) || regex.test(basename(filePath));
}

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index++;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else if (char === "{") {
      const close = glob.indexOf("}", index + 1);
      const body = close === -1 ? "" : glob.slice(index + 1, close);
      if (!body) {
        pattern += escapeRegExp(char);
      } else {
        const alternatives = body.split(",").map((part) => part.trim()).filter(Boolean);
        pattern += alternatives.length > 0 ? `(?:${alternatives.map(escapeRegExp).join("|")})` : escapeRegExp(char);
        index = close;
      }
    } else {
      pattern += escapeRegExp(char);
    }
  }
  return new RegExp(`^${pattern}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
