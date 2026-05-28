import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod/v4";
import { BASE_ACTIONS, parseLineRange, planBaseEdit, verifyParseForFile, type BaseEditMutation, type BaseFindStrategy } from "./base-edit.js";
import { parseElementShorthand } from "./chain.js";
import { getOptionalAdapterForFile, listRules } from "./core/registry.js";
import { fail } from "./errors.js";
import { runMultiedit, runMultieditInput } from "./multiedit.js";
import { runPatchInput } from "./patch.js";
import { analyzeState } from "./quality.js";
import { runRefactorState } from "./refactor-state.js";import { applyRefactorPlan, buildExtractComponentPlan, writePlanFile } from "./refactor-plan.js";
import type { ExtractOptions, HelperPolicy } from "./extract.js";
import { runWorkspaceFlow, type WorkspaceFlowOptions, type WorkspaceFlowStep } from "./workspace-flow.js";
import { fileLengthWarnings } from "./quality.js";
import { maybeWriteBackup, resolveWritePolicy, writePolicyReport, type BackupResult } from "./write-policy.js";

export type TeditMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: unknown) => unknown;
};

type JsonRecord = Record<string, unknown>;

type SingleStepConfig = {
  name: string;
  title: string;
  action: string;
  description: string;
  inputSchema: z.ZodRawShape;
  readOnly?: boolean;
  buildStep: (input: JsonRecord) => WorkspaceFlowStep;
};

const writeFlagSchema = {
  write: z.boolean().optional().describe("Write changes when true; otherwise git-aware defaults apply."),
  dryRun: z.boolean().optional().describe("Force dry-run mode."),
  backup: z.boolean().optional().describe("Force .tedit.bak backup creation."),
  noBackup: z.boolean().optional().describe("Disable .tedit.bak backup creation."),
} satisfies z.ZodRawShape;

const fileSchema = z.string().min(1).describe("Target file path.");
const targetSchema = z.string().min(1).describe("Selector or previously returned node id.");
const selectorSchema = z.string().min(1).describe("Structural selector.");
const valueSchema = z.unknown().describe("Literal value or tedit value spec.");
const elementSchema = z.unknown().describe("Element shorthand string or tree node spec.");

export const TEDIT_MCP_TOOLS: readonly TeditMcpTool[] = [
  {
    name: "edit",
    title: "Universal Edit",
    description: "Run tedit's universal base edit with exact, fuzzy, anchor, regex, or line-range matching.",
    inputSchema: {
      file: fileSchema,
      find: z.string().optional(),
      findExact: z.string().optional(),
      findFuzzy: z.string().optional(),
      findAnchorAfter: z.string().optional(),
      contains: z.string().optional(),
      findRegex: z.string().optional(),
      flags: z.string().optional(),
      findLines: z.string().optional(),
      replace: z.string().optional(),
      insertBefore: z.string().optional(),
      insertAfter: z.string().optional(),
      delete: z.boolean().optional(),
      replaceAll: z.boolean().optional(),
      expectCount: z.number().int().nonnegative().optional(),
      noFuzzyFallback: z.boolean().optional(),
      ...writeFlagSchema,
    },
    handler: runEditTool,
  },
  {
    name: "multiedit",
    title: "Atomic Multiedit",
    description: "Apply many universal base edits atomically.",
    inputSchema: {
      edits: z.array(z.record(z.string(), z.unknown())).optional(),
      input: z.string().optional().describe("Raw multiedit JSON string; use when forwarding existing CLI input."),
      ...writeFlagSchema,
    },
    handler: runMultieditTool,
  },
  {
    name: "patch",
    title: "Patch",
    description: "Apply unified diff or Codex apply-patch input atomically.",
    inputSchema: {
      patch: z.string().min(1).describe("Unified diff or apply-patch envelope."),
      ...writeFlagSchema,
    },
    handler: runPatchTool,
  },
  {
    name: "actions",
    title: "Actions",
    description: "List tedit actions available globally or for a target file.",
    inputSchema: {
      file: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runActionsTool,
  },
  {
    name: "analyze_state",
    title: "Analyze State",
    description: "Analyze React useState clusters and refactor recommendations.",
    inputSchema: {
      file: fileSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runAnalyzeStateTool,
  },
  {
    name: "verify_file",
    title: "Verify File",
    description: "Run tedit parse verification for the current file without planning an edit.",
    inputSchema: {
      file: fileSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runVerifyFileTool,
  },

  {
    name: "refactor_state",
    title: "Refactor State",
    description: "Apply tedit's React state refactor helper, including custom hook extraction.",
    inputSchema: {
      file: fileSchema,
      cluster: z.string().optional(),
      to: z.string().optional(),
      name: z.string().optional(),
      ...writeFlagSchema,
    },
    handler: runRefactorStateTool,
  },
  {
    name: "extract_plan",
    title: "Extract Plan",
    description: "Generate a reviewable extract-component plan file without changing source files.",
    inputSchema: {
      from: fileSchema,
      selector: selectorSchema,
      to: z.string().min(1),
      name: z.string().min(1),
      planOut: z.string().min(1),
      export: z.enum(["named", "default"]).optional(),
      exportKind: z.enum(["named", "default"]).optional(),
      slots: z.unknown().optional(),
      slot: z.unknown().optional(),
      depth: z.number().int().optional(),
      autoSlot: z.boolean().optional(),
      helpers: z.string().optional(),
      helpersPolicy: z.string().optional(),
      helper: z.unknown().optional(),
      helperOverrides: z.unknown().optional(),
      overwrite: z.boolean().optional(),
      typecheck: z.boolean().optional(),
      maxProps: z.number().int().optional(),
      acceptLargeProps: z.boolean().optional(),
    },
    handler: runExtractPlanTool,
  },
  {
    name: "apply_plan",
    title: "Apply Plan",
    description: "Validate and apply a tedit refactor plan.",
    inputSchema: {
      plan: z.string().min(1).optional(),
      file: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      only: z.union([z.string(), z.array(z.string())]).optional(),
      skip: z.union([z.string(), z.array(z.string())]).optional(),
      overwrite: z.boolean().optional(),
      ...writeFlagSchema,
    },
    handler: runApplyPlanTool,
  },

  {
    name: "chain_workspace",
    title: "Workspace Chain",
    description: "Run structured workspace-flow steps directly from MCP JSON.",
    inputSchema: {
      steps: z.array(z.record(z.string(), z.unknown())).optional(),
      flow: z.array(z.record(z.string(), z.unknown())).optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      ...writeFlagSchema,
    },
    handler: runWorkspaceTool,
  },
  singleStepTool({
    name: "find",
    title: "Find JSX Node",
    action: "find",
    description: "Find JSX/TSX nodes by selector.",
    readOnly: true,
    inputSchema: { file: fileSchema, selector: selectorSchema, all: z.boolean().optional() },
    buildStep: (input) => ({ action: "find", file: requiredString(input.file, "find requires file."), selector: requiredString(input.selector, "find requires selector."), all: booleanValue(input.all) }),
  }),
  singleStepTool({
    name: "inspect",
    title: "Inspect JSX Node",
    action: "inspect",
    description: "Inspect a JSX/TSX node by selector or id.",
    readOnly: true,
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional() },
    buildStep: (input) => ({ action: "inspect", file: requiredString(input.file, "inspect requires file."), target: targetFromInput(input, "inspect") }),
  }),
  singleStepTool({
    name: "append",
    title: "Append JSX Element",
    action: "append",
    description: "Append an element inside a selected JSX node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), element: elementSchema, ...writeFlagSchema },
    buildStep: (input) => ({ action: "append", file: requiredString(input.file, "append requires file."), target: targetFromInput(input, "append"), element: normalizeElementInput(input.element, "append requires element.") }),
  }),
  singleStepTool({
    name: "prepend",
    title: "Prepend JSX Element",
    action: "prepend",
    description: "Prepend an element inside a selected JSX node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), element: elementSchema, ...writeFlagSchema },
    buildStep: (input) => ({ action: "prepend", file: requiredString(input.file, "prepend requires file."), target: targetFromInput(input, "prepend"), element: normalizeElementInput(input.element, "prepend requires element.") }),
  }),
  singleStepTool({
    name: "wrap",
    title: "Wrap JSX Node",
    action: "wrap",
    description: "Wrap a selected JSX node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), with: elementSchema, ...writeFlagSchema },
    buildStep: (input) => ({ action: "wrap", file: requiredString(input.file, "wrap requires file."), target: targetFromInput(input, "wrap"), with: normalizeElementInput(input.with, "wrap requires with.") }),
  }),
  singleStepTool({
    name: "unwrap",
    title: "Unwrap JSX Node",
    action: "unwrap",
    description: "Remove a JSX wrapper while keeping children.",
    inputSchema: targetOnlySchema(),
    buildStep: (input) => ({ action: "unwrap", file: requiredString(input.file, "unwrap requires file."), target: targetFromInput(input, "unwrap") }),
  }),
  singleStepTool({
    name: "remove",
    title: "Remove JSX Node",
    action: "remove",
    description: "Remove a selected JSX node.",
    inputSchema: targetOnlySchema(),
    buildStep: (input) => ({ action: "remove", file: requiredString(input.file, "remove requires file."), target: targetFromInput(input, "remove") }),
  }),
  singleStepTool({
    name: "rename",
    title: "Rename JSX Element",
    action: "rename",
    description: "Rename a selected JSX element tag.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), to: z.string().optional(), name: z.string().optional(), ...writeFlagSchema },
    buildStep: (input) => ({ action: "rename", file: requiredString(input.file, "rename requires file."), target: targetFromInput(input, "rename"), name: requiredString(pick(input, "to", "name"), "rename requires to or name.") }),
  }),
  singleStepTool({
    name: "prop_set",
    title: "Set JSX Prop",
    action: "prop.set",
    description: "Set a JSX prop on a selected node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), name: z.string().min(1), value: valueSchema.optional(), expr: z.string().optional(), ...writeFlagSchema },
    buildStep: (input) => ({ action: "prop.set", file: requiredString(input.file, "prop_set requires file."), target: targetFromInput(input, "prop_set"), name: requiredString(input.name, "prop_set requires name."), value: propValue(input) }),
  }),
  singleStepTool({
    name: "prop_remove",
    title: "Remove JSX Prop",
    action: "prop.remove",
    description: "Remove a JSX prop from a selected node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), name: z.string().min(1), ...writeFlagSchema },
    buildStep: (input) => ({ action: "prop.remove", file: requiredString(input.file, "prop_remove requires file."), target: targetFromInput(input, "prop_remove"), name: requiredString(input.name, "prop_remove requires name.") }),
  }),
  singleStepTool({
    name: "text_set",
    title: "Set JSX Text",
    action: "text.set",
    description: "Replace all children of a selected node with text or an expression.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), value: z.string().optional(), expr: z.string().optional(), ...writeFlagSchema },
    buildStep: (input) => ({ action: "text.set", file: requiredString(input.file, "text_set requires file."), target: targetFromInput(input, "text_set"), ...textSetValue(input) }),
  }),
  singleStepTool({
    name: "text_replace",
    title: "Replace JSX Text",
    action: "text.replace",
    description: "Replace matching direct JSX text/expression children.",
    inputSchema: {
      file: fileSchema,
      selector: selectorSchema.optional(),
      target: targetSchema.optional(),
      id: targetSchema.optional(),
      match: z.unknown().optional(),
      matchText: z.string().optional(),
      matchExpr: z.string().optional(),
      matchAny: z.string().optional(),
      with: z.unknown().optional(),
      withText: z.string().optional(),
      withExpr: z.string().optional(),
      ...writeFlagSchema,
    },
    buildStep: (input) => ({ action: "text.replace", file: requiredString(input.file, "text_replace requires file."), target: targetFromInput(input, "text_replace"), match: textMatch(input) as WorkspaceFlowStep["match"], with: textReplacement(input) as WorkspaceFlowStep["with"] }),
  }),
  singleStepTool({
    name: "insert_comment",
    title: "Insert JSX Comment",
    action: "insertComment",
    description: "Insert a JSX comment around or inside a selected node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), text: z.string().min(1), position: z.string().optional(), ...writeFlagSchema },
    buildStep: (input) => ({ action: "insertComment", file: requiredString(input.file, "insert_comment requires file."), target: targetFromInput(input, "insert_comment"), text: requiredString(input.text, "insert_comment requires text."), ...(input.position === undefined ? {} : { position: String(input.position) as WorkspaceFlowStep["position"] }) }),
  }),
  singleStepTool({
    name: "imports_add",
    title: "Add Import",
    action: "imports.add",
    description: "Add or merge an import declaration.",
    inputSchema: importsSchema(),
    buildStep: (input) => ({ action: "imports.add", file: requiredString(input.file, "imports_add requires file."), ...importFields(input) }),
  }),
  singleStepTool({
    name: "imports_remove",
    title: "Remove Import",
    action: "imports.remove",
    description: "Remove import specifiers or declarations.",
    inputSchema: importsSchema(),
    buildStep: (input) => ({ action: "imports.remove", file: requiredString(input.file, "imports_remove requires file."), ...importFields(input) }),
  }),
  singleStepTool({
    name: "imports_rename",
    title: "Rename Import",
    action: "imports.rename",
    description: "Rename an imported binding.",
    inputSchema: importsSchema({ requireName: true, requireTo: true }),
    buildStep: (input) => ({ action: "imports.rename", file: requiredString(input.file, "imports_rename requires file."), ...importFields(input) }),
  }),
  singleStepTool({
    name: "imports_move",
    title: "Move Import",
    action: "imports.move",
    description: "Move an import to a different source module.",
    inputSchema: importsSchema({ requireTo: true }),
    buildStep: (input) => ({ action: "imports.move", file: requiredString(input.file, "imports_move requires file."), ...importFields(input) }),
  }),
  singleStepTool({
    name: "expr_replace",
    title: "Replace JSX Expression",
    action: "expr.replace",
    description: "Replace a selected JSX expression container.",
    inputSchema: exprSchema({ code: true }),
    buildStep: (input) => ({ action: "expr.replace", file: requiredString(input.file, "expr_replace requires file."), target: targetFromInput(input, "expr_replace"), code: requiredString(input.code, "expr_replace requires code.") }),
  }),
  singleStepTool({
    name: "expr_wrap",
    title: "Wrap JSX Expression",
    action: "expr.wrap",
    description: "Wrap a selected JSX expression with code containing $expr.",
    inputSchema: exprSchema({ code: true }),
    buildStep: (input) => ({ action: "expr.wrap", file: requiredString(input.file, "expr_wrap requires file."), target: targetFromInput(input, "expr_wrap"), code: requiredString(input.code, "expr_wrap requires code.") }),
  }),
  singleStepTool({
    name: "expr_unwrap",
    title: "Unwrap JSX Expression",
    action: "expr.unwrap",
    description: "Unwrap a selected JSX expression.",
    inputSchema: exprSchema(),
    buildStep: (input) => ({ action: "expr.unwrap", file: requiredString(input.file, "expr_unwrap requires file."), target: targetFromInput(input, "expr_unwrap") }),
  }),
  singleStepTool({
    name: "expr_to_ternary",
    title: "Convert Expression To Ternary",
    action: "expr.toTernary",
    description: "Convert a selected short-circuit expression to a ternary.",
    inputSchema: { ...exprSchema(), alternate: z.string().optional(), value: z.string().optional() },
    buildStep: (input) => ({ action: "expr.toTernary", file: requiredString(input.file, "expr_to_ternary requires file."), target: targetFromInput(input, "expr_to_ternary"), ...(pick(input, "alternate", "value") === undefined ? {} : { value: String(pick(input, "alternate", "value")) }) }),
  }),
  singleStepTool({
    name: "expr_to_short_circuit",
    title: "Convert Expression To Short Circuit",
    action: "expr.toShortCircuit",
    description: "Convert a selected ternary expression to a short-circuit expression.",
    inputSchema: exprSchema(),
    buildStep: (input) => ({ action: "expr.toShortCircuit", file: requiredString(input.file, "expr_to_short_circuit requires file."), target: targetFromInput(input, "expr_to_short_circuit") }),
  }),
  {
    name: "extract",
    title: "Extract JSX Component",
    description: "Extract a JSX selection into a new component through workspace-flow.",
    inputSchema: {
      from: fileSchema,
      selector: selectorSchema,
      to: z.string().min(1),
      name: z.string().min(1),
      export: z.enum(["named", "default"]).optional(),
      exportKind: z.enum(["named", "default"]).optional(),
      slots: z.unknown().optional(),
      slot: z.unknown().optional(),
      depth: z.number().int().optional(),
      autoSlot: z.boolean().optional(),
      helpers: z.string().optional(),
      helpersPolicy: z.string().optional(),
      helper: z.unknown().optional(),
      helperOverrides: z.unknown().optional(),
      overwrite: z.boolean().optional(),
      typecheck: z.boolean().optional(),
      maxProps: z.number().int().optional(),
      acceptLargeProps: z.boolean().optional(),
      ...writeFlagSchema,
    },
    handler: runExtractTool,
  },
];

export const TEDIT_MCP_TOOL_NAMES = TEDIT_MCP_TOOLS.map((tool) => tool.name);

export function runMcpTool(name: string, args: unknown): unknown {
  const tool = TEDIT_MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) fail("UNKNOWN_MCP_TOOL", `Unknown tedit MCP tool: ${name}`, { tools: TEDIT_MCP_TOOL_NAMES });
  return tool.handler(args);
}

function runEditTool(args: unknown): unknown {
  const input = recordInput(args, "edit");
  const filePath = requiredString(input.file, "edit requires file.");
  const source = readFileSync(filePath, "utf8");
  const expectCountValue = pick(input, "expectCount", "expect-count", "expect_count");
  const expectCount = optionalInteger(expectCountValue, "expectCount");
  const plan = planBaseEdit({
    filePath,
    source,
    strategy: resolveEditStrategy(input),
    mutation: resolveEditMutation(input),
    replaceAll: booleanValue(pick(input, "replaceAll", "replace-all", "replace_all")),
    ...(expectCountValue === undefined ? {} : { expectCount }),
  });
  const policy = resolveWritePolicy(filePath, writeFlagsFromInput(input));
  const shouldWrite = policy.write;
  const warnings = fileLengthWarnings(filePath, source, plan.nextSource);
  let backup: BackupResult = {};

  if (shouldWrite && plan.changed) {
    backup = maybeWriteBackup(filePath, source, policy, plan.changed);
    writeFileSync(filePath, plan.nextSource);
  }

  return {
    success: true,
    file: filePath,
    action: plan.action,
    strategy: plan.strategy,
    changed: plan.changed,
    written: shouldWrite && plan.changed,
    parse_verified: plan.parseVerified,
    ...(plan.parseVerification.parser ? { parser: plan.parseVerification.parser } : {}),
    matches: plan.matches,
    warnings,
    write_policy: writePolicyReport(policy, backup),
    ...(plan.diff ? { diff: plan.diff } : {}),
  };
}

function runMultieditTool(args: unknown): unknown {
  const input = recordInput(args, "multiedit");
  if (input.input !== undefined && input.edits !== undefined) {
    fail("INVALID_MCP_INPUT", "multiedit accepts only one of input or edits.");
  }
  if (input.input !== undefined) return runMultieditInput(requiredString(input.input, "multiedit input must be a string."), writeFlagsFromInput(input));
  const edits = input.edits;
  if (!Array.isArray(edits)) fail("INVALID_MCP_INPUT", "multiedit requires edits array or input string.");
  return runMultiedit(edits, writeFlagsFromInput(input));
}

function runPatchTool(args: unknown): unknown {
  const input = recordInput(args, "patch");
  return runPatchInput(requiredString(input.patch, "patch requires patch."), writeFlagsFromInput(input));
}

function runActionsTool(args: unknown): unknown {
  const input = optionalRecordInput(args, "actions");
  const filePath = optionalString(input.file);
  const adapter = filePath ? getOptionalAdapterForFile(filePath) : null;
  const languageRules = adapter ? [adapter.rule] : filePath ? [] : listRules();
  const actions = [
    ...BASE_ACTIONS,
    ...languageRules.flatMap((rule) => rule.actions),
  ];
  return {
    success: true,
    ...(filePath ? { file: filePath } : {}),
    rules: [
      { name: "base", extensions: ["*"], actions: BASE_ACTIONS },
      ...languageRules,
    ],
    actions,
  };
}

function runAnalyzeStateTool(args: unknown): unknown {
  const input = recordInput(args, "analyze_state");
  return analyzeState(requiredString(input.file, "analyze_state requires file."));
}

function runVerifyFileTool(args: unknown): unknown {
  const input = recordInput(args, "verify_file");
  const filePath = requiredString(input.file, "verify_file requires file.");
  const verification = verifyParseForFile(filePath, readFileSync(filePath, "utf8"));
  return {
    success: true,
    file: filePath,
    parse_verified: verification.verified,
    ...(verification.parser ? { parser: verification.parser } : {}),
  };
}

function runRefactorStateTool(args: unknown): unknown {
  const input = recordInput(args, "refactor_state");
  return runRefactorState(requiredString(input.file, "refactor_state requires file."), {
    cluster: optionalString(input.cluster),
    to: optionalString(input.to),
    name: optionalString(input.name),
    ...writeFlagsFromInput(input),
  });
}

function runExtractPlanTool(args: unknown): unknown {
  const input = recordInput(args, "extract_plan");
  const planOut = requiredString(input.planOut, "extract_plan requires planOut.");
  const options = extractOptionsFromInput(input);
  const plan = buildExtractComponentPlan(options);
  writePlanFile(planOut, plan, booleanValue(input.overwrite));
  return { success: true, plan: planOut, ...plan };
}

function runApplyPlanTool(args: unknown): unknown {
  const input = recordInput(args, "apply_plan");
  const planPath = requiredString(pick(input, "plan", "file", "path"), "apply_plan requires plan, file, or path.");
  return applyRefactorPlan(planPath, {
    ...writeFlagsFromInput(input),
    overwrite: booleanValue(input.overwrite),
    only: stringArray(input.only, "only"),
    skip: stringArray(input.skip, "skip"),
  });
}

function runWorkspaceTool(args: unknown): unknown {
  const input = recordInput(args, "chain_workspace");
  const steps = input.steps ?? input.flow;
  if (!Array.isArray(steps)) fail("INVALID_MCP_INPUT", "chain_workspace requires steps or flow array.");
  return runWorkspaceFlow(steps as WorkspaceFlowStep[], {
    params: recordOrUndefined(input.params, "chain_workspace params"),
    ...writeFlagsFromInput(input),
  });
}

function extractOptionsFromInput(input: JsonRecord): ExtractOptions {
  const exportKind = pick(input, "exportKind", "export") ?? "named";
  const helpersPolicy = pick(input, "helpersPolicy", "helpers") ?? "ask";
  if (exportKind !== "named" && exportKind !== "default") fail("INVALID_MCP_INPUT", "extract export/exportKind must be named or default.");
  if (helpersPolicy !== "ask" && helpersPolicy !== "move" && helpersPolicy !== "share" && helpersPolicy !== "as-prop") {
    fail("INVALID_MCP_INPUT", "extract helpers/helpersPolicy must be ask, move, share, or as-prop.");
  }
  return {
    from: requiredString(input.from, "extract requires from."),
    selector: requiredString(input.selector, "extract requires selector."),
    to: requiredString(input.to, "extract requires to."),
    name: requiredString(input.name, "extract requires name."),
    exportKind: exportKind as "named" | "default",
    slots: stringArray(input.slots ?? input.slot, "slots"),
    ...(input.depth === undefined ? {} : { depth: optionalInteger(input.depth, "depth") }),
    autoSlot: booleanValue(input.autoSlot),
    typecheck: booleanValue(input.typecheck),
    helpersPolicy: helpersPolicy as HelperPolicy,
    helperOverrides: stringArray(input.helperOverrides ?? input.helper, "helperOverrides"),
    overwrite: booleanValue(input.overwrite),
    acceptLargeProps: booleanValue(input.acceptLargeProps),
    ...(input.maxProps === undefined ? {} : { maxProps: optionalInteger(input.maxProps, "maxProps") }),
  };
}

function runExtractTool(args: unknown): unknown {
  const input = recordInput(args, "extract");
  const step: WorkspaceFlowStep = {
    action: "extract",
    from: requiredString(input.from, "extract requires from."),
    selector: requiredString(input.selector, "extract requires selector."),
    to: requiredString(input.to, "extract requires to."),
    name: requiredString(input.name, "extract requires name."),
    ...(input.export === undefined ? {} : { export: input.export as "named" | "default" }),
    ...(input.exportKind === undefined ? {} : { exportKind: input.exportKind as "named" | "default" }),
    ...(input.slots === undefined ? {} : { slots: input.slots }),
    ...(input.slot === undefined ? {} : { slot: input.slot }),
    ...(input.depth === undefined ? {} : { depth: input.depth }),
    ...(input.autoSlot === undefined ? {} : { autoSlot: input.autoSlot }),
    ...(input.helpers === undefined ? {} : { helpers: input.helpers as WorkspaceFlowStep["helpers"] }),
    ...(input.helpersPolicy === undefined ? {} : { helpersPolicy: input.helpersPolicy as WorkspaceFlowStep["helpersPolicy"] }),
    ...(input.helper === undefined ? {} : { helper: input.helper }),
    ...(input.helperOverrides === undefined ? {} : { helperOverrides: input.helperOverrides }),
    ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
    ...(input.typecheck === undefined ? {} : { typecheck: input.typecheck }),
    ...(input.maxProps === undefined ? {} : { maxProps: input.maxProps }),
    ...(input.acceptLargeProps === undefined ? {} : { acceptLargeProps: input.acceptLargeProps }),
  };
  return runWorkspaceFlow([step], writeFlagsFromInput(input));
}

function singleStepTool(config: SingleStepConfig): TeditMcpTool {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    annotations: config.readOnly ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true } : undefined,
    handler: (args) => {
      const input = recordInput(args, config.name);
      return runWorkspaceFlow([config.buildStep(input)], writeFlagsFromInput(input));
    },
  };
}

function resolveEditStrategy(input: JsonRecord): BaseFindStrategy {
  const find = pick(input, "find");
  const findExact = pick(input, "findExact", "find-exact", "find_exact");
  const findFuzzy = pick(input, "findFuzzy", "find-fuzzy", "find_fuzzy");
  const findAnchorAfter = pick(input, "findAnchorAfter", "find-anchor-after", "find_anchor_after");
  const findRegex = pick(input, "findRegex", "find-regex", "find_regex");
  const findLines = pick(input, "findLines", "find-lines", "find_lines");
  const explicitCount = [findExact, findFuzzy, findAnchorAfter, findRegex, findLines].filter((value) => value !== undefined).length;

  if (explicitCount > 1) fail("INVALID_MCP_INPUT", "edit accepts only one find strategy.");
  if (find !== undefined && explicitCount > 0 && findAnchorAfter === undefined) {
    fail("INVALID_MCP_INPUT", "edit find is exact unless paired with findAnchorAfter.");
  }

  if (findAnchorAfter !== undefined) {
    const contains = pick(input, "contains", "find");
    if (contains === undefined) fail("INVALID_MCP_INPUT", "edit findAnchorAfter requires contains or find.");
    return {
      kind: "anchor",
      after: requiredString(findAnchorAfter, "edit findAnchorAfter must be a string."),
      contains: requiredString(contains, "edit contains/find must be a string."),
    };
  }
  if (findExact !== undefined) {
    return {
      kind: "exact",
      pattern: requiredString(findExact, "edit findExact must be a string."),
      autoFuzzy: !booleanValue(pick(input, "noFuzzyFallback", "no-fuzzy-fallback", "no_fuzzy_fallback")),
    };
  }
  if (findFuzzy !== undefined) return { kind: "fuzzy", pattern: requiredString(findFuzzy, "edit findFuzzy must be a string."), ignoreWhitespace: true };
  if (findRegex !== undefined) {
    return {
      kind: "regex",
      pattern: requiredString(findRegex, "edit findRegex must be a string."),
      ...(input.flags === undefined ? {} : { flags: String(input.flags) }),
    };
  }
  if (findLines !== undefined) return { kind: "lines", ...parseLineRange(requiredString(findLines, "edit findLines must be a string.")) };
  if (find !== undefined) {
    return {
      kind: "exact",
      pattern: requiredString(find, "edit find must be a string."),
      autoFuzzy: !booleanValue(pick(input, "noFuzzyFallback", "no-fuzzy-fallback", "no_fuzzy_fallback")),
    };
  }

  fail("INVALID_MCP_INPUT", "edit requires find, findExact, findFuzzy, findAnchorAfter, findRegex, or findLines.");
}

function resolveEditMutation(input: JsonRecord): BaseEditMutation {
  const replace = pick(input, "replace");
  const insertBefore = pick(input, "insertBefore", "insert-before", "insert_before");
  const insertAfter = pick(input, "insertAfter", "insert-after", "insert_after");
  const shouldDelete = booleanValue(input.delete);
  const count = [replace !== undefined, insertBefore !== undefined, insertAfter !== undefined, shouldDelete].filter(Boolean).length;

  if (count !== 1) fail("INVALID_MCP_INPUT", "edit requires exactly one of replace, insertBefore, insertAfter, or delete.");
  if (replace !== undefined) return { kind: "replace", text: String(replace) };
  if (insertBefore !== undefined) return { kind: "insert-before", text: String(insertBefore) };
  if (insertAfter !== undefined) return { kind: "insert-after", text: String(insertAfter) };
  return { kind: "delete" };
}

function targetOnlySchema(): z.ZodRawShape {
  return { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), ...writeFlagSchema };
}

function importsSchema(options: { requireName?: boolean; requireTo?: boolean } = {}): z.ZodRawShape {
  return {
    file: fileSchema,
    from: z.string().min(1),
    to: options.requireTo ? z.string().min(1) : z.string().optional(),
    named: z.union([z.string(), z.array(z.string())]).optional(),
    default: z.string().optional(),
    namespace: z.string().optional(),
    name: options.requireName ? z.string().min(1) : z.string().optional(),
    value: z.string().optional(),
    ...writeFlagSchema,
  };
}

function exprSchema(options: { code?: boolean } = {}): z.ZodRawShape {
  return {
    file: fileSchema,
    selector: selectorSchema.optional(),
    target: targetSchema.optional(),
    id: targetSchema.optional(),
    code: options.code ? z.string().min(1) : z.string().optional(),
    ...writeFlagSchema,
  };
}

function targetFromInput(input: JsonRecord, label: string): string {
  return requiredString(pick(input, "target", "id", "selector"), `${label} requires target, id, or selector.`);
}

function normalizeElementInput(value: unknown, message: string): WorkspaceFlowStep["element"] {
  const raw = requiredValue(value, message);
  if (typeof raw === "string") return parseElementShorthand(raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as WorkspaceFlowStep["element"];
  fail("INVALID_MCP_INPUT", "Element input must be a shorthand string or object spec.");
}
function propValue(input: JsonRecord): unknown {
  if (input.expr !== undefined && input.value !== undefined) fail("INVALID_MCP_INPUT", "prop_set accepts only one of value or expr.");
  if (input.expr !== undefined) return { type: "expr", code: requiredString(input.expr, "prop_set expr must be a string.") };
  if (input.value !== undefined) return input.value;
  return true;
}

function textSetValue(input: JsonRecord): { value?: string; expr?: string } {
  const hasValue = input.value !== undefined;
  const hasExpr = input.expr !== undefined;
  if (hasValue === hasExpr) fail("INVALID_MCP_INPUT", "text_set requires exactly one of value or expr.");
  if (hasExpr) return { expr: requiredString(input.expr, "text_set expr must be a string.") };
  return { value: requiredString(input.value, "text_set value must be a string.") };
}

function textMatch(input: JsonRecord): unknown {
  if (input.match !== undefined) return input.match;
  const matchText = input.matchText;
  const matchExpr = input.matchExpr;
  const matchAny = input.matchAny;
  const count = [matchText, matchExpr, matchAny].filter((value) => value !== undefined).length;
  if (count !== 1) fail("INVALID_MCP_INPUT", "text_replace requires match or exactly one of matchText, matchExpr, matchAny.");
  if (matchText !== undefined) return { kind: "text", value: requiredString(matchText, "matchText must be a string.") };
  if (matchExpr !== undefined) return { kind: "expr", code: requiredString(matchExpr, "matchExpr must be a string.") };
  return { kind: "any", value: requiredString(matchAny, "matchAny must be a string.") };
}

function textReplacement(input: JsonRecord): unknown {
  if (input.with !== undefined) return input.with;
  const withText = input.withText;
  const withExpr = input.withExpr;
  const count = [withText, withExpr].filter((value) => value !== undefined).length;
  if (count !== 1) fail("INVALID_MCP_INPUT", "text_replace requires with or exactly one of withText, withExpr.");
  if (withText !== undefined) return { kind: "text", value: requiredString(withText, "withText must be a string.") };
  return { kind: "expr", code: requiredString(withExpr, "withExpr must be a string.") };
}

function importFields(input: JsonRecord): Pick<WorkspaceFlowStep, "from" | "to" | "named" | "default" | "namespace" | "name" | "value"> {
  return {
    from: requiredString(input.from, "imports tools require from."),
    ...(input.to === undefined ? {} : { to: requiredString(input.to, "to must be a string.") }),
    ...(input.named === undefined ? {} : { named: input.named as string | string[] }),
    ...(input.default === undefined ? {} : { default: requiredString(input.default, "default must be a string.") }),
    ...(input.namespace === undefined ? {} : { namespace: requiredString(input.namespace, "namespace must be a string.") }),
    ...(input.name === undefined ? {} : { name: requiredString(input.name, "name must be a string.") }),
    ...(input.value === undefined ? {} : { value: requiredString(input.value, "value must be a string.") }),
  };
}

function writeFlagsFromInput(input: JsonRecord): WorkspaceFlowOptions {
  const write = booleanValue(input.write);
  const dryRun = booleanValue(pick(input, "dryRun", "dry-run", "dry_run"));
  if (write && dryRun) fail("INVALID_MCP_INPUT", "Use only one of write or dryRun.");
  return {
    write,
    dryRun,
    backup: booleanValue(input.backup),
    noBackup: booleanValue(pick(input, "noBackup", "no-backup", "no_backup")),
  };
}

function recordInput(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_MCP_INPUT", `${label} arguments must be an object.`);
  }
  return value as JsonRecord;
}

function optionalRecordInput(value: unknown, label: string): JsonRecord {
  if (value === undefined || value === null) return {};
  return recordInput(value, label);
}

function recordOrUndefined(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_MCP_INPUT", `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function pick(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function requiredValue(value: unknown, message: string): unknown {
  if (value === undefined) fail("INVALID_MCP_INPUT", message);
  return value;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) fail("INVALID_MCP_INPUT", message);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  fail("INVALID_MCP_INPUT", `${label} must be a string or string array.`);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, "Expected a string.");
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) fail("INVALID_MCP_INPUT", `${label} must be an integer.`);
  return numberValue;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}
