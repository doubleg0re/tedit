import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { unifiedDiff } from "./diff.js";
import { fail } from "./errors.js";
import { planExtract, type ExtractOptions, type ExtractPlan, type HelperPolicy } from "./extract.js";
import { runRefactorState, type RefactorStateOptions, type RefactorStateResult } from "./refactor-state.js";
import { qualityWarnings } from "./quality.js";
import { maybeWriteBackup, resolveWritePolicy, writePolicyReport, type BackupResult } from "./write-policy.js";

export type RefactorPlanKind = "extract-component-plan" | "refactor-state-plan";
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
  kind: "extract-component-plan";
  version: 1;
  created_by: "tedit";
  source: string;
  source_hash: string;
  target: string;
  target_hash: string | null;
  options: SerializableExtractOptions;
  steps: RefactorPlanStep[];
};

export type RefactorStatePlanFile = {
  kind: "refactor-state-plan";
  version: 1;
  created_by: "tedit";
  source: string;
  source_hash: string;
  target: string | null;
  target_hash: string | null;
  mode: "object-state" | "custom-hook";
  options: SerializableRefactorStateOptions;
  steps: RefactorPlanStep[];
};

export type TeditRefactorPlanFile = ExtractComponentPlanFile | RefactorStatePlanFile;

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

export type SerializableRefactorStateOptions = {
  file: string;
  externalDeps: "fail" | "params";
  cluster?: string;
  to?: string;
  name?: string;
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
  warnings: ReturnType<typeof qualityWarnings>;
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

export function buildRefactorStatePlan(filePath: string, options: RefactorStateOptions = {}, planned?: RefactorStateResult): RefactorStatePlanFile {
  const preview = planned ?? runRefactorState(filePath, { ...options, write: false, dryRun: true });
  const source = readFileSync(filePath, "utf8");
  const target = preview.mode === "custom-hook" ? preview.hook_file ?? options.to ?? null : null;
  const targetSource = target && existsSync(target) ? readFileSync(target, "utf8") : null;
  return {
    kind: "refactor-state-plan",
    version: 1,
    created_by: "tedit",
    source: filePath,
    source_hash: sha256(source),
    target,
    target_hash: targetSource === null ? null : sha256(targetSource),
    mode: preview.mode ?? "object-state",
    options: normalizeRefactorStateOptions(filePath, options),
    steps: refactorStatePlanSteps(filePath, preview, target),
  };
}

export function writePlanFile(planPath: string, plan: TeditRefactorPlanFile, overwrite = false): void {
  if (existsSync(planPath) && !overwrite) {
    fail("PLAN_DESTINATION_EXISTS", `Refusing to overwrite existing plan: ${planPath}. Use --overwrite to bypass.`);
  }
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
}

export function applyRefactorPlan(planPath: string, options: ApplyPlanOptions = {}): ApplyPlanResult {
  const plan = loadRefactorPlan(planPath);
  if (plan.kind === "extract-component-plan") return applyExtractComponentPlan(planPath, plan, options);
  if (plan.kind === "refactor-state-plan") return applyRefactorStatePlan(planPath, plan, options);
  fail("UNSUPPORTED_PLAN", `Unsupported refactor plan kind: ${(plan as { kind?: unknown }).kind}`);
}

function applyExtractComponentPlan(planPath: string, plan: ExtractComponentPlanFile, options: ApplyPlanOptions = {}): ApplyPlanResult {
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
    ...(sourceSelected ? qualityWarnings(plan.source, planned.source, planned.nextSource) : []),
    ...(targetSelected ? qualityWarnings(plan.target, targetSource, planned.newSource) : []),
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

function applyRefactorStatePlan(planPath: string, plan: RefactorStatePlanFile, options: ApplyPlanOptions = {}): ApplyPlanResult {
  assertPlanFileHash("source", plan.source, plan.source_hash);
  if (plan.target) assertPlanFileHash("target", plan.target, plan.target_hash);

  const selected = selectPlanSteps(plan.steps, options);
  if (selected.size !== plan.steps.length) {
    fail("PLAN_PARTIAL_UNSUPPORTED", "refactor-state plans must be applied as a whole because source and hook changes are coupled.", {
      selected: [...selected],
      required_steps: plan.steps.map((step) => step.id),
      suggestions: ["Apply the plan without --only/--skip, or regenerate a narrower refactor-state plan."],
    });
  }

  const effectiveWrite = Boolean(options.write) && !options.dryRun;
  const result = runRefactorState(plan.source, {
    cluster: plan.options.cluster,
    to: plan.options.to,
    name: plan.options.name,
    externalDeps: plan.options.externalDeps,
    write: effectiveWrite,
    dryRun: !effectiveWrite,
    backup: Boolean(options.backup),
    noBackup: Boolean(options.noBackup),
  });
  const sourceStep = plan.mode === "custom-hook" ? "update-source-hook-call" : "refactor-source-state";
  const files = result.files.map((file) => ({
    step: plan.target && file.file === plan.target ? "create-hook-file" : sourceStep,
    file: file.file,
    changed: file.changed,
    written: file.written,
    ...(file.diff ? { diff: file.diff } : {}),
  }));

  return {
    success: true,
    kind: plan.kind,
    plan: planPath,
    changed: result.files.some((file) => file.changed),
    written: result.files.some((file) => file.written),
    steps: plan.steps.map((step) => ({ ...step, selected: true, status: "applied" })),
    files,
    warnings: result.files.flatMap((file) => file.warnings),
    write_policy: Object.fromEntries(result.files.map((file) => [file.file, file.write_policy ?? {}])),
  };
}

export type InspectPlanResult = {
  success: true;
  kind: RefactorPlanKind;
  plan: string;
  source: string;
  target?: string | null;
  component?: string;
  mode?: string;
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
  const target = plan.target ? inspectPlanFile("target", plan.target, plan.target_hash) : null;
  const risks = countRisks(plan.steps);
  const stale = source.stale || Boolean(target?.stale);
  return {
    success: true,
    kind: plan.kind,
    plan: planPath,
    source: plan.source,
    target: plan.target,
    ...(plan.kind === "extract-component-plan" ? { component: plan.options.name } : { mode: plan.mode }),
    summary: planSummary(plan, risks, stale),
    stale,
    steps_total: plan.steps.length,
    risks,
    files: target ? [source, target] : [source],
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

function normalizeRefactorStateOptions(filePath: string, options: RefactorStateOptions): SerializableRefactorStateOptions {
  return {
    file: filePath,
    externalDeps: options.externalDeps ?? "fail",
    ...(options.cluster === undefined ? {} : { cluster: options.cluster }),
    ...(options.to === undefined ? {} : { to: options.to }),
    ...(options.name === undefined ? {} : { name: options.name }),
  };
}

function refactorStatePlanSteps(filePath: string, preview: RefactorStateResult, target: string | null): RefactorPlanStep[] {
  if (preview.mode === "custom-hook") {
    return [
      {
        id: "create-hook-file",
        kind: "write-file",
        risk: "low",
        file: target ?? preview.hook_file,
        symbol: preview.hook_name,
        reason: "create the extracted custom hook module",
      },
      {
        id: "update-source-hook-call",
        kind: "edit-file",
        risk: "medium",
        file: filePath,
        symbol: preview.hook_name,
        reason: "replace the selected useState cluster with the generated hook call",
      },
      ...(preview.external_dependencies && preview.external_dependencies.length > 0 ? [{
        id: "thread-external-deps",
        kind: "edit-file" as const,
        risk: "medium" as const,
        file: filePath,
        reason: "thread external dependencies into the generated hook call",
      }] : []),
    ];
  }
  return [{
    id: "refactor-source-state",
    kind: "edit-file",
    risk: "medium",
    file: filePath,
    reason: "group the selected useState cluster into object state",
  }];
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

function loadRefactorPlan(planPath: string): TeditRefactorPlanFile {
  const raw = JSON.parse(readFileSync(planPath, "utf8")) as Partial<TeditRefactorPlanFile>;
  if (raw.version !== 1) fail("INVALID_PLAN", "Refactor plan version must be 1.");
  if (raw.created_by !== "tedit") fail("INVALID_PLAN", "Refactor plan must be created_by tedit.");
  if (raw.kind === "extract-component-plan") {
    if (!raw.source || !raw.target || !raw.source_hash || !raw.options || !Array.isArray(raw.steps)) {
      fail("INVALID_PLAN", "Extract component plan is missing required fields.");
    }
    return raw as ExtractComponentPlanFile;
  }
  if (raw.kind === "refactor-state-plan") {
    if (!raw.source || !raw.source_hash || !raw.options || !Array.isArray(raw.steps) || (raw.mode !== "object-state" && raw.mode !== "custom-hook") || !("target" in raw) || !("target_hash" in raw)) {
      fail("INVALID_PLAN", "Refactor state plan is missing required fields.");
    }
    return raw as RefactorStatePlanFile;
  }
  fail("INVALID_PLAN", "Refactor plan kind must be extract-component-plan or refactor-state-plan.");
}

function assertPlanFileHash(role: "source" | "target", file: string, expectedHash: string | null): void {
  const exists = existsSync(file);
  const actualHash = exists ? sha256(readFileSync(file, "utf8")) : null;
  if (actualHash !== expectedHash) {
    fail(role === "source" ? "PLAN_STALE_SOURCE" : "PLAN_STALE_TARGET", `Plan ${role} changed since it was generated: ${file}.`, {
      expected: expectedHash,
      actual: actualHash,
    });
  }
}

function planSummary(plan: TeditRefactorPlanFile, risks: Record<RefactorPlanRisk, number>, stale: boolean): string {
  const label = plan.kind === "refactor-state-plan" ? plan.kind + " (" + plan.mode + ")" : plan.kind;
  return label + ": " + plan.steps.length + " step" + (plan.steps.length === 1 ? "" : "s") + ", " + risks.high + " high risk, " + (stale ? "stale" : "ready");
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
