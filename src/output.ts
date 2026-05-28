export type OutputMode = "compact" | "detailed";

export type OutputOptions = {
  mode?: OutputMode;
  includeDiffs?: boolean;
  includeDetails?: boolean;
};

type JsonRecord = Record<string, unknown>;

type AgentFileSummary = {
  file: string;
  path: string;
  change: "create" | "update" | "delete" | "noop";
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
};

export function parseOutputMode(value: unknown, label = "output"): OutputMode | undefined {
  if (value === undefined || value === false) return undefined;
  const text = String(value);
  if (text === "compact" || text === "detailed") return text;
  throw new Error(`${label} must be compact or detailed.`);
}

export function outputOptionsFromRecord(record: JsonRecord): OutputOptions {
  return {
    mode: parseOutputMode(record.output, "output"),
    includeDiffs: booleanValue(record.includeDiffs ?? record.include_diffs ?? record["include-diffs"]),
    includeDetails: booleanValue(record.includeDetails ?? record.include_details ?? record["include-details"]),
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
  const next = agentNextSteps(record, files);
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
  const next = agentNextSteps(record, files);
  const success = record.success !== false;
  const compact: JsonRecord = {
    success,
    ok: success,
    summary: agentSummary(record, files),
  };

  if (files.length > 0) {
    compact.changed = files.some((file) => file.changed === true);
    compact.written = files.some((file) => file.written === true);
    compact.files = compactFiles(record, options);
  }

  if (typeof record.file === "string") compact.file = record.file;
  if (files.length === 1) {
    compact.path = files[0].path;
    if (files[0].parse_verified !== undefined) compact.parse_verified = files[0].parse_verified;
    if (files[0].parser) compact.parser = files[0].parser;
    if (files[0].parse_skipped !== undefined) compact.parse_skipped = files[0].parse_skipped;
    if (files[0].parse_skip_reason) compact.parse_skip_reason = files[0].parse_skip_reason;
  }
  if (typeof record.plan === "string") compact.plan = record.plan;
  if (!success) {
    if (typeof record.code === "string") compact.code = record.code;
    if (typeof record.error === "string") compact.error = record.error;
    if (options.includeDetails && record.details !== undefined) compact.details = record.details;
  }
  if (next.length > 0) compact.next = next;
  if (options.includeDiffs) compact.diffs = collectDiffs(record);
  return compact;
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

function compactFiles(record: JsonRecord, options: OutputOptions): unknown[] {
  if (Array.isArray(record.files)) return enrichAgentFiles(record.files, record, options);
  return agentFilesFromRecord(record);
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
    return options.includeDiffs && value && typeof value === "object" && !Array.isArray(value) && typeof (value as JsonRecord).diff === "string"
      ? { ...file, diff: (value as JsonRecord).diff }
      : file;
  });
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

function changeKind(record: JsonRecord, changed: boolean | undefined, deleted: boolean): AgentFileSummary["change"] {
  if (deleted) return "delete";
  if (changed !== true) return "noop";
  if (record.existed === false) return "create";
  return "update";
}

function diffStats(diff: string): Pick<AgentFileSummary, "hunks" | "bytesDelta"> {
  let hunks = 0;
  let bytesDelta = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) hunks++;
    else if (line.startsWith("+") && !line.startsWith("+++")) bytesDelta += line.length;
    else if (line.startsWith("-") && !line.startsWith("---")) bytesDelta -= line.length;
  }
  return {
    ...(hunks > 0 ? { hunks } : {}),
    ...(bytesDelta !== 0 ? { bytesDelta } : {}),
  };
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

function agentNextSteps(record: JsonRecord, files: AgentFileSummary[]): string[] {
  const explicit = Array.isArray(record.next) && record.next.every((item) => typeof item === "string")
    ? record.next as string[]
    : [];
  return [...new Set([...explicit, ...deterministicNextSteps(files)])].slice(0, 3);
}

function deterministicNextSteps(files: AgentFileSummary[]): string[] {
  if (files.some((file) => file.changed && !file.written)) return ["rerun with write=true to apply"];
  return [];
}

function plural(word: string, count: number): string {
  return count === 1 ? word : word + "s";
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}
