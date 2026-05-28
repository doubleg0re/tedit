import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseLineRange, planBaseEdit, type BaseEditMutation, type BaseFindStrategy } from "./base-edit.js";
import { parseDocumentForFile } from "./core/registry.js";
import { unifiedDiff } from "./diff.js";
import { fail } from "./errors.js";
import { planExtract, type HelperPolicy } from "./extract.js";
import { runFlow, type FlowStep } from "./flow.js";
import { fileLengthWarnings, type FileLengthWarning } from "./quality.js";
import { maybeWriteBackup, resolveWritePolicy, writePolicyReport, type BackupResult, type WritePolicyFlags } from "./write-policy.js";

export type WorkspaceFlowStep = FlowStep & {
  file?: string;
  from?: string;
  source?: unknown;
  find?: unknown;
  contains?: unknown;
  findExact?: unknown;
  "find-exact"?: unknown;
  findFuzzy?: unknown;
  "find-fuzzy"?: unknown;
  findAnchorAfter?: unknown;
  "find-anchor-after"?: unknown;
  findRegex?: unknown;
  "find-regex"?: unknown;
  findLines?: unknown;
  "find-lines"?: unknown;
  flags?: unknown;
  replace?: unknown;
  insertBefore?: unknown;
  "insert-before"?: unknown;
  insertAfter?: unknown;
  "insert-after"?: unknown;
  delete?: unknown;
  replaceAll?: unknown;
  "replace-all"?: unknown;
  expectCount?: unknown;
  "expect-count"?: unknown;
  selector?: string;
  to?: string;
  export?: "named" | "default";
  exportKind?: "named" | "default";
  slots?: unknown;
  slot?: unknown;
  depth?: unknown;
  autoSlot?: unknown;
  helpers?: HelperPolicy;
  helpersPolicy?: HelperPolicy;
  helper?: unknown;
  helperOverrides?: unknown;
  overwrite?: unknown;
  typecheck?: unknown;
  maxProps?: unknown;
  max_props?: unknown;
  "max-props"?: unknown;
  acceptLargeProps?: unknown;
  accept_large_props?: unknown;
  "accept-large-props"?: unknown;
  steps?: FlowStep[];
  flow?: FlowStep[];
};

export type WorkspaceFileChange = {
  file: string;
  existed: boolean;
  changed: boolean;
  written: boolean;
  deleted?: boolean;
  warnings: FileLengthWarning[];
  write_policy?: Record<string, unknown>;
  backup?: string;
  diff?: string;
};

export type WorkspaceFlowResult = {
  success: true;
  results: Array<{ step: number; action: string; success: true; data?: unknown }>;
  vars: Record<string, unknown>;
  files: WorkspaceFileChange[];
};

export type WorkspaceFlowOptions = {
  params?: Record<string, unknown>;
  write?: boolean;
  dryRun?: boolean;
  backup?: boolean;
  noBackup?: boolean;
};

export type WorkspaceFileUpdate =
  | { file: string; source: string; deleted?: false }
  | { file: string; deleted: true; source?: never };

type WorkspaceFileEntry = {
  file: string;
  existed: boolean;
  original: string;
  next: string;
  deleted: boolean;
};

export function runWorkspaceFlow(steps: WorkspaceFlowStep[], options: WorkspaceFlowOptions = {}): WorkspaceFlowResult {
  if (!Array.isArray(steps)) fail("INVALID_WORKSPACE_FLOW", "Workspace flow must be an array of steps.");

  const tx = new WorkspaceTransaction();
  const vars = new WorkspaceVarStore(options.params ?? {});
  const results: WorkspaceFlowResult["results"] = [];

  steps.forEach((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      fail("INVALID_WORKSPACE_FLOW", `Step ${index}: step must be an object.`);
    }
    if (!step.action && step.comment) return;
    if (!step.action) fail("INVALID_WORKSPACE_FLOW", `Step ${index}: step has no action.`);

    const data = runWorkspaceStep(tx, vars, step, index);
    if (step.out) vars.set(step.out, data);
    vars.set("$ret", data);
    results.push({ step: index, action: step.action, success: true, ...(data === undefined ? {} : { data }) });
  });

  const files = tx.commit({
    write: options.write,
    dryRun: options.dryRun,
    backup: options.backup,
    noBackup: options.noBackup,
  });
  return { success: true, results, vars: vars.snapshot(), files };
}

export function commitWorkspaceUpdates(updates: WorkspaceFileUpdate[], options: WorkspaceFlowOptions = {}): WorkspaceFileChange[] {
  const tx = new WorkspaceTransaction();
  for (const update of updates) {
    if (!update.file) fail("INVALID_WORKSPACE_UPDATE", "Workspace update requires a file path.");
    if (update.deleted) tx.delete(update.file);
    else tx.patch(update.file, update.source);
  }
  return tx.commit({
    write: options.write,
    dryRun: options.dryRun,
    backup: options.backup,
    noBackup: options.noBackup,
  });
}

function runWorkspaceStep(tx: WorkspaceTransaction, vars: WorkspaceVarStore, step: WorkspaceFlowStep, index: number): unknown {
  if (step.action === "extract") return runExtractStep(tx, vars, step, index);
  if (step.action === "create" || step.action === "write") return runWriteStep(tx, vars, step, index);
  if (step.action === "chain") return runNestedFlowStep(tx, vars, step, index);
  if (step.action === "edit") return runBaseEditStep(tx, vars, step, index);
  if (step.file) return runFileScopedStep(tx, vars, step, index);
  fail("INVALID_WORKSPACE_FLOW", `Step ${index}: action "${step.action}" requires "file", or use "extract"/"chain".`);
}

function runWriteStep(tx: WorkspaceTransaction, vars: WorkspaceVarStore, step: WorkspaceFlowStep, index: number): unknown {
  const file = requiredString(vars.resolveValue(step.file), `Step ${index}: ${step.action} requires "file".`);
  const sourceValue = vars.resolveValue(step.source);
  if (typeof sourceValue !== "string") fail("INVALID_WORKSPACE_FLOW", `Step ${index}: ${step.action} requires string "source".`);
  if (step.action === "create" && tx.exists(file)) {
    fail("FILE_EXISTS", `Step ${index}: create refuses to overwrite existing file: ${file}`);
  }
  tx.patch(file, sourceValue);
  return { action: step.action, file, bytes: sourceValue.length };
}

function runBaseEditStep(tx: WorkspaceTransaction, vars: WorkspaceVarStore, step: WorkspaceFlowStep, index: number): unknown {
  const file = requiredString(vars.resolveValue(step.file), `Step ${index}: edit requires "file".`);
  const strategy = resolveBaseFindStrategy(vars, step, index);
  const mutation = resolveBaseMutation(vars, step, index);
  const expectCountValue = vars.resolveValue(step.expectCount ?? step["expect-count"]);
  const expectCount = expectCountValue === undefined ? undefined : Number(expectCountValue);
  if (expectCountValue !== undefined && !Number.isInteger(expectCount)) {
    fail("INVALID_WORKSPACE_FLOW", `Step ${index}: edit expectCount must be an integer.`);
  }

  const plan = planBaseEdit({
    filePath: file,
    source: tx.readExisting(file),
    strategy,
    mutation,
    replaceAll: resolveBoolean(vars.resolveValue(step.replaceAll ?? step["replace-all"])),
    ...(expectCountValue === undefined ? {} : { expectCount }),
  });
  tx.patch(file, plan.nextSource);
  return {
    action: plan.action,
    strategy: plan.strategy,
    changed: plan.changed,
    parse_verified: plan.parseVerified,
    ...(plan.parseVerification.parser ? { parser: plan.parseVerification.parser } : {}),
    matches: plan.matches,
    ...(plan.diff ? { diff: plan.diff } : {}),
  };
}

function runExtractStep(tx: WorkspaceTransaction, vars: WorkspaceVarStore, step: WorkspaceFlowStep, index: number): unknown {
  const from = requiredString(vars.resolveValue(step.from), `Step ${index}: extract requires "from".`);
  const selector = requiredString(vars.resolveValue(step.selector), `Step ${index}: extract requires "selector".`);
  const to = requiredString(vars.resolveValue(step.to), `Step ${index}: extract requires "to".`);
  const name = requiredString(vars.resolveValue(step.name), `Step ${index}: extract requires "name".`);
  const exportKind = (vars.resolveValue(step.exportKind ?? step.export) ?? "named") as "named" | "default";
  const helpersPolicy = (vars.resolveValue(step.helpersPolicy ?? step.helpers) ?? "ask") as HelperPolicy;
  const depthValue = vars.resolveValue(step.depth);
  const depth = depthValue === undefined ? undefined : Number(depthValue);
  const maxPropsValue = vars.resolveValue(step.maxProps ?? step.max_props ?? step["max-props"]);
  const maxProps = maxPropsValue === undefined ? undefined : Number(maxPropsValue);

  if (exportKind !== "named" && exportKind !== "default") {
    fail("INVALID_WORKSPACE_FLOW", `Step ${index}: extract export must be named or default.`);
  }
  if (!["ask", "move", "share", "as-prop"].includes(helpersPolicy)) {
    fail("INVALID_WORKSPACE_FLOW", `Step ${index}: extract helpers must be ask, move, share, or as-prop.`);
  }
  if (depthValue !== undefined && !Number.isInteger(depth)) {
    fail("INVALID_WORKSPACE_FLOW", `Step ${index}: extract depth must be an integer.`);
  }
  if (maxPropsValue !== undefined && !Number.isInteger(maxProps)) {
    fail("INVALID_WORKSPACE_FLOW", `Step ${index}: extract maxProps must be an integer.`);
  }

  const plan = planExtract({
    from,
    selector,
    to,
    name,
    source: tx.readExisting(from),
    destinationExists: tx.exists(to),
    exportKind,
    slots: normalizeSlots(vars.resolveValue(step.slots ?? step.slot)),
    ...(depthValue === undefined ? {} : { depth }),
    autoSlot: resolveBoolean(vars.resolveValue(step.autoSlot)),
    typecheck: resolveBoolean(vars.resolveValue(step.typecheck)),
    helpersPolicy,
    helperOverrides: normalizeStringList(vars.resolveValue(step.helperOverrides ?? step.helper)),
    overwrite: resolveBoolean(vars.resolveValue(step.overwrite)),
    acceptLargeProps: resolveBoolean(vars.resolveValue(step.acceptLargeProps ?? step.accept_large_props ?? step["accept-large-props"])),
    ...(maxPropsValue === undefined ? {} : { maxProps }),
  });

  tx.patch(from, plan.nextSource);
  tx.patch(to, plan.newSource);
  return plan.result;
}

function runNestedFlowStep(tx: WorkspaceTransaction, vars: WorkspaceVarStore, step: WorkspaceFlowStep, index: number): unknown {
  const file = requiredString(vars.resolveValue(step.file), `Step ${index}: chain requires "file".`);
  const nested = step.steps ?? step.flow;
  if (!Array.isArray(nested)) fail("INVALID_WORKSPACE_FLOW", `Step ${index}: chain requires "steps" array.`);

  const doc = parseDocumentForFile(file, tx.readExisting(file));
  const result = runFlow(doc, nested, vars.snapshot());
  tx.patch(file, doc.print());
  vars.merge(result.vars);
  return result;
}

function runFileScopedStep(tx: WorkspaceTransaction, vars: WorkspaceVarStore, step: WorkspaceFlowStep, _index: number): unknown {
  const file = String(vars.resolveValue(step.file));
  const { file: _file, ...flowStep } = step;
  const doc = parseDocumentForFile(file, tx.readExisting(file));
  const result = runFlow(doc, [flowStep], vars.snapshot());
  tx.patch(file, doc.print());
  vars.merge(result.vars);
  return result.results[0]?.data;
}

function resolveBaseFindStrategy(vars: WorkspaceVarStore, step: WorkspaceFlowStep, index: number): BaseFindStrategy {
  const find = vars.resolveValue(step.find);
  const findExact = vars.resolveValue(step.findExact ?? step["find-exact"]);
  const findFuzzy = vars.resolveValue(step.findFuzzy ?? step["find-fuzzy"]);
  const findAnchorAfter = vars.resolveValue(step.findAnchorAfter ?? step["find-anchor-after"]);
  const findRegex = vars.resolveValue(step.findRegex ?? step["find-regex"]);
  const findLines = vars.resolveValue(step.findLines ?? step["find-lines"]);
  const explicitCount = [findExact, findFuzzy, findAnchorAfter, findRegex, findLines].filter((value) => value !== undefined).length;

  if (explicitCount > 1) fail("INVALID_WORKSPACE_FLOW", `Step ${index}: edit accepts only one find strategy.`);
  if (find !== undefined && explicitCount > 0 && findAnchorAfter === undefined) {
    fail("INVALID_WORKSPACE_FLOW", `Step ${index}: edit "find" is exact unless paired with findAnchorAfter.`);
  }

  if (findAnchorAfter !== undefined) {
    const contains = vars.resolveValue(step.contains ?? step.find);
    if (contains === undefined) {
      fail("INVALID_WORKSPACE_FLOW", `Step ${index}: edit findAnchorAfter requires contains or find.`);
    }
    return {
      kind: "anchor",
      after: requiredString(findAnchorAfter, `Step ${index}: edit findAnchorAfter must be a string.`),
      contains: requiredString(contains, `Step ${index}: edit contains/find must be a string.`),
    };
  }
  if (findExact !== undefined) {
    return { kind: "exact", pattern: requiredString(findExact, `Step ${index}: edit findExact must be a string.`) };
  }
  if (findFuzzy !== undefined) {
    return { kind: "fuzzy", pattern: requiredString(findFuzzy, `Step ${index}: edit findFuzzy must be a string.`), ignoreWhitespace: true };
  }
  if (findRegex !== undefined) {
    return {
      kind: "regex",
      pattern: requiredString(findRegex, `Step ${index}: edit findRegex must be a string.`),
      ...(step.flags === undefined ? {} : { flags: String(vars.resolveValue(step.flags)) }),
    };
  }
  if (findLines !== undefined) {
    return { kind: "lines", ...parseLineRange(requiredString(findLines, `Step ${index}: edit findLines must be a string.`)) };
  }
  if (find !== undefined) {
    return { kind: "exact", pattern: requiredString(find, `Step ${index}: edit find must be a string.`) };
  }

  fail("INVALID_WORKSPACE_FLOW", `Step ${index}: edit requires find, findExact, findFuzzy, findAnchorAfter, findRegex, or findLines.`);
}

function resolveBaseMutation(vars: WorkspaceVarStore, step: WorkspaceFlowStep, index: number): BaseEditMutation {
  const replace = vars.resolveValue(step.replace);
  const insertBefore = vars.resolveValue(step.insertBefore ?? step["insert-before"]);
  const insertAfter = vars.resolveValue(step.insertAfter ?? step["insert-after"]);
  const shouldDelete = resolveBoolean(vars.resolveValue(step.delete));
  const count = [replace !== undefined, insertBefore !== undefined, insertAfter !== undefined, shouldDelete].filter(Boolean).length;

  if (count !== 1) {
    fail("INVALID_WORKSPACE_FLOW", `Step ${index}: edit requires exactly one of replace, insertBefore, insertAfter, or delete.`);
  }
  if (replace !== undefined) return { kind: "replace", text: String(replace) };
  if (insertBefore !== undefined) return { kind: "insert-before", text: String(insertBefore) };
  if (insertAfter !== undefined) return { kind: "insert-after", text: String(insertAfter) };
  return { kind: "delete" };
}

function normalizeSlots(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const selector = requiredString((item as { selector?: unknown }).selector, "Slot object requires selector.");
      const prop = (item as { prop?: unknown }).prop;
      return prop === undefined ? `${selector}.children` : `${selector}.children=${String(prop)}`;
    }
    fail("INVALID_WORKSPACE_FLOW", "extract slots must be strings or { selector, prop } objects.");
  });
}

function normalizeStringList(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => String(item));
}

function resolveBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) fail("INVALID_WORKSPACE_FLOW", message);
  return value;
}

class WorkspaceTransaction {
  private files = new Map<string, WorkspaceFileEntry>();

  readExisting(file: string): string {
    const entry = this.ensure(file);
    if (entry.deleted) fail("FILE_NOT_FOUND", `File has been deleted in this transaction: ${file}`);
    if (!entry.existed && entry.next === entry.original) fail("FILE_NOT_FOUND", `File not found: ${file}`);
    return entry.next;
  }

  exists(file: string): boolean {
    const entry = this.files.get(file);
    if (!entry) return existsSync(file);
    return !entry.deleted && (entry.existed || entry.next !== entry.original);
  }

  patch(file: string, next: string): void {
    const entry = this.ensure(file);
    entry.next = next;
    entry.deleted = false;
  }

  delete(file: string): void {
    const entry = this.ensure(file);
    if (!entry.existed) fail("FILE_NOT_FOUND", `File not found: ${file}`);
    entry.next = "";
    entry.deleted = true;
  }

  commit(flags: WritePolicyFlags): WorkspaceFileChange[] {
    const entries = [...this.files.values()];
    const changedEntries = entries.filter((entry) => entry.deleted ? entry.existed : entry.original !== entry.next);
    const policies = new Map<string, ReturnType<typeof resolveWritePolicy>>();
    for (const entry of changedEntries) {
      policies.set(entry.file, resolveWritePolicy(entry.file, flags));
    }
    const shouldWrite = changedEntries.length > 0 && changedEntries.every((entry) => policies.get(entry.file)?.write);

    const changes = entries.map((entry) => {
      const next = entry.deleted ? "" : entry.next;
      const diff = unifiedDiff(entry.original, next, entry.file);
      const changed = entry.deleted ? entry.existed : entry.original !== entry.next;
      const policy = policies.get(entry.file);
      let backup: BackupResult = {};
      if (shouldWrite && changed && policy) {
        backup = maybeWriteBackup(entry.file, entry.original, policy, changed, next);
        if (entry.deleted) {
          if (existsSync(entry.file)) unlinkSync(entry.file);
        } else {
          mkdirSync(dirname(entry.file), { recursive: true });
          writeFileSync(entry.file, entry.next);
        }
      }
      return {
        file: entry.file,
        existed: entry.existed,
        changed,
        written: shouldWrite && changed,
        ...(entry.deleted && changed ? { deleted: true } : {}),
        warnings: fileLengthWarnings(entry.file, entry.original, next),
        ...(policy ? { write_policy: writePolicyReport(policy, backup) } : {}),
        ...(backup.path ? { backup: backup.path } : {}),
        ...(diff ? { diff } : {}),
      };
    });
    return changes.filter((change) => change.changed);
  }

  private ensure(file: string): WorkspaceFileEntry {
    const existing = this.files.get(file);
    if (existing) return existing;

    const existed = existsSync(file);
    const original = existed ? readFileSync(file, "utf8") : "";
    const entry = { file, existed, original, next: original, deleted: false };
    this.files.set(file, entry);
    return entry;
  }
}

class WorkspaceVarStore {
  private vars: Record<string, unknown>;

  constructor(initial: Record<string, unknown>) {
    this.vars = { ...initial };
  }

  set(name: string, value: unknown): void {
    this.vars[name] = value;
  }

  merge(values: Record<string, unknown>): void {
    this.vars = { ...this.vars, ...values };
  }

  resolveValue(value: unknown): unknown {
    if (typeof value === "string") return this.interpolate(value);
    if (Array.isArray(value)) return value.map((item) => this.resolveValue(item));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) result[key] = this.resolveValue(child);
      return result;
    }
    return value;
  }

  snapshot(): Record<string, unknown> {
    return { ...this.vars };
  }

  private get(path: string): unknown {
    const parts = path.split(".");
    let current: unknown = this.vars;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return undefined;
      if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
      else current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private interpolate(input: string): unknown {
    const single = input.match(/^\{\{([^}]+)\}\}$/);
    if (single) return this.get(single[1].trim());

    return input.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
      const value = this.get(path.trim());
      if (value == null) return "";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    });
  }
}
