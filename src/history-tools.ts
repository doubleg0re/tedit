import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseLineRange } from "./base-edit.js";
import { fail } from "./errors.js";

type JsonRecord = Record<string, unknown>;

type HistoryTraceOptions = {
  lines?: string;
  contains?: string;
  regex?: string;
  limit?: number;
};

type GitCommit = {
  commit: string;
  date?: string;
  author?: string;
  subject?: string;
};

type BlameEntry = GitCommit & {
  lines: number[];
  lineCount: number;
};

export function historyTrace(filePath: string, options: HistoryTraceOptions = {}): JsonRecord {
  const resolvedFile = resolve(filePath);
  const file = existsSync(resolvedFile) ? realpathSync(resolvedFile) : resolvedFile;
  const repoRoot = gitRootForFile(file);
  const repoPath = relative(repoRoot, file);
  const limit = options.limit ?? 10;
  const mode = traceMode(options);
  const target = targetForOptions(file, repoPath, options, mode);
  const commands = commandsForTarget(repoRoot, repoPath, options, limit, mode);
  const commits = commitsForTarget(repoRoot, repoPath, options, limit, mode);
  const blame = mode === "lines" && options.lines ? blameForLines(repoRoot, repoPath, options.lines) : [];
  const latest = latestEvent(commits, blame);

  return {
    success: true,
    kind: "history-trace",
    file,
    target,
    git: { repoRoot, path: repoPath },
    latest,
    commits,
    blame,
    commands,
    next: [
      ...(mode === "lines" ? [{ tool: "inspect_range", cliCommand: "inspect-range", arguments: { file, lines: options.lines, context: 3 } }] : []),
      { tool: "git", command: commands.log },
    ],
  };
}

function traceMode(options: HistoryTraceOptions): "lines" | "contains" | "regex" | "file" {
  const count = [options.lines, options.contains, options.regex].filter((value) => value !== undefined).length;
  if (count > 1) fail("INVALID_HISTORY_TRACE", "history-trace accepts only one of lines, contains, or regex.");
  if (options.lines) return "lines";
  if (options.contains) return "contains";
  if (options.regex) return "regex";
  return "file";
}

function targetForOptions(file: string, repoPath: string, options: HistoryTraceOptions, mode: string): JsonRecord {
  if (mode === "lines" && options.lines) {
    const range = parseLineRange(options.lines);
    return {
      type: "lines",
      file,
      path: repoPath,
      lines: options.lines,
      range,
      preview: linePreview(file, range.start, range.end),
    };
  }
  if (mode === "contains") return { type: "contains", file, path: repoPath, contains: options.contains };
  if (mode === "regex") return { type: "regex", file, path: repoPath, regex: options.regex };
  return { type: "file", file, path: repoPath };
}

function commitsForTarget(repoRoot: string, repoPath: string, options: HistoryTraceOptions, limit: number, mode: string): GitCommit[] {
  if (mode === "lines" && options.lines) {
    const range = parseLineRange(options.lines);
    return parseCommitLog(runGit(repoRoot, [
      "log",
      "--date=iso-strict",
      "--format=%H%x09%aI%x09%an%x09%s",
      "-n",
      String(limit),
      "-L",
      `${range.start},${range.end}:${repoPath}`,
    ], true));
  }
  if (mode === "contains" && options.contains) {
    return parseCommitLog(runGit(repoRoot, [
      "log",
      "--date=iso-strict",
      "--format=%H%x09%aI%x09%an%x09%s",
      "-n",
      String(limit),
      "-S",
      options.contains,
      "--",
      repoPath,
    ], true));
  }
  if (mode === "regex" && options.regex) {
    return parseCommitLog(runGit(repoRoot, [
      "log",
      "--date=iso-strict",
      "--format=%H%x09%aI%x09%an%x09%s",
      "-n",
      String(limit),
      "-G",
      options.regex,
      "--",
      repoPath,
    ], true));
  }
  return parseCommitLog(runGit(repoRoot, [
    "log",
    "--date=iso-strict",
    "--format=%H%x09%aI%x09%an%x09%s",
    "-n",
    String(limit),
    "--",
    repoPath,
  ], true));
}

function blameForLines(repoRoot: string, repoPath: string, lines: string): BlameEntry[] {
  const range = parseLineRange(lines);
  const output = runGit(repoRoot, ["blame", "--line-porcelain", "-L", `${range.start},${range.end}`, "--", repoPath], true);
  const byCommit = new Map<string, BlameEntry>();
  let current: Partial<BlameEntry> & { commit?: string; line?: number } = {};

  for (const line of output.split(/\r?\n/)) {
    const header = line.match(/^([0-9a-f]{40}|0{40})\s+\d+\s+(\d+)/);
    if (header) {
      current = { commit: header[1], line: Number(header[2]) };
      continue;
    }
    if (!current.commit) continue;
    if (line.startsWith("author ")) current.author = line.slice("author ".length);
    else if (line.startsWith("author-time ")) current.date = new Date(Number(line.slice("author-time ".length)) * 1000).toISOString();
    else if (line.startsWith("summary ")) current.subject = line.slice("summary ".length);
    else if (line.startsWith("\t")) {
      const existing = byCommit.get(current.commit) ?? {
        commit: current.commit,
        ...(current.date ? { date: current.date } : {}),
        ...(current.author ? { author: current.author } : {}),
        ...(current.subject ? { subject: current.subject } : {}),
        lines: [],
        lineCount: 0,
      };
      if (current.line) existing.lines.push(current.line);
      existing.lineCount = existing.lines.length;
      byCommit.set(current.commit, existing);
    }
  }

  return [...byCommit.values()].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

function commandsForTarget(repoRoot: string, repoPath: string, options: HistoryTraceOptions, limit: number, mode: string): JsonRecord {
  if (mode === "lines" && options.lines) {
    const range = parseLineRange(options.lines);
    return {
      blame: commandString(["git", "-C", repoRoot, "blame", "-L", `${range.start},${range.end}`, "--", repoPath]),
      log: commandString(["git", "-C", repoRoot, "log", "-n", String(limit), "-L", `${range.start},${range.end}:${repoPath}`]),
    };
  }
  if (mode === "contains") {
    return { log: commandString(["git", "-C", repoRoot, "log", "-n", String(limit), "-S", options.contains ?? "", "--", repoPath]) };
  }
  if (mode === "regex") {
    return { log: commandString(["git", "-C", repoRoot, "log", "-n", String(limit), "-G", options.regex ?? "", "--", repoPath]) };
  }
  return { log: commandString(["git", "-C", repoRoot, "log", "-n", String(limit), "--", repoPath]) };
}

function latestEvent(commits: GitCommit[], blame: BlameEntry[]): GitCommit | undefined {
  const events = [...commits, ...blame].filter((event) => event.date);
  events.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return events[0] ?? commits[0] ?? blame[0];
}

function parseCommitLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{40})\t([^\t]*)\t([^\t]*)\t(.*)$/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    commits.push({
      commit: match[1],
      date: match[2],
      author: match[3],
      subject: match[4],
    });
  }
  return commits;
}

function gitRootForFile(file: string): string {
  const cwd = existsSync(file) ? dirname(file) : process.cwd();
  const root = runGit(cwd, ["rev-parse", "--show-toplevel"], false).trim();
  if (!root) fail("NOT_GIT_REPOSITORY", "history-trace requires a git repository.");
  return existsSync(root) ? realpathSync(root) : root;
}

function runGit(cwd: string, args: string[], allowEmpty: boolean): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowEmpty) return "";
    fail("GIT_COMMAND_FAILED", error instanceof Error ? error.message : String(error), { command: commandString(["git", "-C", cwd, ...args]) });
  }
}

function linePreview(file: string, start: number, end: number): Array<{ number: number; text: string }> {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const output: Array<{ number: number; text: string }> = [];
  for (let line = start; line <= Math.min(end, lines.length); line++) output.push({ number: line, text: lines[line - 1] ?? "" });
  return output;
}

function commandString(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined).map((part) => part.match(/^[A-Za-z0-9_./:=-]+$/) ? part : JSON.stringify(part)).join(" ");
}
