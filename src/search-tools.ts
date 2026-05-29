import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { parseLineRange, parseVerificationFields, verifyParseForFile } from "./base-edit.js";

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
  lines: string;
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
  next: JsonRecord[];
};

type MultieditSpec = {
  edits: JsonRecord[];
  count: number;
  replace: string;
  truncated: boolean;
};

const DEFAULT_SEARCH_EXCLUDES = new Set([".git", "node_modules", "dist", "build", "coverage", ".tedit-cache"]);
const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".json", ".jsonl", ".md", ".mdx", ".txt", ".css", ".scss",
  ".html", ".xml", ".yml", ".yaml",
]);

export function inspectRange(filePath: string, options: InspectRangeOptions): JsonRecord {
  const source = readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  const requested = parseLineRange(options.lines);
  const context = Math.max(0, options.context ?? 0);
  const expanded: LineRange = {
    start: Math.max(1, requested.start - context),
    end: Math.min(lines.length, requested.end + context),
  };
  const byteRange = byteRangeForLines(source, expanded);
  const verification = verifyParseForFile(filePath, source);

  return {
    success: true,
    kind: "inspect-range",
    file: filePath,
    requested,
    expanded,
    byteRange,
    lines: lineObjects(lines, expanded),
    ...parseVerificationFields(verification),
    suggested: {
      tool: "edit",
      file: filePath,
      findLines: `${requested.start}:${requested.end}`,
      replaceHint: "findLines replaces whole lines; include the trailing newline unless replacing the final line.",
    },
    next: [
      { tool: "edit", arguments: { file: filePath, findLines: `${requested.start}:${requested.end}`, replace: "<replacement including trailing newline>" } },
    ],
  };
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
    truncated: results.length >= maxResults,
  };
}

function multieditSpecForSearch(options: SearchTextOptions, results: SearchCandidate[], truncated: boolean): MultieditSpec {
  const replace = options.replace ?? "<replacement>";
  const byFile = new Map<string, number>();
  for (const result of results) byFile.set(result.file, (byFile.get(result.file) ?? 0) + 1);
  const edits = [...byFile.entries()].map(([file, count]) => ({
    file,
    ...multieditFindForSearch(options),
    replace,
    replaceAll: true,
    expectCount: count,
  }));
  return { edits, count: edits.length, replace, truncated };
}

function multieditFindForSearch(options: SearchTextOptions): JsonRecord {
  if (options.regex) {
    return {
      findRegex: options.query,
      ...(options.caseSensitive ? {} : { flags: "i" }),
    };
  }
  if (options.caseSensitive) return { findExact: options.query };
  return { findRegex: escapeRegExp(options.query), flags: "i" };
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
      if (DEFAULT_SEARCH_EXCLUDES.has(entry.name)) continue;
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
  const path = relative(process.cwd(), filePath) || basename(filePath);
  const contextRange: LineRange = {
    start: Math.max(1, range.line - context),
    end: Math.min(lines.length, range.endLine + context),
  };
  const candidate: SearchCandidate = {
    id: `text_${index}`,
    file: filePath,
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
    next: [
      { tool: "inspect_range", cliCommand: "inspect-range", arguments: { file: filePath, lines: range.lineRange, context: context > 0 ? context : 3 } },
      { tool: "edit", arguments: { file: filePath, findLines: range.lineRange, replace: "<replacement including trailing newline>" } },
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
    output.push({ number: line, text: lines[line - 1] ?? "" });
  }
  return output;
}

function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
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
  const cwdRelative = relative(process.cwd(), filePath).split("\\").join("/");
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
