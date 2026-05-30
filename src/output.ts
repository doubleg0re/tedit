import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { loadQualityConfig } from "./quality.js";

export type OutputMode = "compact" | "detailed";
export type DiffMode = "off" | "stats" | "auto" | "full";

export type OutputOptions = {
  mode?: OutputMode;
  includeDiffs?: boolean;
  includeDetails?: boolean;
  diffMode?: DiffMode;
  inlineDiffMaxBytes?: number;
  inlineDiffMaxHunks?: number;
  diffArtifactDir?: string;
  diffArtifacts?: boolean;
};

type JsonRecord = Record<string, unknown>;

type AgentFileChange = "created" | "modified" | "deleted" | "unchanged";

type AgentFileSummary = {
  file: string;
  path: string;
  change: AgentFileChange;
  persisted: boolean;
  changed?: boolean;
  written?: boolean;
  deleted?: boolean;
  parse_verified?: boolean;
  parser?: string;
  parse_skipped?: boolean;
  parse_skip_reason?: string;
  diffAvailable?: boolean;
  hunks?: number;
  bytesDelta?: number;
  backup?: string;
  warnings?: unknown[];
};

type DiffStats = {
  hunks: number;
  bytesDelta: number;
  bytes: number;
};

type DiffPayload = {
  mode: "stats" | "inline" | "artifact" | "truncated" | "full";
  bytes: number;
  hunks: number;
  bytesDelta?: number;
  preview?: string;
  text?: string;
  path?: string;
  relPath?: string;
  truncated?: boolean;
  artifactError?: string;
};

const DEFAULT_DIFF_MODE: DiffMode = "auto";
const DEFAULT_INLINE_DIFF_MAX_BYTES = 8_000;
const DEFAULT_INLINE_DIFF_MAX_HUNKS = 10;
const DEFAULT_DIFF_ARTIFACT_DIR = ".tedit-cache/diffs";
const ARTIFACT_PREVIEW_MAX_BYTES = 2_000;

export function parseOutputMode(value: unknown, label = "output"): OutputMode | undefined {
  if (value === undefined || value === false) return undefined;
  const text = String(value);
  if (text === "compact" || text === "detailed") return text;
  throw new Error(`${label} must be compact or detailed.`);
}

export function parseDiffMode(value: unknown, label = "diffMode"): DiffMode | undefined {
  if (value === undefined || value === false) return undefined;
  const text = String(value);
  if (text === "off" || text === "stats" || text === "auto" || text === "full") return text;
  throw new Error(`${label} must be off, stats, auto, or full.`);
}

export function outputOptionsFromConfig(filePath?: string): OutputOptions {
  const config = loadQualityConfig(filePath);
  return {
    diffMode: config.diffMode,
    inlineDiffMaxBytes: config.inlineDiffMaxBytes,
    inlineDiffMaxHunks: config.inlineDiffMaxHunks,
    diffArtifactDir: config.diffArtifactDir,
    ...(config.diffArtifacts === undefined ? {} : { diffArtifacts: config.diffArtifacts }),
  };
}

export function outputOptionsFromRecord(record: JsonRecord): OutputOptions {
  const base = outputOptionsFromConfig(outputConfigSearchPath(record));
  return {
    ...base,
    mode: parseOutputMode(record.output, "output"),
    includeDiffs: booleanValue(record.includeDiffs ?? record.include_diffs ?? record["include-diffs"]),
    includeDetails: booleanValue(record.includeDetails ?? record.include_details ?? record["include-details"]),
    diffMode: parseDiffMode(pick(record, "diffMode", "diff_mode", "diff-mode"), "diffMode") ?? base.diffMode,
    inlineDiffMaxBytes: positiveInteger(pick(record, "inlineDiffMaxBytes", "inline_diff_max_bytes", "inline-diff-max-bytes"), base.inlineDiffMaxBytes),
    inlineDiffMaxHunks: positiveInteger(pick(record, "inlineDiffMaxHunks", "inline_diff_max_hunks", "inline-diff-max-hunks"), base.inlineDiffMaxHunks),
    diffArtifactDir: stringValue(pick(record, "diffArtifactDir", "diff_artifact_dir", "diff-artifact-dir")) ?? base.diffArtifactDir,
    diffArtifacts: optionalBoolean(pick(record, "diffArtifacts", "diff_artifacts", "diff-artifacts"), base.diffArtifacts),
  };
}

export function formatAgentResult(result: unknown, options: OutputOptions = {}): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as JsonRecord;
  if (options.mode === "detailed" || options.includeDetails) return detailedAgentResult(record, options);
  return compactAgentResult(record, options);
}

export function detailedAgentResult(record: JsonRecord, options: OutputOptions = {}): JsonRecord {
  const files = agentFilesFromRecord(record);
  const next = agentNextSteps(record, files, options);
  const nextRecord: JsonRecord = {
    ...record,
    ok: record.success !== false,
    summary: agentSummary(record, files),
  };
  if (Array.isArray(record.files)) nextRecord.files = enrichAgentFiles(record.files, record, { mode: "detailed", includeDiffs: true });
  else if (files.length > 0) nextRecord.files = files;
  if (next.length > 0) nextRecord.next = next;
  else delete nextRecord.next;
  if (options.includeDiffs) nextRecord.diffs = collectDiffs(record);
  return nextRecord;
}

export function compactAgentResult(record: JsonRecord, options: OutputOptions = {}): JsonRecord {
  const files = agentFilesFromRecord(record);
  if (record.success === false) return compactErrorResult(record, files, options);
  const kind = compactResultKind(record, files);
  if (kind !== "mutation") return compactPayloadResult(record, kind);
  return compactMutationResult(record, files, options);
}

function compactMutationResult(record: JsonRecord, files: AgentFileSummary[], options: OutputOptions): JsonRecord {
  const next = agentNextSteps(record, files, options);
  const compact: JsonRecord = {
    ok: true,
    kind: "mutation",
    summary: agentSummary(record, files),
  };

  if (files.length > 0) {
    compact.changedCount = countFiles(files, (file) => file.changed === true);
    compact.writtenCount = countFiles(files, (file) => file.written === true);
    compact.files = compactFiles(record, options);
  }

  if (files.length === 1) {
    compact.path = files[0].path;
    if (files[0].parse_verified !== undefined) compact.parse_verified = files[0].parse_verified;
    if (files[0].parser) compact.parser = files[0].parser;
    if (files[0].parse_skipped !== undefined) compact.parse_skipped = files[0].parse_skipped;
    if (files[0].parse_skip_reason) compact.parse_skip_reason = files[0].parse_skip_reason;
  }
  const warnings = collectWarnings(record, files);
  if (warnings.length > 0) compact.warnings = warnings;
  const guardrails = collectGuardrails(record);
  if (guardrails.length > 0) compact.guardrails = guardrails;
  if (typeof record.plan === "string") compact.plan = record.plan;
  if (next.length > 0) compact.next = next;
  if (effectiveDiffMode(options) === "full" && options.includeDiffs) compact.diffs = collectDiffs(record);
  return compact;
}

function compactErrorResult(record: JsonRecord, files: AgentFileSummary[], options: OutputOptions): JsonRecord {
  const next = agentNextSteps(record, files, options);
  const compact: JsonRecord = {
    ok: false,
    kind: "error",
    summary: agentSummary(record, files),
  };
  if (typeof record.code === "string") compact.code = record.code;
  if (typeof record.error === "string") compact.error = record.error;
  if (options.includeDetails && record.details !== undefined) compact.details = record.details;
  if (next.length > 0) compact.next = next;
  return compact;
}

function compactPayloadResult(record: JsonRecord, kind: string): JsonRecord {
  const compact: JsonRecord = {
    ok: true,
    kind,
    summary: payloadSummary(record, kind),
  };

  if (kind === "find" && Array.isArray(record.matches)) {
    compact.matches = record.matches;
    return compact;
  }
  if (kind === "inspect-range") {
    copyKeys(record, compact, ["file", "requested", "expanded", "byteRange", "lines", "parse_verified", "parser", "parse_skipped", "parse_skip_reason", "suggested", "next"]);
    if (typeof record.file === "string") compact.path = record.file;
    return compact;
  }
  if (kind === "search-text") {
    copyKeys(record, compact, ["query", "regex", "paths", "glob", "context", "multiedit", "results", "count", "truncated"]);
    return compact;
  }
  if (kind === "history-trace") {
    copyKeys(record, compact, ["file", "target", "git", "latest", "commits", "blame", "commands", "next"]);
    if (typeof record.file === "string") compact.path = record.file;
    return compact;
  }
  if (kind === "templates") {
    copyKeys(record, compact, ["cwd", "templates", "count"]);
    return compact;
  }
  if (kind === "inspect" && record.node !== undefined) {
    compact.node = record.node;
    return compact;
  }
  if (kind === "verify-file") {
    if (typeof record.file === "string") compact.path = record.file;
    const { success: _success, file: _file, summary: _summary, warnings: _warnings, ...payload } = record;
    Object.assign(compact, payload);
    if (Array.isArray(record.warnings) && record.warnings.length > 0) compact.warnings = record.warnings;
    return compact;
  }
  if (kind === "actions") {
    if (typeof record.file === "string") compact.path = record.file;
    copyKeys(record, compact, ["tools", "advanced_tools", "profiles", "rules", "actions", "guidance"]);
    return compact;
  }
  if (kind === "rules") {
    copyKeys(record, compact, ["rules"]);
    return compact;
  }
  if (kind === "analyze-state") {
    if (typeof record.file === "string") compact.path = record.file;
    copyKeys(record, compact, ["states_total", "handlers_total", "clusters", "guidance", "ambiguous", "ungrouped"]);
    if (record.summary && typeof record.summary === "object" && !Array.isArray(record.summary)) compact.analysis_summary = record.summary;
    return compact;
  }

  const { success: _success, summary: rawSummary, ...payload } = record;
  return { ...compact, ...(rawSummary === undefined || typeof rawSummary === "string" ? payload : { ...payload, result_summary: rawSummary }) };
}

export function collectDiffs(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectDiffs);
  const record = value as JsonRecord;
  const diffs: string[] = [];
  if (typeof record.diff === "string" && record.diff.length > 0) diffs.push(record.diff);
  if (record.diffs && typeof record.diffs === "object") {
    for (const diff of Object.values(record.diffs as JsonRecord)) {
      if (typeof diff === "string" && diff.length > 0) diffs.push(diff);
    }
  }
  if (Array.isArray(record.files)) diffs.push(...record.files.flatMap(collectDiffs));
  return diffs;
}

function collectWarnings(record: JsonRecord, files: AgentFileSummary[]): unknown[] {
  const warnings = Array.isArray(record.warnings) ? [...record.warnings] : [];
  for (const file of files) {
    if (Array.isArray(file.warnings)) warnings.push(...file.warnings);
  }
  return dedupeWarnings(warnings);
}

function collectGuardrails(record: JsonRecord): unknown[] {
  const guardrails: unknown[] = [];
  if (Array.isArray(record.guardrails)) guardrails.push(...record.guardrails);
  if (Array.isArray(record.results)) {
    for (const result of record.results) {
      if (result && typeof result === "object" && !Array.isArray(result) && Array.isArray((result as JsonRecord).guardrails)) {
        guardrails.push(...(result as { guardrails: unknown[] }).guardrails);
      }
    }
  }
  return dedupeWarnings(guardrails);
}

function dedupeWarnings(warnings: unknown[]): unknown[] {
  const seen = new Set<string>();
  const deduped: unknown[] = [];
  for (const warning of warnings) {
    const key = stableStringify(warning);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(warning);
  }
  return deduped;
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function compactFiles(record: JsonRecord, options: OutputOptions): unknown[] {
  if (Array.isArray(record.files)) return enrichAgentFiles(record.files, record, options);
  const file = compactFileFrom(record, parseByFileMap(record));
  return file ? [compactFileOutputForRecord(record, file, options)] : [];
}

function agentFilesFromRecord(record: JsonRecord): AgentFileSummary[] {
  const parseByFile = parseByFileMap(record);
  const files: AgentFileSummary[] = [];
  if (Array.isArray(record.files)) {
    for (const value of record.files) {
      const file = compactFileFrom(value, parseByFile);
      if (file) files.push(file);
    }
  }
  if (files.length === 0) {
    const file = compactFileFrom(record, parseByFile);
    if (file) files.push(file);
  }
  return files;
}

function enrichAgentFiles(values: unknown[], record: JsonRecord, options: OutputOptions): unknown[] {
  const parseByFile = parseByFileMap(record);
  return values.map((value) => {
    const file = compactFileFrom(value, parseByFile);
    if (!file) return value;
    if (options.mode === "detailed" || options.includeDetails) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return file;
      return { ...(value as JsonRecord), ...file };
    }
    return compactFileOutputForRecord(value, file, options);
  });
}

function compactFileOutput(file: AgentFileSummary): Omit<AgentFileSummary, "file" | "changed" | "written" | "deleted"> {
  const { file: _file, changed: _changed, written: _written, deleted: _deleted, ...output } = file;
  return output;
}

function compactFileOutputForRecord(value: unknown, file: AgentFileSummary, options: OutputOptions): JsonRecord {
  const output = compactFileOutput(file) as JsonRecord;
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  const record = value as JsonRecord;
  const diff = typeof record.diff === "string" && record.diff.length > 0 ? record.diff : undefined;
  const diffPayload = diff ? diffPayloadForFile(diff, file, options) : undefined;
  if (diffPayload) output.diff = diffPayload;
  return output;
}

function compactFileFrom(value: unknown, parseByFile: Map<string, Partial<AgentFileSummary>>): AgentFileSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  if (typeof record.file !== "string") return null;
  const parse = parseByFile.get(record.file) ?? {};
  const diff = typeof record.diff === "string" ? record.diff : undefined;
  const stats = diff ? diffStats(diff) : {};
  const changed = typeof record.changed === "boolean" ? record.changed : diff ? diff.length > 0 : undefined;
  const deleted = record.deleted === true;
  return {
    file: record.file,
    path: record.file,
    change: changeKind(record, changed, deleted),
    persisted: record.written === true,
    ...(typeof changed === "boolean" ? { changed } : {}),
    ...(typeof record.written === "boolean" ? { written: record.written } : {}),
    ...(deleted ? { deleted: true } : {}),
    ...(typeof record.parse_verified === "boolean" ? { parse_verified: record.parse_verified } : {}),
    ...(typeof record.parser === "string" ? { parser: record.parser } : {}),
    ...(typeof record.parse_skipped === "boolean" ? { parse_skipped: record.parse_skipped } : {}),
    ...(typeof record.parse_skip_reason === "string" ? { parse_skip_reason: record.parse_skip_reason } : {}),
    ...parse,
    ...(diff && diff.length > 0 ? { diffAvailable: true } : {}),
    ...stats,
    ...(typeof record.backup === "string" ? { backup: record.backup } : {}),
    ...(Array.isArray(record.warnings) && record.warnings.length > 0 ? { warnings: record.warnings } : {}),
  };
}

function parseByFileMap(record: JsonRecord): Map<string, Partial<AgentFileSummary>> {
  const map = new Map<string, Partial<AgentFileSummary>>();
  if (Array.isArray(record.parse)) {
    for (const value of record.parse) {
      const file = compactFileFrom(value, new Map());
      if (file) map.set(file.file, parseFields(file));
    }
  }
  if (typeof record.file === "string" && (typeof record.parse_verified === "boolean" || typeof record.parser === "string" || typeof record.parse_skipped === "boolean")) {
    map.set(record.file, {
      ...(typeof record.parse_verified === "boolean" ? { parse_verified: record.parse_verified } : {}),
      ...(typeof record.parser === "string" ? { parser: record.parser } : {}),
      ...(typeof record.parse_skipped === "boolean" ? { parse_skipped: record.parse_skipped } : {}),
      ...(typeof record.parse_skip_reason === "string" ? { parse_skip_reason: record.parse_skip_reason } : {}),
    });
  }
  return map;
}

function parseFields(file: AgentFileSummary): Partial<AgentFileSummary> {
  return {
    ...(file.parse_verified === undefined ? {} : { parse_verified: file.parse_verified }),
    ...(file.parser ? { parser: file.parser } : {}),
    ...(file.parse_skipped === undefined ? {} : { parse_skipped: file.parse_skipped }),
    ...(file.parse_skip_reason ? { parse_skip_reason: file.parse_skip_reason } : {}),
  };
}

function compactResultKind(record: JsonRecord, files: AgentFileSummary[]): string {
  if (isMutationResult(record, files)) return "mutation";
  if (typeof record.kind === "string") return record.kind;
  if (Array.isArray(record.matches)) return "find";
  if (record.node !== undefined) return "inspect";
  if (typeof record.parse_verified === "boolean" && typeof record.file === "string") return "verify-file";
  if (typeof record.states_total === "number" && Array.isArray(record.clusters)) return "analyze-state";
  if (Array.isArray(record.actions) && Array.isArray(record.rules)) return "actions";
  if (Array.isArray(record.rules)) return "rules";
  if (Array.isArray(record.results) && record.vars && typeof record.vars === "object") return "workflow";
  return "result";
}

function isMutationResult(record: JsonRecord, files: AgentFileSummary[]): boolean {
  if (typeof record.changed === "boolean" || typeof record.written === "boolean") return true;
  if (typeof record.diff === "string" && record.diff.length > 0) return true;
  return files.some((file) => file.changed !== undefined || file.written !== undefined || file.deleted || file.diffAvailable);
}

function payloadSummary(record: JsonRecord, kind: string): string {
  if (typeof record.summary === "string") return record.summary;
  if (kind === "find" && Array.isArray(record.matches)) return String(record.matches.length) + " " + plural("match", record.matches.length);
  if (kind === "inspect-range" && Array.isArray(record.lines)) return String(record.lines.length) + " " + plural("line", record.lines.length);
  if (kind === "search-text" && Array.isArray(record.results)) return String(record.results.length) + " text " + plural("match", record.results.length);
  if (kind === "history-trace" && Array.isArray(record.commits)) return String(record.commits.length) + " history " + plural("commit", record.commits.length);
  if (kind === "templates" && Array.isArray(record.templates)) return String(record.templates.length) + " " + plural("template", record.templates.length);
  if (kind === "scan-strings" && Array.isArray(record.strings)) return String(record.strings.length) + " string " + plural("candidate", record.strings.length);
  if (kind === "ast-select" && Array.isArray(record.matches)) return String(record.matches.length) + " AST " + plural("match", record.matches.length);
  if (kind === "inspect") return "node inspected";
  if (kind === "verify-file") return parseResultSummary(record);
  if (kind === "actions" && Array.isArray(record.actions)) return String(record.actions.length) + " " + plural("action", record.actions.length) + " available";
  if (kind === "rules" && Array.isArray(record.rules)) return String(record.rules.length) + " " + plural("rule", record.rules.length) + " available";
  if (kind === "analyze-state") {
    const states = typeof record.states_total === "number" ? record.states_total : 0;
    const handlers = typeof record.handlers_total === "number" ? record.handlers_total : 0;
    return String(states) + " " + plural("state", states) + ", " + String(handlers) + " " + plural("handler", handlers);
  }
  if (kind === "workflow" && Array.isArray(record.results)) return String(record.results.length) + " workflow " + plural("step", record.results.length) + " completed";
  return "operation succeeded";
}

function parseResultSummary(record: JsonRecord): string {
  if (record.parse_verified === true) {
    return typeof record.parser === "string" ? "parse verified with " + record.parser : "parse verified";
  }
  if (record.parse_skipped === true) {
    return typeof record.parse_skip_reason === "string" ? "parse skipped (" + record.parse_skip_reason + ")" : "parse skipped";
  }
  return "parse not verified";
}

function copyKeys(source: JsonRecord, target: JsonRecord, keys: string[]): void {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

function changeKind(record: JsonRecord, changed: boolean | undefined, deleted: boolean): AgentFileSummary["change"] {
  if (deleted) return "deleted";
  if (changed !== true) return "unchanged";
  if (record.existed === false) return "created";
  return "modified";
}

function countFiles(files: AgentFileSummary[], predicate: (file: AgentFileSummary) => boolean): number {
  return files.filter(predicate).length;
}

function diffStats(diff: string): Pick<AgentFileSummary, "hunks" | "bytesDelta"> {
  const stats = fullDiffStats(diff);
  return {
    ...(stats.hunks > 0 ? { hunks: stats.hunks } : {}),
    ...(stats.bytesDelta !== 0 ? { bytesDelta: stats.bytesDelta } : {}),
  };
}

function fullDiffStats(diff: string): DiffStats {
  let hunks = 0;
  let bytesDelta = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) hunks++;
    else if (line.startsWith("+") && !line.startsWith("+++")) bytesDelta += line.length;
    else if (line.startsWith("-") && !line.startsWith("---")) bytesDelta -= line.length;
  }
  return { hunks, bytesDelta, bytes: Buffer.byteLength(diff, "utf8") };
}

function diffPayloadForFile(diff: string, file: AgentFileSummary, options: OutputOptions): DiffPayload | undefined {
  const mode = effectiveDiffMode(options);
  if (mode === "off") return undefined;
  const stats = fullDiffStats(diff);
  const base = diffPayloadBase(mode === "auto" ? "stats" : mode, stats);
  if (mode === "stats") return base;
  if (mode === "full") return { ...base, mode: "full", text: diff };

  const inlineMaxBytes = outputPositive(options.inlineDiffMaxBytes, DEFAULT_INLINE_DIFF_MAX_BYTES);
  const inlineMaxHunks = outputPositive(options.inlineDiffMaxHunks, DEFAULT_INLINE_DIFF_MAX_HUNKS);
  if (stats.bytes <= inlineMaxBytes && stats.hunks <= inlineMaxHunks) {
    return { ...base, mode: "inline", preview: diff };
  }

  const preview = previewDiff(diff, Math.min(inlineMaxBytes, ARTIFACT_PREVIEW_MAX_BYTES));
  const artifactAllowed = file.written === true || options.diffArtifacts === true;
  if (!artifactAllowed) return { ...base, mode: "truncated", preview, truncated: true };
  if (options.diffArtifacts === false) return { ...base, mode: "truncated", preview, truncated: true };

  const artifact = writeDiffArtifact(diff, file, options);
  if (artifact.ok) {
    return {
      ...base,
      mode: "artifact",
      path: artifact.path,
      relPath: artifact.relPath,
      preview,
      truncated: true,
    };
  }
  return { ...base, mode: "truncated", preview, truncated: true, artifactError: artifact.error };
}

function diffPayloadBase(mode: DiffPayload["mode"], stats: DiffStats): DiffPayload {
  return {
    mode,
    bytes: stats.bytes,
    hunks: stats.hunks,
    ...(stats.bytesDelta !== 0 ? { bytesDelta: stats.bytesDelta } : {}),
  };
}

function effectiveDiffMode(options: OutputOptions): DiffMode {
  return options.diffMode ?? DEFAULT_DIFF_MODE;
}

function writeDiffArtifact(diff: string, file: AgentFileSummary, options: OutputOptions): { ok: true; path: string; relPath: string } | { ok: false; error: string } {
  try {
    const cwd = process.cwd();
    const dirInput = options.diffArtifactDir ?? DEFAULT_DIFF_ARTIFACT_DIR;
    const artifactDir = resolveArtifactDir(cwd, dirInput);
    const hash = createHash("sha256").update(file.path).update("\0").update(diff).digest("hex").slice(0, 16);
    const safeBase = sanitizeArtifactName(basename(file.path) || "diff");
    const artifactPath = resolve(artifactDir, `${safeBase}-${hash}.diff`);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(artifactPath, diff);
    return { ok: true, path: artifactPath, relPath: relative(cwd, artifactPath) || basename(artifactPath) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveArtifactDir(cwd: string, dirInput: string): string {
  const resolved = isAbsolute(dirInput) ? resolve(dirInput) : resolve(cwd, dirInput);
  const relativePath = relative(cwd, resolved);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("diffArtifactDir must stay inside the current working directory.");
  }
  return resolved;
}

function sanitizeArtifactName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "diff").slice(0, 80);
}

function previewDiff(diff: string, maxBytes: number): string {
  const limit = Math.max(1, maxBytes);
  if (Buffer.byteLength(diff, "utf8") <= limit) return diff;
  let bytes = 0;
  const lines: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    const nextBytes = Buffer.byteLength(line + "\n", "utf8");
    if (bytes + nextBytes > limit) break;
    lines.push(line);
    bytes += nextBytes;
  }
  const preview = lines.length > 0 ? lines.join("\n") + "\n" : diff.slice(0, limit);
  return preview + "... diff truncated ...";
}

function agentSummary(record: JsonRecord, files: AgentFileSummary[]): string {
  if (record.success === false) return typeof record.error === "string" ? record.error : "operation failed";
  if (files.length === 0) return "operation succeeded";
  const changed = files.filter((file) => file.changed).length;
  const written = files.filter((file) => file.written).length;
  const suffix = parseSummarySuffix(files);
  if (written > 0) return String(written) + " " + plural("file", written) + " written" + suffix;
  if (changed > 0) return String(changed) + " " + plural("file", changed) + " would change" + suffix;
  return "no file changes" + suffix;
}

function parseSummarySuffix(files: AgentFileSummary[]): string {
  const verified = files.filter((file) => file.parse_verified);
  const skipped = files.filter((file) => file.parse_skipped);
  if (verified.length > 0 && skipped.length > 0) return "; parse verified/skipped";
  if (verified.length > 0) {
    const parsers = [...new Set(verified.map((file) => file.parser).filter((parser): parser is string => Boolean(parser)))];
    if (parsers.length === 1) return "; parse verified with " + parsers[0];
    return "; parse verified";
  }

  if (skipped.length === 0 || skipped.length !== files.length) return "";
  const reasons = [...new Set(skipped.map((file) => file.parse_skip_reason).filter((reason): reason is string => Boolean(reason)))];
  return reasons.length === 1 ? "; parse skipped (" + reasons[0] + ")" : "; parse skipped";
}

function agentNextSteps(record: JsonRecord, files: AgentFileSummary[], options: OutputOptions): string[] {
  const explicit = Array.isArray(record.next) && record.next.every((item) => typeof item === "string")
    ? record.next as string[]
    : [];
  return [...new Set([...explicit, ...deterministicNextSteps(files, options)])].slice(0, 3);
}

function deterministicNextSteps(files: AgentFileSummary[], options: OutputOptions): string[] {
  const steps: string[] = [];
  if (files.some((file) => file.changed && !file.written)) steps.push("rerun with write=true to apply");
  if (options.mode !== "detailed" && !options.includeDetails && effectiveDiffMode(options) === "off" && files.some((file) => file.diffAvailable && file.changed && !file.written)) {
    steps.push("set diffMode=auto or use --diff-out <file> to inspect diffs");
  }
  return steps;
}

function plural(word: string, count: number): string {
  return count === 1 ? word : word + "s";
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}

function optionalBoolean(value: unknown, fallback: boolean | undefined): boolean | undefined {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

function positiveInteger(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function outputPositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}

function pick(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function outputConfigSearchPath(record: JsonRecord): string | undefined {
  for (const key of ["file", "from", "to", "path", "plan"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  if (Array.isArray(record.edits)) {
    for (const edit of record.edits) {
      if (edit && typeof edit === "object" && !Array.isArray(edit) && typeof (edit as JsonRecord).file === "string") {
        return (edit as JsonRecord).file as string;
      }
    }
  }
  return undefined;
}
