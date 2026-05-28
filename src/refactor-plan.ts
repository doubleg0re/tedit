import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { unifiedDiff } from "./diff.js";
import { fail } from "./errors.js";
import { planExtract, type ExtractOptions, type ExtractPlan, type HelperPolicy } from "./extract.js";
import { fileLengthWarnings } from "./quality.js";
import { maybeWriteBackup, resolveWritePolicy, writePolicyReport, type BackupResult } from "./write-policy.js";

export type RefactorPlanKind = "extract-component-plan";
export type RefactorPlanRisk = "low" | "medium" | "high";

export type RefactorPlanStep = {
  id: string;
  kind: "write-file" | "edit-file" | "move-symbol";
  risk: RefactorPlanRisk;
  file?: string;
  symbol?: string;
  action?: string;
  class?: string;
  reason?: string;
};

export type ExtractComponentPlanFile = {
  kind: RefactorPlanKind;
  version: 1;
  created_by: "tedit";
  source: string;
  source_hash: string;
  target: string;
  target_hash: string | null;
  options: SerializableExtractOptions;
  steps: RefactorPlanStep[];
};

export type SerializableExtractOptions = {
  from: string;
  selector: string;
  to: string;
  name: string;
  exportKind: "named" | "default";
  slots: string[];
  typecheck: boolean;
  helpersPolicy: HelperPolicy;
  helperOverrides: string[];
  overwrite: boolean;
  autoSlot: boolean;
  acceptLargeProps: boolean;
  depth?: number;
  maxProps?: number;
};

export type ApplyPlanOptions = {
  write?: boolean;
  dryRun?: boolean;
  backup?: boolean;
  noBackup?: boolean;
  overwrite?: boolean;
  only?: string[];
  skip?: string[];
};

export type ApplyPlanResult = {
  success: true;
  kind: RefactorPlanKind;
  plan: string;
  changed: boolean;
  written: boolean;
  steps: Array<RefactorPlanStep & { selected: boolean; status: "applied" | "skipped" | "metadata" }>;
  files: Array<{ step: string; file: string; changed: boolean; written: boolean; diff?: string }>;
  warnings: ReturnType<typeof fileLengthWarnings>;
  write_policy: Record<string, unknown>;
};

export function buildExtractComponentPlan(options: ExtractOptions, planned: ExtractPlan = planExtract(options)): ExtractComponentPlanFile {
  const previousTarget = existsSync(options.to) ? readFileSync(options.to, "utf8") : null;
  const normalized = normalizeExtractOptions(options);
  const steps: RefactorPlanStep[] = [
    {
      id: "create-component-file",
      kind: "write-file",
      risk: "low",
      file: options.to,
      reason: "create the extracted component module",
    },
    {
      id: "replace-callsite",
      kind: "edit-file",
      risk: "medium",
      file: options.from,
      reason: "replace the selected JSX subtree with the extracted component call",
    },
    ...planned.result.helpers
      .filter((helper) => helper.action === "moved")
      .map<RefactorPlanStep>((helper) => ({
        id: `move-helper-${helper.name}`,
        kind: "move-symbol",
        risk: helper.class === "shared" ? "high" : "medium",
        file: options.from,
        symbol: helper.name,
        action: helper.action,
        class: helper.class,
        reason: `move helper ${helper.name} with the extracted component`,
      })),
  ];

  return {
    kind: "extract-component-plan",
    version: 1,
    created_by: "tedit",
    source: options.from,
    source_hash: sha256(planned.source),
    target: options.to,
    target_hash: previousTarget === null ? null : sha256(previousTarget),
    options: normalized,
    steps,
  };
}

export function writePlanFile(planPath: string, plan: ExtractComponentPlanFile, overwrite = false): void {
  if (existsSync(planPath) && !overwrite) {
    fail("PLAN_DESTINATION_EXISTS", `Refusing to overwrite existing plan: ${planPath}. Use --overwrite to bypass.`);
  }
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
}

export function applyRefactorPlan(planPath: string, options: ApplyPlanOptions = {}): ApplyPlanResult {
  const plan = loadRefactorPlan(planPath);
  if (plan.kind !== "extract-component-plan") {
    fail("UNSUPPORTED_PLAN", `Unsupported refactor plan kind: ${(plan as { kind?: unknown }).kind}`);
  }

  const source = readFileSync(plan.source, "utf8");
  if (sha256(source) !== plan.source_hash) {
    fail("PLAN_STALE_SOURCE", `Plan source changed since it was generated: ${plan.source}.`, {
      expected: plan.source_hash,
      actual: sha256(source),
    });
  }
  const targetExists = existsSync(plan.target);
  const targetSource = targetExists ? readFileSync(plan.target, "utf8") : "";
  const targetHash = targetExists ? sha256(targetSource) : null;
  if (targetHash !== plan.target_hash) {
    fail("PLAN_STALE_TARGET", `Plan target changed since it was generated: ${plan.target}.`, {
      expected: plan.target_hash,
      actual: targetHash,
    });
  }

  const selected = selectPlanSteps(plan.steps, options);
  const skippedMoveHelpers = plan.steps
    .filter((step) => step.kind === "move-symbol" && step.symbol && !selected.has(step.id))
    .map((step) => `${step.symbol}=as-prop`);
  const planned = planExtract({
    ...plan.options,
    overwrite: options.overwrite ?? plan.options.overwrite,
    helperOverrides: mergeHelperOverrides(plan.options.helperOverrides, skippedMoveHelpers),
  });

  const sourceDiff = unifiedDiff(planned.source, planned.nextSource, plan.source);
  const targetDiff = unifiedDiff(targetSource, planned.newSource, plan.target);
  const sourceSelected = selected.has("replace-callsite");
  const targetSelected = selected.has("create-component-file");
  const sourceChanged = sourceSelected && planned.source !== planned.nextSource;
  const targetChanged = targetSelected && targetSource !== planned.newSource;
  const effectiveWrite = Boolean(options.write) && !options.dryRun;
  const sourcePolicy = resolveWritePolicy(plan.source, { write: effectiveWrite, dryRun: !effectiveWrite, backup: Boolean(options.backup), noBackup: Boolean(options.noBackup) });
  const targetPolicy = resolveWritePolicy(plan.target, { write: effectiveWrite, dryRun: !effectiveWrite, backup: Boolean(options.backup), noBackup: Boolean(options.noBackup) });
  let sourceBackup: BackupResult = {};
  let targetBackup: BackupResult = {};

  if (sourcePolicy.write && sourceChanged) {
    sourceBackup = maybeWriteBackup(plan.source, planned.source, sourcePolicy, true, planned.nextSource);
    writeFileSync(plan.source, planned.nextSource);
  }
  if (targetPolicy.write && targetChanged) {
    targetBackup = maybeWriteBackup(plan.target, targetSource, targetPolicy, true, planned.newSource);
    mkdirSync(dirname(plan.target), { recursive: true });
    writeFileSync(plan.target, planned.newSource);
  }

  const files = [
    ...(sourceSelected ? [{ step: "replace-callsite", file: plan.source, changed: sourceChanged, written: sourcePolicy.write && sourceChanged, ...(sourceDiff ? { diff: sourceDiff } : {}) }] : []),
    ...(targetSelected ? [{ step: "create-component-file", file: plan.target, changed: targetChanged, written: targetPolicy.write && targetChanged, ...(targetDiff ? { diff: targetDiff } : {}) }] : []),
  ];
  const warnings = [
    ...(sourceSelected ? fileLengthWarnings(plan.source, planned.source, planned.nextSource) : []),
    ...(targetSelected ? fileLengthWarnings(plan.target, targetSource, planned.newSource) : []),
  ];

  return {
    success: true,
    kind: plan.kind,
    plan: planPath,
    changed: sourceChanged || targetChanged,
    written: files.some((file) => file.written),
    steps: plan.steps.map((step) => ({
      ...step,
      selected: selected.has(step.id),
      status: step.kind === "move-symbol" ? (selected.has(step.id) ? "metadata" : "skipped") : selected.has(step.id) ? "applied" : "skipped",
    })),
    files,
    warnings,
    write_policy: {
      source: writePolicyReport(sourcePolicy, sourceBackup),
      target: writePolicyReport(targetPolicy, targetBackup),
    },
  };
}

export type InspectPlanResult = {
  success: true;
  kind: RefactorPlanKind;
  plan: string;
  source: string;
  target: string;
  component: string;
  summary: string;
  stale: boolean;
  steps_total: number;
  risks: Record<RefactorPlanRisk, number>;
  files: Array<{
    role: "source" | "target";
    file: string;
    exists: boolean;
    expected_hash: string | null;
    actual_hash: string | null;
    stale: boolean;
  }>;
  steps: RefactorPlanStep[];
};

export function inspectRefactorPlan(planPath: string): InspectPlanResult {
  const plan = loadRefactorPlan(planPath);
  const source = inspectPlanFile("source", plan.source, plan.source_hash);
  const target = inspectPlanFile("target", plan.target, plan.target_hash);
  const risks = countRisks(plan.steps);
  const stale = source.stale || target.stale;
  return {
    success: true,
    kind: plan.kind,
    plan: planPath,
    source: plan.source,
    target: plan.target,
    component: plan.options.name,
    summary: plan.kind + ": " + plan.steps.length + " step" + (plan.steps.length === 1 ? "" : "s") + ", " + risks.high + " high risk, " + (stale ? "stale" : "ready"),
    stale,
    steps_total: plan.steps.length,
    risks,
    files: [source, target],
    steps: plan.steps,
  };
}

function inspectPlanFile(role: "source" | "target", file: string, expectedHash: string | null): InspectPlanResult["files"][number] {
  const exists = existsSync(file);
  const actualHash = exists ? sha256(readFileSync(file, "utf8")) : null;
  return {
    role,
    file,
    exists,
    expected_hash: expectedHash,
    actual_hash: actualHash,
    stale: actualHash !== expectedHash,
  };
}

function countRisks(steps: RefactorPlanStep[]): Record<RefactorPlanRisk, number> {
  return steps.reduce<Record<RefactorPlanRisk, number>>((counts, step) => {
    counts[step.risk] += 1;
    return counts;
  }, { low: 0, medium: 0, high: 0 });
}

function normalizeExtractOptions(options: ExtractOptions): SerializableExtractOptions {
  return {
    from: options.from,
    selector: options.selector,
    to: options.to,
    name: options.name,
    exportKind: options.exportKind ?? "named",
    slots: options.slots ?? [],
    typecheck: Boolean(options.typecheck),
    helpersPolicy: options.helpersPolicy ?? "ask",
    helperOverrides: options.helperOverrides ?? [],
    overwrite: Boolean(options.overwrite),
    autoSlot: Boolean(options.autoSlot),
    acceptLargeProps: Boolean(options.acceptLargeProps),
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    ...(options.maxProps === undefined ? {} : { maxProps: options.maxProps }),
  };
}

function loadRefactorPlan(planPath: string): ExtractComponentPlanFile {
  const raw = JSON.parse(readFileSync(planPath, "utf8")) as Partial<ExtractComponentPlanFile>;
  if (raw.version !== 1) fail("INVALID_PLAN", "Refactor plan version must be 1.");
  if (raw.created_by !== "tedit") fail("INVALID_PLAN", "Refactor plan must be created_by tedit.");
  if (raw.kind !== "extract-component-plan") fail("INVALID_PLAN", "Refactor plan kind must be extract-component-plan.");
  if (!raw.source || !raw.target || !raw.source_hash || !raw.options || !Array.isArray(raw.steps)) {
    fail("INVALID_PLAN", "Refactor plan is missing required fields.");
  }
  return raw as ExtractComponentPlanFile;
}

function selectPlanSteps(steps: RefactorPlanStep[], options: ApplyPlanOptions): Set<string> {
  const ids = new Set(steps.map((step) => step.id));
  const only = options.only ?? [];
  const skip = options.skip ?? [];
  for (const id of [...only, ...skip]) {
    if (!ids.has(id)) fail("UNKNOWN_PLAN_STEP", `Plan does not contain step: ${id}`);
  }
  const selected = new Set(only.length > 0 ? only : [...ids]);
  for (const id of skip) selected.delete(id);
  return selected;
}

function mergeHelperOverrides(existing: string[], additions: string[]): string[] {
  const byName = new Map<string, string>();
  for (const item of existing) {
    const eq = item.indexOf("=");
    byName.set(eq >= 0 ? item.slice(0, eq) : item, item);
  }
  for (const item of additions) {
    const eq = item.indexOf("=");
    byName.set(eq >= 0 ? item.slice(0, eq) : item, item);
  }
  return [...byName.values()];
}

function sha256(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}
