import { readFileSync, writeFileSync } from "node:fs";

import {
  parseVerificationFields,
  planBaseEdit,
  type BaseEditMutation,
  type BaseEditPlan,
  type BaseFindStrategy,
} from "./base-edit.js";
import { qualityWarnings, type QualityWarning } from "./quality.js";
import {
  maybeWriteBackup,
  resolveWritePolicy,
  writePolicyReport,
  type BackupResult,
  type WritePolicy,
  type WritePolicyFlags,
} from "./write-policy.js";

export type BaseEditRunOptions = {
  filePath: string;
  strategy: BaseFindStrategy;
  mutation: BaseEditMutation;
  replaceAll?: boolean;
  expectCount?: number;
  writeFlags?: WritePolicyFlags;
};

export type BaseEditRunResult = {
  success: true;
  file: string;
  action: BaseEditMutation["kind"];
  strategy: BaseFindStrategy["kind"];
  changed: boolean;
  written: boolean;
  matches: BaseEditPlan["matches"];
  guardrails: BaseEditPlan["guardrails"];
  warnings: QualityWarning[];
  write_policy: ReturnType<typeof writePolicyReport>;
  diff?: string;
} & ReturnType<typeof parseVerificationFields>;

export type BaseEditRun = {
  result: BaseEditRunResult;
  plan: BaseEditPlan;
  policy: WritePolicy;
  backup: BackupResult;
  warnings: QualityWarning[];
};

export function runBaseEditOperation(options: BaseEditRunOptions): BaseEditRun {
  const source = readFileSync(options.filePath, "utf8");
  const plan = planBaseEdit({
    filePath: options.filePath,
    source,
    strategy: options.strategy,
    mutation: options.mutation,
    replaceAll: options.replaceAll,
    ...(options.expectCount === undefined ? {} : { expectCount: options.expectCount }),
  });
  const policy = resolveWritePolicy(options.filePath, options.writeFlags);
  const warnings = qualityWarnings(options.filePath, source, plan.nextSource);
  let backup: BackupResult = {};

  if (policy.write && plan.changed) {
    backup = maybeWriteBackup(options.filePath, source, policy, plan.changed, plan.nextSource);
    writeFileSync(options.filePath, plan.nextSource);
  }

  return {
    result: {
      success: true,
      file: options.filePath,
      action: plan.action,
      strategy: plan.strategy,
      changed: plan.changed,
      written: policy.write && plan.changed,
      ...parseVerificationFields(plan.parseVerification),
      matches: plan.matches,
      guardrails: plan.guardrails,
      warnings,
      write_policy: writePolicyReport(policy, backup),
      ...(plan.diff ? { diff: plan.diff } : {}),
    },
    plan,
    policy,
    backup,
    warnings,
  };
}
