export type OutputMode = "compact" | "detailed";

export type OutputOptions = {
  mode?: OutputMode;
  includeDiffs?: boolean;
  includeDetails?: boolean;
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
  if (typeof record.plan === "string") compact.plan = record.plan;
  if (next.length > 0) compact.next = next;
  if (options.includeDiffs) compact.diffs = collectDiffs(record);
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
  if (kind === "inspect" && record.node !== undefined) {
    compact.node = record.node;
    return compact;
  }
  if (kind === "verify-file") {
    if (typeof record.file === "string") compact.path = record.file;
    copyKeys(record, compact, ["parse_verified", "parser", "parse_skipped", "parse_skip_reason"]);
    return compact;
  }
  if (kind === "actions") {
    if (typeof record.file === "string") compact.path = record.file;
    copyKeys(record, compact, ["tools", "rules", "actions", "guidance"]);
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

function compactFiles(record: JsonRecord, options: OutputOptions): unknown[] {
  if (Array.isArray(record.files)) return enrichAgentFiles(record.files, record, options);
  return agentFilesFromRecord(record).map(compactFileOutput);
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
      ? { ...compactFileOutput(file), diff: (value as JsonRecord).diff }
      : compactFileOutput(file);
  });
}

function compactFileOutput(file: AgentFileSummary): Omit<AgentFileSummary, "file" | "changed" | "written" | "deleted"> {
  const { file: _file, changed: _changed, written: _written, deleted: _deleted, ...output } = file;
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
  if (Array.isArray(record.matches)) return "find";
  if (record.node !== undefined) return "inspect";
  if (typeof record.parse_verified === "boolean" && typeof record.file === "string") return "verify-file";
  if (typeof record.states_total === "number" && Array.isArray(record.clusters)) return "analyze-state";
  if (Array.isArray(record.actions) && Array.isArray(record.rules)) return "actions";
  if (Array.isArray(record.rules)) return "rules";
  if (Array.isArray(record.results) && record.vars && typeof record.vars === "object") return "workflow";
  if (typeof record.kind === "string") return record.kind;
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

function agentNextSteps(record: JsonRecord, files: AgentFileSummary[], options: OutputOptions): string[] {
  const explicit = Array.isArray(record.next) && record.next.every((item) => typeof item === "string")
    ? record.next as string[]
    : [];
  return [...new Set([...explicit, ...deterministicNextSteps(files, options)])].slice(0, 3);
}

function deterministicNextSteps(files: AgentFileSummary[], options: OutputOptions): string[] {
  const steps: string[] = [];
  if (files.some((file) => file.changed && !file.written)) steps.push("rerun with write=true to apply");
  if (options.mode !== "detailed" && !options.includeDetails && !options.includeDiffs && files.some((file) => file.diffAvailable && file.changed && !file.written)) {
    steps.push("add --include-diffs to inline diffs or --diff-out <file> to save them");
  }
  return steps;
}

function plural(word: string, count: number): string {
  return count === 1 ? word : word + "s";
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}
