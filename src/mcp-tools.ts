import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { z } from "zod/v4";
import {
  BASE_ACTIONS,
  parseLineRange,
  parseVerificationFields,
  verifyParseForFile,
  type BaseEditMutation,
  type BaseFindStrategy,
  type ParseVerificationFields,
} from "./base-edit.js";
import { fileChainToWorkspaceFlow, parseChainSegments, parseChainText, parseElementShorthand, workspaceChainToFlow } from "./chain.js";
import { getOptionalAdapterForFile } from "./core/registry.js";
import { runAstEdit as runAstEditEngine, runAstSelect, runScanStrings } from "./ast-tools.js";
import { inspectFileOverview, inspectRange, searchText } from "./search-tools.js";
import { historyTrace } from "./history-tools.js";
import { runTsEdit as runTsEditEngine, runTsMove as runTsMoveEngine, runTsRename as runTsRenameEngine, runTsSelect } from "./ts-tools.js";
import { unifiedDiff } from "./diff.js";
import { runBaseEditOperation } from "./edit-engine.js";
import { fail } from "./errors.js";
import { formatAgentResult, outputOptionsFromRecord, readDetailArtifact } from "./output.js";
import { parseMultieditInput, runMultiedit, runMultieditInput } from "./multiedit.js";
import { parsePatchInput, runPatchInput } from "./patch.js";
import { analyzeState, qualityWarnings } from "./quality.js";
import { runRefactorState } from "./refactor-state.js";
import { applyRefactorPlan, buildExtractComponentPlan, buildRefactorStatePlan, writePlanFile } from "./refactor-plan.js";
import { buildModuleSplitPlan, buildTsModuleGraph, runExtractArrayEntries, runMoveSymbols, type ExtractArrayEntriesOperation, type MoveSymbolsOperation } from "./ts-module-refactor.js";
import type { ExtractOptions, HelperPolicy } from "./extract.js";
import { runWorkspaceFlow, type WorkspaceFlowOptions, type WorkspaceFlowStep } from "./workspace-flow.js";
import { buildScaffoldSource, listTemplates, loadTemplateSpec, parseParams, type ScaffoldSpec } from "./scaffold.js";
import { maybeWriteBackup, resolveWritePolicy, writePolicyReport, type BackupResult } from "./write-policy.js";
import { applyPostVerify, captureRestorePoints, verifySpecFromInput, type RestorePoint } from "./verify-command.js";
import { attachDryRunApplySuggestion, loadDryRunApply } from "./dry-run-apply.js";
import { makeEDIT_TOOLS } from "./mcp/tools/edit.js";
import { makeGENERATE_TOOLS } from "./mcp/tools/generate.js";
import { makeDISCOVERY_TOOLS } from "./mcp/tools/discovery.js";
import { makeAST_TOOLS } from "./mcp/tools/ast.js";
import { makeREFACTOR_TOOLS } from "./mcp/tools/refactor.js";
import { makeREFACTOR_PLAN_TOOLS } from "./mcp/tools/refactor.js";
import { makeJSX_TOOLS } from "./mcp/tools/jsx.js";
import { makeJSX_SINGLE_STEP_TOOLS } from "./mcp/tools/jsx-single-step.js";
import { makeVERIFY_TOOLS } from "./mcp/tools/verify.js";
import { isDefaultMcpToolName, MCP_WRITE_BY_DEFAULT, teditMcpProfileFromEnv, type TeditMcpProfile } from "./mcp/profile.js";
import { makeWORKFLOW_TOOLS } from "./mcp/tools/workflow.js";

export { teditMcpProfileFromEnv } from "./mcp/profile.js";
export type { TeditMcpProfile } from "./mcp/profile.js";

export type TeditMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  category?: "edit" | "generate" | "discover" | "verify" | "structure" | "ast" | "refactor" | "workflow";
  exposure?: "default" | "advanced";
  action?: string;
  aliases?: readonly string[];
  bestFor?: readonly string[];
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: unknown) => unknown;
};

type JsonRecord = Record<string, unknown>;
type WriteFlagOptions = { defaultWrite?: boolean };

const MUTATE_JSX_OPS = [
  "prop.set", "prop.remove", "class.add", "class.remove", "class.replace",
  "text.set", "text.replace", "expr.replace", "expr.wrap", "expr.unwrap", "expr.toTernary", "expr.toShortCircuit",
  "wrap", "unwrap", "rename", "remove", "append", "prepend", "insertComment",
] as const;
const MUTATE_IMPORT_OPS = ["imports.add", "imports.remove", "imports.rename", "imports.move"] as const;
const MUTATE_TS_OPS = ["body.replace", "body.insertBefore", "body.insertAfter", "declaration.move", "declaration.rename"] as const;
const MUTATE_AST_OPS = ["ast.replace"] as const;
const MUTATE_SUPPORTED_OPS = [...MUTATE_JSX_OPS, ...MUTATE_IMPORT_OPS, ...MUTATE_TS_OPS, ...MUTATE_AST_OPS] as const;
const MUTATE_OP_ALIASES = new Map<string, string>([
  ...MUTATE_SUPPORTED_OPS.map((op) => [op, op] as const),
  ["replace-body", "body.replace"],
  ["insert-before", "body.insertBefore"],
  ["insert-after", "body.insertAfter"],
  ["symbol.rename", "declaration.rename"],
]);
const MUTATE_JSX_TARGETS = "jsx:<selector> or id:jsx:<id>";
const MUTATE_TS_TARGETS = "fn:<name>, class:<name>, method:<owner.name>, prop:<name>, or var:<name>";
const MUTATE_AST_TARGETS = "ast:<selector>, string:<exact>, contains:<text>, jsxText:<text>, jsxAttr:<name>, objectKey:<key>, or call:<callee>";

type VerifyFileEntry = { file: string } & ParseVerificationFields & { warnings: unknown[] };

type SingleStepConfig = {
  name: string;
  title: string;
  action: string;
  description: string;
  inputSchema: z.ZodRawShape;
  readOnly?: boolean;
  category?: TeditMcpTool["category"];
  exposure?: TeditMcpTool["exposure"];
  aliases?: readonly string[];
  bestFor?: readonly string[];
  buildStep: (input: JsonRecord) => WorkspaceFlowStep;
};

const detailFlagSchema = {
  detailFieldMaxBytes: z.number().int().positive().optional().describe("Compact output stores individual fields larger than this many JSON bytes as read_detail artifacts. Defaults to 4096."),
  detailArtifactDir: z.string().min(1).optional().describe("Artifact directory for large compact-output fields; must stay inside the current working directory."),
} satisfies z.ZodRawShape;

const verifyCommandSchema = z.union([
  z.string().min(1),
  z.array(z.string()).min(1),
  z.object({
    command: z.string().min(1).optional(),
    cmd: z.union([z.string().min(1), z.array(z.string()).min(1)]).optional(),
    args: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    cwd: z.string().min(1).optional(),
    rollbackOnFail: z.boolean().optional(),
    rollback_on_fail: z.boolean().optional(),
    rollbackOnVerifyFail: z.boolean().optional(),
    rollback_on_verify_fail: z.boolean().optional(),
  }).passthrough(),
]);

const writeFlagSchema = {
  write: z.boolean().optional().describe("Write changes when true; otherwise git-aware defaults apply."),
  dryRun: z.boolean().optional().describe("Force dry-run mode."),
  backup: z.boolean().optional().describe("Force .tedit.bak backup creation."),
  noBackup: z.boolean().optional().describe("Disable .tedit.bak backup creation."),
  output: z.enum(["compact", "detailed"]).optional().describe("Response shape. MCP defaults to compact; use detailed for legacy full diffs and internals."),
  includeDiffs: z.boolean().optional().describe("Legacy detailed-diff opt-in. Prefer diffMode for compact agent responses."),
  includeDetails: z.boolean().optional().describe("Return the detailed response shape."),
  diffMode: z.enum(["off", "stats", "auto", "full"]).optional().describe("Compact diff payload policy. Defaults to auto: inline small diffs and spill large write diffs to .tedit/cache/diffs artifacts. Use stats to keep counts only."),
  inlineDiffMaxBytes: z.number().int().positive().optional().describe("Maximum diff bytes to inline when diffMode is auto."),
  inlineDiffMaxHunks: z.number().int().positive().optional().describe("Maximum hunk count to inline when diffMode is auto."),
  diffArtifactDir: z.string().min(1).optional().describe("Artifact directory for large auto diffs; must stay inside the current working directory."),
  diffArtifacts: z.boolean().optional().describe("Allow large diff artifact writes. Dry-runs only write artifacts when this is explicitly true."),
  ...detailFlagSchema,
  verify: verifyCommandSchema.optional().describe("Optional post-write verify command: string, argv array, or {cmd, args, timeoutMs, cwd, rollbackOnFail}. Runs only after files are written."),
  verifyCommand: verifyCommandSchema.optional().describe("Alias for verify. Prefer verify.cmd as an argv array for safer execution."),
  verify_command: verifyCommandSchema.optional().describe("Alias for verifyCommand."),
  rollbackOnVerifyFail: z.boolean().optional().describe("Top-level rollback alias for verify command strings/arrays. Prefer verify.rollbackOnFail."),
  rollback_on_verify_fail: z.boolean().optional().describe("Alias for rollbackOnVerifyFail."),
} satisfies z.ZodRawShape;

const fileSchema = z.string().min(1).describe("Target file path.");
const targetSchema = z.string().min(1).describe("Selector or previously returned node id.");
const selectorSchema = z.string().min(1).describe("Structural selector.");
const valueSchema = z.unknown().describe("Literal value or tedit value spec.");
const elementSchema = z.unknown().describe("Element shorthand string or tree node spec.");

export const TEDIT_MCP_ALL_TOOLS: readonly TeditMcpTool[] = [
  ...makeEDIT_TOOLS({ fileSchema, runApplyDryRunTool, runDeleteFileTool, runEditTool, runFlowTool, runMultieditTool, runMutateTool, runPatchTool, runRenameFileTool, writeFlagSchema }),
  ...makeGENERATE_TOOLS({ fileSchema, runCreateFileTool, runFileWriteTool, runNewFileTool, runScaffoldFileTool, runWriteFileTool, writeFlagSchema }),
  ...makeDISCOVERY_TOOLS({ detailFlagSchema, fileSchema, runActionsTool, runHistoryTraceTool, runInspectRangeTool, runReadDetailTool, runScanStringsTool, runSearchTextTool, runSearchTool, runSelectTool, runTemplatesTool }),
  ...makeAST_TOOLS({ detailFlagSchema, fileSchema, runAstEditTool, runAstSelectTool, runTsEditTool, runTsMoveTool, runTsSelectTool, writeFlagSchema }),
  ...makeREFACTOR_TOOLS({ fileSchema, runAnalyzeStateTool, runRefactorTool, selectorSchema, writeFlagSchema }),
  ...makeVERIFY_TOOLS({ fileSchema, runVerifyFileTool }),

  ...makeREFACTOR_PLAN_TOOLS({ fileSchema, runApplyPlanTool, runExtractPlanTool, runRefactorStatePlanTool, runRefactorStateTool, selectorSchema, writeFlagSchema }),

  ...makeWORKFLOW_TOOLS({ runWorkspaceTool, writeFlagSchema }),
  ...makeJSX_SINGLE_STEP_TOOLS({ booleanValue, classNamesInput, elementSchema, exprSchema, fileSchema, importFields, importsSchema, normalizeElementInput, pick, propValue, requiredString, selectorSchema, singleStepTool, targetFromInput, targetOnlySchema, targetSchema, textMatch, textReplacement, textSetValue, valueSchema, writeFlagSchema }),
  ...makeJSX_TOOLS({ elementSchema, fileSchema, importsSchema, runExtractComponentTool, runExtractTool, runImportsTool, runJsxAttrTool, runJsxContentTool, runJsxNodeTool, runJsxSelectTool, selectorSchema, targetSchema, valueSchema, writeFlagSchema }),
];

export function toolsForMcpProfile(profile: TeditMcpProfile = teditMcpProfileFromEnv()): readonly TeditMcpTool[] {
  return profile === "all" ? TEDIT_MCP_ALL_TOOLS : TEDIT_MCP_ALL_TOOLS.filter((tool) => toolExposure(tool) === "default");
}

export const TEDIT_MCP_TOOLS: readonly TeditMcpTool[] = toolsForMcpProfile();
export const TEDIT_MCP_TOOL_NAMES = TEDIT_MCP_ALL_TOOLS.map((tool) => tool.name);

export function runMcpTool(name: string, args: unknown): unknown {
  const tool = TEDIT_MCP_ALL_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) fail("UNKNOWN_MCP_TOOL", `Unknown tedit MCP tool: ${name}`, { tools: TEDIT_MCP_TOOL_NAMES });
  return attachDryRunApplySuggestion(name, args, tool.handler(args));
}

function runApplyDryRunTool(args: unknown): unknown {
  const input = recordInput(args, "apply_dry_run");
  const apply = loadDryRunApply(requiredString(input.id, "apply_dry_run requires id."));
  return runMcpTool(apply.tool, apply.args);
}

function runCreateFileTool(args: unknown): unknown {
  const input = recordInput(args, "create_file");
  return runWholeFileTool(input, "create_file", "create", requiredString(input.source, "create_file requires source."));
}

function runWriteFileTool(args: unknown): unknown {
  const input = recordInput(args, "write_file");
  return runWholeFileTool(input, "write_file", "write", requiredString(input.source, "write_file requires source."));
}

function runScaffoldFileTool(args: unknown): unknown {
  const input = recordInput(args, "scaffold_file");
  const spec = scaffoldSpecFromInput(input);
  return runWholeFileTool(input, "scaffold_file", "scaffold", buildScaffoldSource(spec), { spec });
}

function runNewFileTool(args: unknown): unknown {
  const input = recordInput(args, "new_file");
  const template = requiredString(input.template, "new_file requires template.");
  const spec = loadTemplateSpec(template, templateParamsFromInput(input.params), optionalString(input.cwd) ?? process.cwd());
  return runWholeFileTool(input, "new_file", "new", buildScaffoldSource(spec), { template, spec });
}

function runFileWriteTool(args: unknown): unknown {
  const input = recordInput(args, "file_write");
  const mode = requiredString(input.mode, "file_write requires mode: write, scaffold, or template.");
  if (mode === "write") {
    return runWholeFileTool(input, "file_write", "write", requiredString(input.source, "file_write mode=write requires source."));
  }
  if (mode === "scaffold") {
    const spec = scaffoldSpecFromInput(input, "file_write mode=scaffold");
    return runWholeFileTool(input, "file_write", "scaffold", buildScaffoldSource(spec), { spec });
  }
  if (mode === "template") {
    const template = requiredString(input.template, "file_write mode=template requires template.");
    const spec = loadTemplateSpec(template, templateParamsFromInput(input.params), optionalString(input.cwd) ?? process.cwd());
    return runWholeFileTool(input, "file_write", "new", buildScaffoldSource(spec), { template, spec });
  }
  fail("INVALID_MCP_INPUT", "file_write mode must be write, scaffold, or template.");
}

function runWholeFileTool(input: JsonRecord, label: string, kind: string, source: string, extraResult: Record<string, unknown> = {}): unknown {
  const filePath = requiredString(input.file, label + " requires file.");
  const existed = existsSync(filePath);
  const restorePoints = captureRestorePoints([filePath]);
  if (existed && !booleanValue(input.overwrite)) {
    fail("FILE_EXISTS", "Refusing to overwrite existing file: " + filePath + ". Pass overwrite=true to bypass.");
  }

  const parseVerification = verifyParseForFile(filePath, source);
  const previous = existed ? readFileSync(filePath, "utf8") : "";
  const changed = previous !== source;
  const diff = unifiedDiff(previous, source, filePath);
  const warnings = qualityWarnings(filePath, previous, source);
  const policy = resolveWritePolicy(filePath, writeFlagsFromInput(input));
  const shouldWrite = policy.write;
  let backup: BackupResult = {};

  if (shouldWrite && changed) {
    backup = maybeWriteBackup(filePath, previous, policy, changed, source);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
  }

  return withVerifiedAgentFields({
    success: true,
    file: filePath,
    existed,
    changed,
    written: shouldWrite && changed,
    ...parseVerificationFields(parseVerification),
    result: { kind, ...extraResult },
    warnings,
    write_policy: writePolicyReport(policy, backup),
    ...(diff ? { diff } : {}),
  }, input, restorePoints);
}

function runEditTool(args: unknown): unknown {
  const input = recordInput(args, "edit");
  const filePath = requiredString(input.file, "edit requires file.");
  const restorePoints = captureRestorePoints([filePath]);
  const expectCountValue = pick(input, "expectCount", "expect-count", "expect_count");
  const expectCount = optionalInteger(expectCountValue, "expectCount");
  const { result } = runBaseEditOperation({
    filePath,
    strategy: resolveEditStrategy(input),
    mutation: resolveEditMutation(input),
    replaceAll: booleanValue(pick(input, "replaceAll", "replace-all", "replace_all")),
    ...(expectCountValue === undefined ? {} : { expectCount }),
    writeFlags: writeFlagsFromInput(input, MCP_WRITE_BY_DEFAULT),
  });

  return withVerifiedAgentFields(result, input, restorePoints);
}

function runMultieditTool(args: unknown): unknown {
  const input = recordInput(args, "multiedit");
  const restorePoints = captureRestorePoints(multieditFilesFromInput(input));
  if (input.input !== undefined && input.edits !== undefined) {
    fail("INVALID_MCP_INPUT", "multiedit accepts only one of input or edits.");
  }
  if (input.input !== undefined) return withVerifiedAgentFields(runMultieditInput(requiredString(input.input, "multiedit input must be a string."), writeFlagsFromInput(input, MCP_WRITE_BY_DEFAULT)), input, restorePoints);
  const edits = input.edits;
  if (!Array.isArray(edits)) fail("INVALID_MCP_INPUT", "multiedit requires edits array or input string.");
  return withVerifiedAgentFields(runMultiedit(edits, writeFlagsFromInput(input, MCP_WRITE_BY_DEFAULT)), input, restorePoints);
}

function runPatchTool(args: unknown): unknown {
  const input = recordInput(args, "patch");
  const patch = requiredString(input.patch, "patch requires patch.");
  const restorePoints = captureRestorePoints(patchFilesForRestore(patch));
  return withVerifiedAgentFields(runPatchInput(patch, writeFlagsFromInput(input)), input, restorePoints);
}

function runFlowTool(args: unknown): unknown {
  const input = recordInput(args, "flow");
  const steps = flowStepsFromInput(input);
  return withAgentFields(runWorkspaceFlow(steps, {
    params: recordOrUndefined(input.params, "flow params"),
    ...writeFlagsFromInput(input, MCP_WRITE_BY_DEFAULT),
  }), input);
}

function runMutateTool(args: unknown): unknown {
  const input = recordInput(args, "mutate");
  const file = requiredString(input.file, "mutate requires file.");
  const { op, args: opArgs } = mutateOperationFromInput(input);
  if (!MUTATE_SUPPORTED_OPS.includes(op as typeof MUTATE_SUPPORTED_OPS[number])) mutateUnsupportedOp(op);

  if (isMutateJsxOp(op)) {
    const target = mutateJsxTarget(input.target, file, op, opArgs);
    return withAgentFields(runWorkspaceFlow([mutateJsxStep(file, op, target, opArgs)], writeFlagsFromInput(input, MCP_WRITE_BY_DEFAULT)), input);
  }

  if (isMutateImportOp(op)) {
    validateMutateImportArgs(op, opArgs);
    return withAgentFields(runWorkspaceFlow([{ action: op, file, ...importFields(opArgs) }], writeFlagsFromInput(input, MCP_WRITE_BY_DEFAULT)), input);
  }

  if (op === "ast.replace") return runAstEditTool({ ...input, ...mutateAstTarget(input.target, op), replace: requiredString(pick(opArgs, "replace", "value", "text"), 'mutate op "ast.replace" requires args.replace, args.value, or args.text.') }, MCP_WRITE_BY_DEFAULT);

  if (op === "body.replace") return runTsEditTool({ ...input, selector: mutateTsSelector(input.target, file, op), action: "replace-body", body: requiredString(pick(opArgs, "body", "value", "code"), 'mutate op "body.replace" requires args.body, args.value, or args.code.') });
  if (op === "body.insertBefore") return runTsEditTool({ ...input, selector: mutateTsSelector(input.target, file, op), action: "insert-before", insertBefore: requiredString(pick(opArgs, "insertBefore", "body", "value", "code"), 'mutate op "body.insertBefore" requires args.insertBefore, args.body, args.value, or args.code.') });
  if (op === "body.insertAfter") return runTsEditTool({ ...input, selector: mutateTsSelector(input.target, file, op), action: "insert-after", insertAfter: requiredString(pick(opArgs, "insertAfter", "body", "value", "code"), 'mutate op "body.insertAfter" requires args.insertAfter, args.body, args.value, or args.code.') });
  if (op === "declaration.move") return runTsMoveTool({ ...input, target: mutateTsSelector(input.target, file, op), before: optionalString(opArgs.before), after: optionalString(opArgs.after), take: opArgs.take, drop: opArgs.drop, confirmTrivia: booleanValue(opArgs.confirmTrivia), sourceHash: optionalString(opArgs.sourceHash), includeTriviaContent: booleanValue(opArgs.includeTriviaContent) });
  if (op === "declaration.rename") return runTsRenameTool({ ...input, selector: mutateTsSelector(input.target, file, op), to: requiredString(pick(opArgs, "to", "name"), 'mutate op "declaration.rename" requires args.to or args.name.') });

  mutateUnsupportedOp(op);
}

function mutateOperationFromInput(input: JsonRecord): { op: string; args: JsonRecord } {
  if (input.op !== undefined) {
    const op = normalizeMutateOp(requiredString(input.op, "mutate requires op."));
    return { op, args: recordOrUndefined(input.args, "mutate args") ?? recordOrUndefined(input[op], `mutate ${op} args`) ?? {} };
  }
  const opKeys = Object.keys(input).filter((key) => MUTATE_OP_ALIASES.has(key));
  if (opKeys.length === 1) return { op: normalizeMutateOp(opKeys[0]), args: recordOrUndefined(input[opKeys[0]], `mutate ${opKeys[0]} args`) ?? {} };
  if (opKeys.length > 1) fail("INVALID_MCP_INPUT", `mutate accepts only one operation key. Found: ${opKeys.join(", ")}.`);
  fail("INVALID_MCP_INPUT", 'mutate requires op+args or one operation key like {"prop.set":{"name":"disabled","value":true}}.');
}

function normalizeMutateOp(op: string): string {
  return MUTATE_OP_ALIASES.get(op) ?? op;
}

function isMutateJsxOp(op: string): op is typeof MUTATE_JSX_OPS[number] {
  return (MUTATE_JSX_OPS as readonly string[]).includes(op);
}

function isMutateImportOp(op: string): op is typeof MUTATE_IMPORT_OPS[number] {
  return (MUTATE_IMPORT_OPS as readonly string[]).includes(op);
}

function validateMutateImportArgs(op: typeof MUTATE_IMPORT_OPS[number], args: JsonRecord): void {
  if (op === "imports.add" && args.from === undefined) fail("INVALID_MCP_INPUT", 'mutate op "imports.add" requires args.from.');
  if (op === "imports.remove" && args.from === undefined) fail("INVALID_MCP_INPUT", 'mutate op "imports.remove" requires args.from.');
  if (op === "imports.rename" && (args.from === undefined || args.name === undefined || args.to === undefined)) {
    fail("INVALID_MCP_INPUT", 'mutate op "imports.rename" requires args.from, args.name, and args.to. Example: {"imports.rename":{"from":"./old","name":"OldName","to":"NewName"}}');
  }
  if (op === "imports.move" && (args.from === undefined || args.to === undefined)) fail("INVALID_MCP_INPUT", 'mutate op "imports.move" requires args.from and args.to.');
}

function mutateJsxStep(file: string, op: typeof MUTATE_JSX_OPS[number], target: string, args: JsonRecord): WorkspaceFlowStep {
  if (op === "prop.set") return { action: "prop.set", file, target, name: requiredString(args.name, 'mutate op "prop.set" requires args.name. Example: {"args":{"name":"disabled","value":true}}'), value: propValue(args) };
  if (op === "prop.remove") return { action: "prop.remove", file, target, name: requiredString(args.name, 'mutate op "prop.remove" requires args.name. Example: {"args":{"name":"disabled"}}') };
  if (op === "class.add") return { action: "class.add", file, target, classes: classNamesInput(args, 'mutate op "class.add"') };
  if (op === "class.remove") return { action: "class.remove", file, target, classes: classNamesInput(args, 'mutate op "class.remove"') };
  if (op === "class.replace") return { action: "class.replace", file, target, from: requiredString(args.from, 'mutate op "class.replace" requires args.from. Example: {"args":{"from":"old","to":"new"}}'), to: requiredString(args.to, 'mutate op "class.replace" requires args.to. Example: {"args":{"from":"old","to":"new"}}') };
  if (op === "text.set") return { action: "text.set", file, target, ...textSetValue(args) };
  if (op === "text.replace") return { action: "text.replace", file, target, match: textMatch(args) as WorkspaceFlowStep["match"], with: textReplacement(args) as WorkspaceFlowStep["with"] };
  if (op === "expr.replace") return { action: "expr.replace", file, target, code: requiredString(args.code, 'mutate op "expr.replace" requires args.code.') };
  if (op === "expr.wrap") return { action: "expr.wrap", file, target, code: requiredString(args.code, 'mutate op "expr.wrap" requires args.code.') };
  if (op === "expr.unwrap") return { action: "expr.unwrap", file, target };
  if (op === "expr.toTernary") return { action: "expr.toTernary", file, target, ...(pick(args, "alternate", "value") === undefined ? {} : { value: String(pick(args, "alternate", "value")) }) };
  if (op === "expr.toShortCircuit") return { action: "expr.toShortCircuit", file, target };
  if (op === "wrap") return { action: "wrap", file, target, with: normalizeElementInput(pick(args, "with", "wrapper"), 'mutate op "wrap" requires args.with or args.wrapper.') };
  if (op === "unwrap") return { action: "unwrap", file, target };
  if (op === "rename") return { action: "rename", file, target, name: requiredString(pick(args, "to", "name"), 'mutate op "rename" requires args.to or args.name.') };
  if (op === "remove") return { action: "remove", file, target };
  if (op === "append") return { action: "append", file, target, element: normalizeElementInput(args.element, 'mutate op "append" requires args.element.') };
  if (op === "prepend") return { action: "prepend", file, target, element: normalizeElementInput(args.element, 'mutate op "prepend" requires args.element.') };
  if (op === "insertComment") return { action: "insertComment", file, target, text: requiredString(args.text, 'mutate op "insertComment" requires args.text.'), ...(args.position === undefined ? {} : { position: String(args.position) as WorkspaceFlowStep["position"] }) };
  mutateUnsupportedOp(op);
}

function mutateUnsupportedOp(op: string): never {
  fail("INVALID_MCP_INPUT", `mutate unsupported op: ${op}. Supported ops: ${MUTATE_SUPPORTED_OPS.join(", ")}.`, {
    supportedOps: [...MUTATE_SUPPORTED_OPS],
    validTargets: {
      jsx: MUTATE_JSX_TARGETS,
      ts: MUTATE_TS_TARGETS,
      ast: MUTATE_AST_TARGETS,
      imports: "target omitted",
    },
    suggestions: [
      'Use actions to inspect mutate examples, or use op="prop.set" with target="jsx:Button".',
      'For TS body replacement use op="body.replace" with target="fn:name" and args.body.',
      'For AST string replacement use op="ast.replace" with target="objectKey:label" and args.replace.',
    ],
  });
}

function mutateJsxTarget(value: unknown, file: string, op: string, opArgs: JsonRecord = {}): string {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as JsonRecord).id === "string") return mutateJsxTarget(`id:${(value as JsonRecord).id}`, file, op);
  if (value === undefined || value === false) mutateMissingTargetFail(op, file, opArgs);
  const raw = requiredString(value, `mutate op "${op}" requires target. Valid prefixes: ${mutateTargetHelp(op).prefixes.join(", ")}.`);
  const [prefix, rest] = splitTargetPrefix(raw);
  if (!prefix) mutateTargetFail(op, file, raw, prefix);
  if (prefix === "jsx") {
    assertJsxFile(file, prefix);
    return rest;
  }
  if (prefix === "id") {
    const [route, id] = splitTargetPrefix(rest);
    if (route === "jsx") {
      assertJsxFile(file, "id:jsx");
      return id;
    }
  }
  mutateTargetFail(op, file, raw, prefix);
}

function mutateMissingTargetFail(op: string, file: string, opArgs: JsonRecord): never {
  const help = mutateTargetHelp(op);
  const functionName = op === "text.replace" ? functionNameFromTextReplaceArgs(opArgs) : undefined;
  fail("INVALID_MCP_INPUT", `mutate op "${op}" requires target. Valid prefixes: ${help.prefixes.join(", ")}.`, {
    op,
    validPrefixes: help.prefixes,
    examples: help.examples,
    suggestions: [
      ...(functionName ? [`For replacing function ${functionName}, use mutate op="body.replace" target="fn:${functionName}" with args.body containing only the function body.`] : []),
      ...(functionName ? ["For exact whole-block text replacement, use edit with find/replace instead of mutate text.replace."] : []),
      "For JSX text replacement, pass target such as target=\"jsx:Button\" plus args.matchText/args.withText.",
      `Call select on ${file} first when the structural target is ambiguous.`,
    ],
  });
}

function functionNameFromTextReplaceArgs(args: JsonRecord): string | undefined {
  const source = typeof args.find === "string" ? args.find : typeof args.matchText === "string" ? args.matchText : undefined;
  return source?.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1];
}

function mutateTsSelector(value: unknown, file: string, op: string): string {
  const raw = requiredString(value, `mutate op "${op}" requires target. Valid prefixes: ${mutateTargetHelp(op).prefixes.join(", ")}.`);
  const [prefix] = splitTargetPrefix(raw);
  if (mutateTargetHelp(op).prefixes.map((item) => item.replace(/:$/, "")).includes(prefix ?? "")) return raw;
  mutateTargetFail(op, file, raw, prefix);
}

function mutateAstTarget(value: unknown, op: string): JsonRecord {
  const raw = requiredString(value, `mutate op "${op}" requires target. Valid prefixes: ${mutateTargetHelp(op).prefixes.join(", ")}.`);
  const [prefix, rest] = splitTargetPrefix(raw);
  if (prefix === "ast") return { selector: rest };
  if (prefix === "string") return { string: rest };
  if (prefix === "contains") return { contains: rest };
  if (prefix === "jsxText") return { jsxText: rest };
  if (prefix === "jsxAttr") return { jsxAttr: rest };
  if (prefix === "objectKey") return { objectKey: rest };
  if (prefix === "call") return { call: rest };
  mutateTargetFail(op, undefined, raw, prefix);
}

function mutateTargetHelp(op: string): { prefixes: string[]; examples: string[] } {
  if (op === "body.replace") return { prefixes: ["fn:", "method:", "class:"], examples: ['target="fn:<name>"', 'target="method:<owner.name>"'] };
  if (op === "body.insertBefore" || op === "body.insertAfter" || op === "declaration.move") return { prefixes: ["fn:", "class:", "method:", "prop:", "var:"], examples: ['target="fn:<name>"', 'target="class:<name>"'] };
  if (op === "declaration.rename") return { prefixes: ["fn:", "class:", "var:"], examples: ['target="fn:<name>"', 'target="var:<name>"'] };
  if (isMutateJsxOp(op)) return { prefixes: ["jsx:", "id:jsx:"], examples: ['target="jsx:Button"', 'target="id:jsx:<id>"'] };
  if (op === "ast.replace") return { prefixes: ["objectKey:", "call:", "string:", "contains:", "jsxText:", "jsxAttr:", "ast:"], examples: ['target="objectKey:label"', 'target="call:toast.error"'] };
  return { prefixes: [], examples: [] };
}

function mutateTargetFail(op: string, file: string | undefined, raw: string, prefix: string | undefined): never {
  const help = mutateTargetHelp(op);
  const suggestion = mutateTargetSuggestion(raw, help.prefixes);
  fail("INVALID_MCP_INPUT", `mutate target prefix ${prefix ?? "<none>"}: is not valid for ${op}${file ? ` on ${file}` : ""}. Valid prefixes for ${op}: ${help.prefixes.join(", ")}.`, {
    op,
    validPrefixes: help.prefixes,
    examples: help.examples,
    ...(suggestion ? { didYouMean: suggestion } : {}),
    suggestions: [
      ...(suggestion ? [`Did you mean ${suggestion}?`] : []),
      ...(help.examples[0] ? [`Use ${help.examples[0]} for ${op}.`] : []),
      "Call select first when the structural target is ambiguous.",
    ],
  });
}

function mutateTargetSuggestion(raw: string, prefixes: string[]): string | undefined {
  const [, rest] = splitTargetPrefix(raw);
  if (!rest || prefixes.length === 0) return undefined;
  const prefix = prefixes[0].replace(/:$/, "");
  return `${prefix}:${rest}`;
}

function assertJsxFile(file: string, prefix: string): void {
  const ext = extname(file).toLowerCase();
  if (![".jsx", ".tsx"].includes(ext)) fail("INVALID_MCP_INPUT", `mutate target prefix ${prefix}: is only valid for JSX/TSX files, got ${file}.`);
}

function splitTargetPrefix(value: string): [string | undefined, string] {
  const index = value.indexOf(":");
  if (index <= 0) return [undefined, value];
  return [value.slice(0, index), value.slice(index + 1)];
}

function flowStepsFromInput(input: JsonRecord): WorkspaceFlowStep[] {
  const steps = input.steps ?? input.flow;
  const chain = input.chain;
  if (steps !== undefined && chain !== undefined) fail("INVALID_MCP_INPUT", "flow accepts either steps/flow or chain, not both.");
  if (Array.isArray(steps)) return steps as WorkspaceFlowStep[];
  if (steps !== undefined) fail("INVALID_MCP_INPUT", "flow steps/flow must be an array.");
  if (chain === undefined) fail("INVALID_MCP_INPUT", "flow requires steps, flow, or chain.");

  const segments = Array.isArray(chain)
    ? parseChainSegments(chain.map((part) => String(part)))
    : parseChainText(requiredString(chain, "flow chain must be a string or string array."));
  const file = optionalString(input.file);
  return file ? fileChainToWorkspaceFlow(file, segments) : workspaceChainToFlow(segments);
}

function runDeleteFileTool(args: unknown): unknown {
  const input = recordInput(args, "delete_file");
  const filePath = requiredPatchPath(input.file, "delete_file requires file.");
  const restorePoints = captureRestorePoints([filePath]);
  return withVerifiedAgentFields(runPatchInput(`*** Begin Patch\n*** Delete File: ${filePath}\n*** End Patch\n`, writeFlagsFromInput(input)), input, restorePoints);
}

function runRenameFileTool(args: unknown): unknown {
  const input = recordInput(args, "rename_file");
  const filePath = requiredPatchPath(input.file, "rename_file requires file.");
  const to = requiredPatchPath(input.to, "rename_file requires to.");
  const restorePoints = captureRestorePoints([filePath, to]);
  return withVerifiedAgentFields(runPatchInput(`*** Begin Patch\n*** Update File: ${filePath}\n*** Move to: ${to}\n*** End Patch\n`, writeFlagsFromInput(input)), input, restorePoints);
}

function runActionsTool(args: unknown): unknown {
  const input = optionalRecordInput(args, "actions");
  const filePath = optionalString(input.file);
  const adapter = filePath ? getOptionalAdapterForFile(filePath) : null;
  const languageRules = adapter ? [adapter.rule] : [];
  const registeredTools = toolsForMcpProfile(teditMcpProfileFromEnv());
  const registeredToolNames = new Set(registeredTools.map((tool) => tool.name));
  const allTools = TEDIT_MCP_ALL_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    readOnly: tool.annotations?.readOnlyHint === true,
    exposure: toolExposure(tool),
    registered: registeredToolNames.has(tool.name),
    ...(tool.category ? { category: tool.category } : {}),
    ...(tool.action ? { action: tool.action } : {}),
    ...(tool.aliases && tool.aliases.length > 0 ? { aliases: tool.aliases } : {}),
    ...(tool.bestFor && tool.bestFor.length > 0 ? { best_for: tool.bestFor } : {}),
  }));
  const tools = allTools.filter((tool) => tool.registered);
  const advancedTools = allTools.filter((tool) => tool.exposure === "advanced");
  const actions = [...new Set([
    ...tools.map((tool) => tool.name),
    ...BASE_ACTIONS,
    ...languageRules.flatMap((rule) => rule.actions),
  ])];
  return withAgentFields({
    success: true,
    ...(filePath ? { file: filePath } : {}),
    tools,
    advanced_tools: advancedTools,
    profiles: {
      current: teditMcpProfileFromEnv(),
      agent: toolsForMcpProfile("agent").map((tool) => tool.name),
      all: TEDIT_MCP_ALL_TOOLS.map((tool) => tool.name),
    },
    rules: [
      { name: "base", extensions: ["*"], actions: BASE_ACTIONS },
      ...languageRules,
    ],
    actions,
    guidance: mcpDiscoveryGuidance(filePath, languageRules.map((rule) => rule.name)),
  }, input);
}

function runTemplatesTool(args: unknown): unknown {
  const input = optionalRecordInput(args, "templates");
  const cwd = optionalString(input.cwd) ?? process.cwd();
  const templates = listTemplates(cwd);
  return withAgentFields({
    success: true,
    kind: "templates",
    cwd,
    templates,
    count: templates.length,
  }, input);
}

function runSearchTool(args: unknown): unknown {
  const input = recordInput(args, "search");
  if (input.query !== undefined) return runSearchTextTool(input.file !== undefined && input.path === undefined && input.paths === undefined ? { ...input, path: input.file } : input);
  if (input.file !== undefined && input.lines === undefined && input.head === undefined && input.tail === undefined) {
    return withAgentFields(inspectFileOverview(requiredString(input.file, "search file must be a string.")), input);
  }
  return runInspectRangeTool(input);
}

function runInspectRangeTool(args: unknown): unknown {
  const input = recordInput(args, "inspect_range");
  return withAgentFields(inspectRange(requiredString(input.file, "inspect_range requires file."), {
    ...(input.lines === undefined ? {} : { lines: requiredString(input.lines, "inspect_range lines must be a string.") }),
    ...(input.head === undefined ? {} : { head: optionalNonnegativeInteger(input.head, "head") }),
    ...(input.tail === undefined ? {} : { tail: optionalNonnegativeInteger(input.tail, "tail") }),
    context: input.context === undefined ? 0 : optionalNonnegativeInteger(input.context, "context"),
  }), input);
}

function runSearchTextTool(args: unknown): unknown {
  const input = recordInput(args, "search_text");
  const paths = input.paths === undefined
    ? (input.path === undefined ? undefined : [requiredString(input.path, "search_text path must be a string.")])
    : stringArray(input.paths, "paths");
  const maxResults = pick(input, "maxResults", "max_results", "max-results");
  return withAgentFields(searchText({
    query: requiredString(input.query, "search_text requires query."),
    paths,
    regex: booleanValue(input.regex),
    glob: optionalString(input.glob),
    context: optionalNonnegativeInteger(input.context, "context"),
    multieditSpec: booleanValue(pick(input, "multieditSpec", "multiedit_spec", "multiedit-spec")),
    replace: optionalString(input.replace),
    ...(maxResults === undefined ? {} : { maxResults: optionalInteger(maxResults, "maxResults") }),
    caseSensitive: booleanValue(pick(input, "caseSensitive", "case_sensitive", "case-sensitive")),
    includeHidden: booleanValue(pick(input, "includeHidden", "include_hidden", "include-hidden")),
  }), input);
}

function runReadDetailTool(args: unknown): unknown {
  return readDetailArtifact(recordInput(args, "read_detail"));
}

function runHistoryTraceTool(args: unknown): unknown {
  const input = recordInput(args, "history_trace");
  return withAgentFields(historyTrace(requiredString(input.file, "history_trace requires file."), {
    lines: optionalString(input.lines),
    contains: optionalString(input.contains),
    regex: optionalString(input.regex),
    limit: optionalInteger(input.limit, "limit"),
  }), input);
}

function runScanStringsTool(args: unknown): unknown {
  const input = recordInput(args, "scan_strings");
  const minLength = pick(input, "minLength", "min_length", "min-length");
  return withAgentFields(runScanStrings(requiredString(input.file, "scan_strings requires file."), {
    contains: optionalString(input.contains),
    includeExcluded: booleanValue(pick(input, "includeExcluded", "include_excluded", "include-excluded")),
    ...(minLength === undefined ? {} : { minLength: optionalInteger(minLength, "minLength") }),
  }), input);
}

function runSelectTool(args: unknown): unknown {
  const input = recordInput(args, "select");
  return withAgentFields(runUniversalSelect(input), input);
}

function runUniversalSelect(input: JsonRecord): JsonRecord {
  const file = requiredString(input.file, "select requires file.");
  const selector = optionalString(pick(input, "selector", "name"));
  const contains = optionalString(input.contains);
  const query = selector ?? contains;
  const kind = optionalString(input.kind) ?? "auto";
  const maxResults = optionalInteger(input.maxResults, "maxResults") ?? 25;
  const context = optionalInteger(input.context, "context") ?? 2;
  const ext = extname(file).toLowerCase();
  const routes = selectRoutes(ext, kind, query);
  const routeErrors: JsonRecord[] = [];
  const matches: JsonRecord[] = [];

  if (routes.includes("ts")) {
    try {
      matches.push(...selectTsMatches(file, selector, kind));
    } catch (error) {
      routeErrors.push(selectRouteError("ts", error));
    }
  }

  if (routes.includes("jsx") && query) {
    try {
      matches.push(...selectJsxMatches(file, query));
    } catch (error) {
      routeErrors.push(selectRouteError("jsx", error));
    }
  }

  if (routes.includes("python")) {
    try {
      matches.push(...selectPythonMatches(file, selector, kind, maxResults));
    } catch (error) {
      routeErrors.push(selectRouteError("python", error));
    }
  }

  if ((routes.includes("text") || matches.length === 0 && kind === "auto") && query) {
    try {
      matches.push(...selectTextMatches(file, query, context, maxResults));
    } catch (error) {
      routeErrors.push(selectRouteError("text", error));
    }
  }

  const limited = matches.slice(0, maxResults);
  return {
    success: true,
    kind: "select",
    file,
    language: selectLanguage(ext),
    route: routes.join("+"),
    ...(selector ? { selector } : {}),
    ...(contains ? { contains } : {}),
    requestedKind: kind,
    matches: limited,
    count: matches.length,
    truncated: matches.length > limited.length,
    summary: `${limited.length}${matches.length > limited.length ? "+" : ""} selection ${limited.length === 1 ? "match" : "matches"}`,
    suggestions: selectSuggestions(limited),
    ...(routeErrors.length > 0 && limited.length === 0 ? { routeErrors } : {}),
  };
}

function selectRoutes(ext: string, kind: string, query: string | undefined): string[] {
  const tsExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
  const jsxExts = new Set([".tsx", ".jsx"]);
  const pythonExts = new Set([".py", ".pyw"]);
  if (kind === "text") return ["text"];
  if (kind === "jsx") return jsxExts.has(ext) ? ["jsx"] : ["text"];
  if (["function", "class", "method", "var", "import"].includes(kind)) return pythonExts.has(ext) ? ["python"] : tsExts.has(ext) ? ["ts"] : ["text"];
  if (["prop"].includes(kind)) return tsExts.has(ext) ? ["ts"] : ["text"];
  const routes: string[] = [];
  if (tsExts.has(ext)) routes.push("ts");
  if (jsxExts.has(ext) && query) routes.push("jsx");
  if (pythonExts.has(ext)) routes.push("python");
  if (routes.length === 0 && query) routes.push("text");
  return routes.length > 0 ? routes : ["text"];
}

function selectLanguage(ext: string): string {
  if (ext.startsWith(".")) return ext.slice(1) || "text";
  return "text";
}

function selectTsMatches(file: string, selector: string | undefined, kind: string): JsonRecord[] {
  const tsSelector = tsSelectorForSelect(selector, kind);
  const result = runTsSelect(file, tsSelector) as JsonRecord;
  const rawMatches = Array.isArray(result.matches) ? result.matches as JsonRecord[] : [];
  const filtered = tsSelector || !selector ? rawMatches : rawMatches.filter((match) => match.name === selector || match.selector === selector);
  return filtered.map((match) => ({
    id: `ts:${String(match.id ?? match.selector ?? match.name)}`,
    route: "ts",
    kind: `ts.${String(match.kind ?? "declaration")}`,
    name: match.name,
    selector: match.selector,
    range: match.range,
    lineRange: match.lineRange,
    preview: match.preview,
    context: match.context,
    canReplaceBody: match.canReplaceBody,
    editHint: { tool: "mutate", file, target: match.selector, op: "body.replace" },
    renameHint: ["fn", "class", "var"].includes(String(match.kind)) || String(match.context ?? "").startsWith("class ") ? { tool: "mutate", file, target: match.selector, op: "declaration.rename" } : undefined,
    moveHint: { tool: "mutate", file, target: match.selector, op: "declaration.move" },
  }));
}

function tsSelectorForSelect(selector: string | undefined, kind: string): string | undefined {
  if (!selector) return undefined;
  if (/^(fn|function|class|method|prop|var):/.test(selector)) return selector;
  if (kind === "function") return `fn:${selector}`;
  if (kind === "class") return `class:${selector}`;
  if (kind === "method") return `method:${selector}`;
  if (kind === "prop") return `prop:${selector}`;
  if (kind === "var") return `var:${selector}`;
  return undefined;
}

function selectJsxMatches(file: string, selector: string): JsonRecord[] {
  const result = runWorkspaceFlow([{ action: "find", file, selector, all: true }]);
  const data = result.results[0]?.data;
  const rawMatches = Array.isArray(data) ? data as JsonRecord[] : typeof data === "string" ? [{ id: data }] : [];
  return rawMatches.map((match) => {
    const lineRange = lineRangeFromLoc(match.loc);
    return {
      id: `jsx:${String(match.id ?? selector)}`,
      route: "jsx",
      kind: "jsx.element",
      name: match.name,
      selector,
      range: match.loc,
      lineRange,
      preview: match.preview,
      editHint: lineRange
        ? { tool: "edit", file, findLines: lineRange }
        : { tool: "edit", file, findExact: match.preview ?? selector },
      inspectHint: lineRange ? { tool: "search", file, lines: lineRange } : undefined,
    };
  });
}

function selectTextMatches(file: string, query: string, context: number, maxResults: number): JsonRecord[] {
  const result = searchText({ query, paths: [file], context, maxResults });
  const rawMatches = Array.isArray(result.results) ? result.results as JsonRecord[] : [];
  return rawMatches.map((match) => ({
    id: `text:${String(match.id ?? match.lineRange ?? match.preview)}`,
    route: "text",
    kind: "text.match",
    selector: query,
    range: match.range,
    lineRange: (match.range as JsonRecord | undefined)?.lineRange,
    preview: match.preview,
    editHint: match.suggested,
  }));
}

type PythonSelectMatch = {
  id: string;
  kind: "python.function" | "python.method" | "python.class" | "python.import" | "python.var" | "python.main";
  name: string;
  owner?: string;
  line: number;
  endLine: number;
  preview: string;
};

function selectPythonMatches(file: string, selector: string | undefined, kind: string, maxResults: number): JsonRecord[] {
  const source = readFileSync(file, "utf8");
  const matches = collectPythonMatches(source);
  const filtered = matches.filter((match) => pythonMatchFits(match, selector, kind)).slice(0, maxResults);
  return filtered.map((match) => {
    const lineRange = match.line === match.endLine ? String(match.line) : `${match.line}:${match.endLine}`;
    return {
      id: `python:${match.id}`,
      route: "python",
      kind: match.kind,
      name: match.name,
      ...(match.owner ? { owner: match.owner } : {}),
      selector: pythonSelectorForMatch(match),
      lineRange,
      preview: match.preview,
      editHint: { tool: "edit", file, findLines: lineRange },
    };
  });
}

function collectPythonMatches(source: string): PythonSelectMatch[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const matches: PythonSelectMatch[] = [];
  const classStack: Array<{ name: string; indent: number; endLine: number }> = [];

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = leadingSpaces(line);
    while (classStack.length > 0 && lineNumber > classStack[classStack.length - 1].endLine) classStack.pop();
    const decoratorStart = pythonDecoratorStart(lines, index);

    const classMatch = line.match(/^(\s*)class\s+([A-Za-z_]\w*)\b/);
    if (classMatch) {
      const endLine = pythonBlockEnd(lines, index, indent);
      const name = classMatch[2];
      matches.push({ id: `class_${matches.length + 1}`, kind: "python.class", name, line: decoratorStart, endLine, preview: trimmed });
      classStack.push({ name, indent, endLine });
      continue;
    }

    const functionMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (functionMatch) {
      const owner = currentPythonClassOwner(classStack, indent);
      matches.push({
        id: `function_${matches.length + 1}`,
        kind: owner ? "python.method" : "python.function",
        name: functionMatch[2],
        ...(owner ? { owner } : {}),
        line: decoratorStart,
        endLine: pythonBlockEnd(lines, index, indent),
        preview: trimmed,
      });
      continue;
    }

    if (line.match(/^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:/)) {
      matches.push({ id: `main_${matches.length + 1}`, kind: "python.main", name: "__main__", line: lineNumber, endLine: pythonBlockEnd(lines, index, indent), preview: trimmed });
      continue;
    }

    const importMatch = line.match(/^\s*(?:import\s+(.+)|from\s+([A-Za-z_][\w.]*)\s+import\s+(.+))/);
    if (importMatch) {
      const name = (importMatch[2] ?? importMatch[1] ?? "").split(/[,\s]/)[0];
      matches.push({ id: `import_${matches.length + 1}`, kind: "python.import", name, line: lineNumber, endLine: lineNumber, preview: trimmed });
      continue;
    }

    if (indent === 0) {
      const assignmentMatch = line.match(/^([A-Za-z_]\w*)\s*(?::[^=]+)?=/);
      if (assignmentMatch) {
        matches.push({ id: `var_${matches.length + 1}`, kind: "python.var", name: assignmentMatch[1], line: lineNumber, endLine: pythonStatementEnd(lines, index), preview: trimmed });
      }
    }
  }

  return matches;
}

function pythonMatchFits(match: PythonSelectMatch, selector: string | undefined, requestedKind: string): boolean {
  if (requestedKind !== "auto") {
    if (requestedKind === "function" && match.kind !== "python.function") return false;
    if (requestedKind === "class" && match.kind !== "python.class") return false;
    if (requestedKind === "method" && match.kind !== "python.method") return false;
    if (requestedKind === "var" && match.kind !== "python.var") return false;
    if (requestedKind === "import" && match.kind !== "python.import") return false;
  }
  if (!selector) return true;
  const parsed = selector.match(/^(fn|function|class|method|var|import):(.+)$/);
  const expectedName = (parsed ? parsed[2] : selector).trim();
  const expectedKind = parsed?.[1];
  if (expectedKind && !pythonKindMatchesSelector(match, expectedKind)) return false;
  if (expectedName.includes(".") && match.owner) return `${match.owner}.${match.name}` === expectedName;
  return match.name === expectedName || match.preview.includes(expectedName);
}

function pythonKindMatchesSelector(match: PythonSelectMatch, selectorKind: string): boolean {
  if (selectorKind === "fn" || selectorKind === "function") return match.kind === "python.function";
  if (selectorKind === "class") return match.kind === "python.class";
  if (selectorKind === "method") return match.kind === "python.method";
  if (selectorKind === "var") return match.kind === "python.var";
  if (selectorKind === "import") return match.kind === "python.import";
  return true;
}

function currentPythonClassOwner(classStack: Array<{ name: string; indent: number; endLine: number }>, indent: number): string | undefined {
  for (let index = classStack.length - 1; index >= 0; index--) {
    if (indent > classStack[index].indent) return classStack[index].name;
  }
  return undefined;
}

function pythonSelectorForMatch(match: PythonSelectMatch): string {
  if (match.kind === "python.function") return `function:${match.name}`;
  if (match.kind === "python.class") return `class:${match.name}`;
  if (match.kind === "python.method") return `method:${match.owner ? `${match.owner}.` : ""}${match.name}`;
  if (match.kind === "python.var") return `var:${match.name}`;
  if (match.kind === "python.import") return `import:${match.name}`;
  return match.name;
}

function pythonBlockEnd(lines: string[], startIndex: number, indent: number): number {
  let end = startIndex + 1;
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      end = index + 1;
      continue;
    }
    if (leadingSpaces(line) <= indent) break;
    end = index + 1;
  }
  return end;
}

function pythonStatementEnd(lines: string[], startIndex: number): number {
  let balance = 0;
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    balance += (line.match(/[\[({]/g) ?? []).length;
    balance -= (line.match(/[\])}]/g) ?? []).length;
    const continuation = line.trimEnd().endsWith("\\");
    if (balance <= 0 && !continuation) return index + 1;
  }
  return startIndex + 1;
}

function pythonDecoratorStart(lines: string[], index: number): number {
  let start = index;
  while (start > 0 && lines[start - 1].trimStart().startsWith("@")) start--;
  return start + 1;
}

function leadingSpaces(line: string): number {
  return line.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
}

function lineRangeFromLoc(loc: unknown): string | undefined {
  if (!loc || typeof loc !== "object" || Array.isArray(loc)) return undefined;
  const record = loc as JsonRecord;
  const start = record.start;
  const end = record.end;
  if (!start || typeof start !== "object" || !end || typeof end !== "object") return undefined;
  const startLine = (start as JsonRecord).line;
  const endLine = (end as JsonRecord).line;
  if (typeof startLine !== "number" || typeof endLine !== "number") return undefined;
  return startLine === endLine ? String(startLine) : `${startLine}:${endLine}`;
}

function selectSuggestions(matches: JsonRecord[]): string[] {
  const tools = [...new Set(matches.flatMap((match) => {
    const editHint = match.editHint as JsonRecord | undefined;
    const moveHint = match.moveHint as JsonRecord | undefined;
    return [editHint?.tool, moveHint?.tool].filter((tool): tool is string => typeof tool === "string");
  }))];
  return tools.map((tool) => `Use ${tool} with the returned hint for the selected match.`);
}

function selectRouteError(route: string, error: unknown): JsonRecord {
  const record = error && typeof error === "object" ? error as JsonRecord : {};
  return {
    route,
    code: typeof record.code === "string" ? record.code : "SELECT_ROUTE_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function runAstSelectTool(args: unknown): unknown {
  const input = recordInput(args, "ast_select");
  return withAgentFields(runAstSelect(requiredString(input.file, "ast_select requires file."), requiredString(input.selector, "ast_select requires selector.")), input);
}

function runAstEditTool(args: unknown, options?: WriteFlagOptions): unknown {
  const input = recordInput(args, "ast_edit");
  return withAgentFields(runAstEditEngine(requiredString(input.file, "ast_edit requires file."), {
    selector: astEditSelectorFromInput(input),
    replace: requiredString(input.replace, "ast_edit requires replace."),
    ...writeFlagsFromInput(input, options),
  }), input);
}

function runTsSelectTool(args: unknown): unknown {
  const input = recordInput(args, "ts_select");
  return withAgentFields(runTsSelect(requiredString(input.file, "ts_select requires file."), optionalString(input.selector)), input);
}

function runTsEditTool(args: unknown): unknown {
  const input = recordInput(args, "ts_edit");
  const filePath = requiredString(input.file, "ts_edit requires file.");
  const restorePoints = captureRestorePoints([filePath]);
  const action = optionalString(input.action);
  if (action !== undefined && action !== "replace-body" && action !== "insert-before" && action !== "insert-after") {
    fail("INVALID_MCP_INPUT", "ts_edit action must be replace-body, insert-before, or insert-after.");
  }
  return withVerifiedAgentFields(runTsEditEngine(filePath, {
    selector: requiredString(input.selector, "ts_edit requires selector."),
    ...(action === undefined ? {} : { action }),
    ...(input.body === undefined ? {} : { body: requiredString(input.body, "ts_edit body must be a string.") }),
    ...(input.insertBefore === undefined ? {} : { insertBefore: requiredString(input.insertBefore, "ts_edit insertBefore must be a string.") }),
    ...(input.insertAfter === undefined ? {} : { insertAfter: requiredString(input.insertAfter, "ts_edit insertAfter must be a string.") }),
    ...writeFlagsFromInput(input, MCP_WRITE_BY_DEFAULT),
  }), input, restorePoints);
}

function runTsMoveTool(args: unknown): unknown {
  const input = recordInput(args, "ts_move");
  const filePath = requiredString(input.file, "ts_move requires file.");
  const restorePoints = captureRestorePoints([filePath]);
  return withVerifiedAgentFields(runTsMoveEngine(filePath, {
    target: requiredString(input.target, "ts_move requires target."),
    before: optionalString(input.before),
    after: optionalString(input.after),
    take: stringArray(input.take, "take"),
    drop: stringArray(input.drop, "drop"),
    confirmTrivia: booleanValue(input.confirmTrivia),
    sourceHash: optionalString(input.sourceHash),
    includeTriviaContent: booleanValue(input.includeTriviaContent),
    ...writeFlagsFromInput(input),
  }), input, restorePoints);
}

function runTsRenameTool(args: unknown): unknown {
  const input = recordInput(args, "ts_rename");
  const filePath = requiredString(input.file, "ts_rename requires file.");
  const restorePoints = captureRestorePoints([filePath]);
  return withVerifiedAgentFields(runTsRenameEngine(filePath, {
    selector: requiredString(input.selector, "ts_rename requires selector."),
    to: requiredString(input.to, "ts_rename requires to."),
    ...writeFlagsFromInput(input, MCP_WRITE_BY_DEFAULT),
  }), input, restorePoints);
}

function astEditSelectorFromInput(input: JsonRecord): string {
  const selector = optionalString(input.selector);
  const stringValue = optionalString(input.string);
  const contains = optionalString(input.contains);
  const jsxText = optionalString(pick(input, "jsxText", "jsx_text", "jsx-text"));
  const jsxAttr = optionalString(pick(input, "jsxAttr", "jsx_attr", "jsx-attr"));
  const objectKey = optionalString(pick(input, "objectKey", "object_key", "object-key"));
  const call = optionalString(input.call);
  const shortcutCount = [stringValue, contains, jsxText, jsxAttr, objectKey, call].filter((value) => value !== undefined).length;
  if (selector && shortcutCount > 0) fail("INVALID_MCP_INPUT", "ast_edit accepts either selector or one shortcut field.");
  if (shortcutCount > 1) fail("INVALID_MCP_INPUT", "ast_edit accepts only one shortcut field.");
  if (selector) return selector;
  if (stringValue !== undefined) return `StringLiteral[value=${astSelectorValue(stringValue)}]`;
  if (contains !== undefined) return `StringLiteral[value*=${astSelectorValue(contains)}]`;
  if (jsxText !== undefined) return `JSXText[value*=${astSelectorValue(jsxText)}]`;
  if (jsxAttr !== undefined) return `JSXAttribute[name=${astSelectorValue(jsxAttr)}]`;
  if (objectKey !== undefined) return `ObjectProperty[key.name=${astSelectorValue(objectKey)}]`;
  if (call !== undefined) return `${astCallSelector(call)} > StringLiteral`;
  fail("INVALID_MCP_INPUT", "ast_edit requires selector, string, contains, jsxText, jsxAttr, objectKey, or call.");
}

function astSelectorValue(value: string): string {
  if (!value.includes("\"")) return JSON.stringify(value);
  if (!value.includes("'")) return `'${value}'`;
  fail("INVALID_MCP_INPUT", "AST shortcut values cannot contain both single and double quotes yet; pass an explicit selector.");
}

function astCallSelector(value: string): string {
  const parts = value.split(".");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return `CallExpression[callee.object.name=${astSelectorValue(parts[0])}][callee.property.name=${astSelectorValue(parts[1])}]`;
  }
  return `CallExpression[callee.name=${astSelectorValue(value)}]`;
}

function toolExposure(tool: TeditMcpTool): "default" | "advanced" {
  return isDefaultMcpToolName(tool.name) ? "default" : "advanced";
}

function mcpDiscoveryGuidance(filePath: string | undefined, ruleNames: string[]): JsonRecord {
  return {
    default_profile: "agent",
    read_path: [
      "Use the host/native Read tool for full file contents; tedit does not duplicate plain file reading yet.",
      "Use actions first when unsure; it returns the current profile, default tools, advanced tools, and examples.",
      "Use select as the common TS/JS/JSX/TSX target discovery facade before choosing mutate for structural edits or edit for text spans.",
      "Use search for grep/sed/head/tail-style text and line-range discovery.",
      "Use read_detail only when a compact response returns a $detail descriptor for a field you actually need.",
      "Use verify_file when syntax/parser coverage matters before or after an edit; it is not a typecheck.",
      "Pass verify for optional post-write semantic checks such as typecheck, lint, test, or build.",
      "Set TEDIT_MCP_PROFILE=all for JSX, TS declaration, AST, history, template, and refactor helpers.",
    ],
    no_read_file_tool: "A plain read_file MCP tool would currently be less useful than native Read. Add one only when it returns tedit-specific value such as parser status, stable selectors, slices, hashes, or retry-ready targets.",
    profile: {
      current: teditMcpProfileFromEnv(),
      default_surface: "Agent profile exposes actions, select, search, edit, multiedit, mutate, apply_dry_run, patch, flow, refactor, file_write, delete_file, rename_file, read_detail, and verify_file.",
      advanced_surface: "Set TEDIT_MCP_PROFILE=all to expose JSX, TS declaration, AST, history, template, extract, plan, and legacy fine-grained tools.",
      refresh_hint: "If actions lists a tool but the host does not expose it as callable, restart or refresh the MCP host; tool schema/name changes are captured only when the host reloads the server.",
    },
    tool_priorities: [
      "select for file-type-aware target discovery", 
      "search for text/range discovery",
      "edit for one localized change; MCP writes by default unless dryRun:true",
      "mutate for one JSX/TS/import/AST structural change; MCP writes by default unless dryRun:true",
      "multiedit for repeated or cross-file changes",
      "apply_dry_run after reviewing a successful dry-run suggestedAction",
      "delete_file or rename_file for one-file cleanup/moves",
      "verify for optional post-write project checks",
      "file_write for whole-file generation, scaffold mode, or template mode",
      "verify_file before or after edits when parser coverage matters",
      "patch only when the change is already a diff",
      "TEDIT_MCP_PROFILE=all for JSX/TS declaration/AST/history/refactor/template helpers",
    ],
    workflow_guide: [
      { when: "need file-type-aware target discovery", first_tool: "select", then: "mutate for structural ops or edit for text spans", reason: "one common facade routes TS/JS declarations, JSX elements, or text fallback" },
      { when: "need target context before editing", first_tool: "search", then: "edit", reason: "turn raw text or line ranges into edit-ready suggestions" },
      { when: "one localized replacement/insertion/deletion", first_tool: "edit", then: "pass dryRun:true first when preview is needed", reason: "MCP edit writes by default; exact/line/regex plus best-effort fuzzy and parser guardrails" },
      { when: "same change across several places or files", first_tool: "search", then: "multiedit", reason: "search can emit a grouped multiedit spec; multiedit applies atomically" },
      { when: "already have a generated diff", first_tool: "patch", then: "verify_file for important touched files", reason: "patch accepts unified diff and Codex apply-patch envelopes" },
      { when: "delete or rename one file", first_tool: "delete_file or rename_file", then: "patch for multi-file transactions", reason: "single-file cleanup no longer requires hand-authored patch text" },
      { when: "project-specific validation is needed after write", first_tool: "edit/multiedit/patch with verify", then: "inspect verify stdout/stderr; optionally rollbackOnFail", reason: "repo checks vary, so verification is opt-in per mutation" },
      { when: "create or overwrite a whole file", first_tool: "file_write", then: "verify_file", reason: "mode=write/scaffold/template keeps generation behind write policy and parse verification" },
      { when: "large plain-TS named function or class edit", first_tool: "select", then: "mutate body.replace/body.insertBefore/body.insertAfter", reason: "named declaration selectors avoid brittle old_string ranges and keep braces/trivia mechanical" },
      { when: "single-file TS/JS declaration rename", first_tool: "select", then: "mutate declaration.rename with verify for exported symbols", reason: "updates same-file binding references and warns when external imports may need a typecheck" },
      { when: "hardcoded JS/TS/JSX strings", first_tool: "scan_strings", then: "mutate ast.replace or ast_edit", reason: "AST scanning covers code strings that structural find does not" },
      { when: "structural JSX/TS/import/AST mutation", first_tool: "mutate", then: "use actions examples when op args are unclear", reason: "single facade covers JSX props/classes/text/nodes, imports, TS body/move, and AST string operations" },
      { when: "need change history before risky edit", first_tool: "history_trace", then: "search or edit", reason: "history_trace avoids hand-assembling blame/log commands" },
    ],
    failure_recovery: [
      { code: "MATCH_NONE", suggestion: "Use returned candidates or search; retry with findLines/regex first. findFuzzy is best-effort character matching (whitespace first, then confidence-gated small drift), never semantic; ambiguous or low-confidence candidates are reported, not written." },
      { code: "MATCH_NOT_UNIQUE", suggestion: "Use returned candidate line ranges or add expectCount when replaceAll is intended." },
      { code: "PARSE_BROKEN_AFTER_EDIT", suggestion: "Do not force write; inspect the proposed replacement and keep syntax balanced before retrying." },
      { code: "AST_MATCH_NONE", suggestion: "Use scan_strings candidates or switch selector type, for example JSXText instead of StringLiteral." },
      { code: "PATCH_HUNK_FAILED", suggestion: "Inspect current file context and regenerate the hunk against the current source." },
    ],
    mutate_cheatsheet: {
      boundary: "single file + single structural transformation = mutate; text spans = edit/multiedit; multi-file, planned, or symbol-graph-aware changes = refactor",
      targets: {
        jsx: "jsx:<selector> or id:jsx:<id>",
        ts: "fn:<name>, class:<name>, method:<owner.name>, prop:<name>, or var:<name>",
        ast: "objectKey:<key>, call:<callee>, string:<exact>, contains:<text>, jsxText:<text>, jsxAttr:<name>",
        imports: "omit target",
      },
      opPrefixes: {
        "prop.set/prop.remove/class.add/class.remove/class.replace/text.set/text.replace/wrap/remove/rename/append/prepend": ["jsx:", "id:jsx:"],
        "body.replace": ["fn:", "method:", "class:"],
        "body.insertBefore/body.insertAfter/declaration.move": ["fn:", "class:", "method:", "prop:", "var:"],
        "declaration.rename": ["fn:", "class:", "var:"],
        "imports.add/imports.remove/imports.rename/imports.move": ["<omit target>"],
        "ast.replace": ["objectKey:", "call:", "string:", "contains:", "jsxText:", "jsxAttr:", "ast:"],
      },
      examples: {
        jsx_prop: { file: "src/Page.tsx", target: "jsx:Button", "prop.set": { name: "disabled", value: true } },
        jsx_class: { file: "src/Page.tsx", target: "jsx:h1", "class.add": { className: "tracking-[-0.02em]" } },
        ts_body: { file: "src/server.ts", target: "fn:<name>", "body.replace": { body: "return server.start();" } },
        ts_rename: { file: "src/server.ts", target: "fn:<name>", "declaration.rename": { to: "startServer" } },
        import_rename: { file: "src/Page.tsx", "imports.rename": { from: "./old", name: "OldName", to: "NewName" } },
        ast_string: { file: "src/messages.ts", target: "objectKey:label", "ast.replace": { replace: "Delete" } },
      },
      notes: [
        "Prefer select -> id:jsx:<id> -> mutate when a selector may be ambiguous.",
        "Use dotted operation keys like prop.set as the canonical shorthand; op+args remains supported for compatibility.",
        "For body.replace, pass the body statements only; outer braces are optional but discouraged.",
      ],
    },
    edit_loop: [
      { intent: "select target across TS/JS/JSX/TSX", tool: "select", reason: "file-type-aware facade returning normalized matches and follow-up edit hints" },
      { intent: "one localized edit", tool: "edit", reason: "MCP writes by default; pass dryRun:true for preview, with exact/line/regex and best-effort fuzzy strategies plus syntax parse verification" },
      { intent: "apply reviewed dry-run", tool: "apply_dry_run", reason: "reuses the stored dry-run args after source-hash verification" },
      { intent: "several coordinated text edits", tool: "multiedit", reason: "atomic application across files and same-file sequential edits" },
      { intent: "already generated diff", tool: "patch", reason: "atomic unified diff/apply-patch input with verification" },
      { intent: "delete one file", tool: "delete_file", reason: "dry-run/write delete without authoring a patch envelope" },
      { intent: "rename one file", tool: "rename_file", reason: "dry-run/write move without authoring a patch envelope" },
      { intent: "post-write typecheck/lint/test", tool: "verify option", reason: "optional command hook with timeoutMs and rollbackOnFail" },
      { intent: "text or line range context before editing", tool: "search", reason: "grep/sed-style candidates plus parser status and edit/multiedit follow-ups" },
      { intent: "who changed this or when", tool: "history_trace", reason: "git blame/log history without hand-assembling commands" },
      { intent: "must-be-new full file", tool: "create_file", reason: "no-overwrite creation is a safety boundary" },
      { intent: "whole-file generation or scaffold/template", tool: "file_write", required: ["mode"], reason: "write/scaffold/template facade with parser guardrails" },
      { intent: "available project templates", tool: "templates", reason: "lists built-in and .tedit/templates before file_write mode=template" },
      { intent: "structural JSX/TS/import/AST mutation", tool: "mutate", reason: "selector/id/prefixed target edits avoid brittle text spans while hiding backend-specific tools" },
      { intent: "hardcoded text audit", tool: "scan_strings", reason: "AST scan covers JSX text/attrs plus JS/TS string literals; find remains structural" },
      { intent: "code AST discovery or one safe string replacement", tool: "mutate ast.replace", reason: "AST shortcuts target common string/object/JSX text replacements" },
      { intent: "large TS declaration body edit", tool: "select, then mutate body.replace", reason: "selector resolves the named declaration and tedit owns the outer braces" },
      { intent: "single-file TS declaration rename", tool: "select, then mutate declaration.rename", reason: "updates same-file binding references and warns for exported symbols" },
      { intent: "reorder TS declarations", tool: "mutate declaration.move", reason: "single-file declaration move with carried trivia hints and take/drop overrides" },
    ],
    refactor_loop: [
      { intent: "small confident JSX component extraction", tool: "extract_component", required: ["mode=direct", "from", "selector", "to", "name"], reason: "direct dry-run/write extraction with prop inference and parser guardrails" },
      { intent: "large or risky JSX component extraction", tool: "extract_component then apply_plan", required: ["mode=plan", "from", "selector", "to", "name", "planOut"], reason: "reviewable plan file before applying file creation, call-site replacement, and helper movement" },
      { intent: "extract and then mutate the created component in one transaction", tool: "chain_workspace", reason: "workspace-flow can run extract plus follow-up per-file structural steps atomically" },
      { intent: "React state cluster diagnosis", tool: "analyze_state", reason: "read-only state structure insight; not a code review substitute" },
      { intent: "React state cluster cleanup, hook extraction, or component extraction", tool: "refactor", reason: "default-profile facade over existing refactor-state, extract, and apply-plan workflows" },
    ],
    examples: {
      select: { file: "src/Page.tsx", selector: "LoginButtons" },
      edit: { file: "src/Page.tsx", find: "oldLabel", replace: "newLabel" },
      edit_preview: { file: "src/Page.tsx", find: "oldLabel", replace: "newLabel", dryRun: true },
      multiedit: { edits: [{ file: "src/Page.tsx", find: "삭제", replace: "Delete", replaceAll: true, expectCount: 2 }] },
      patch: { patch: "--- src/Page.tsx\n+++ src/Page.tsx\n@@ ...", dryRun: true },
      flow: { file: "src/Page.tsx", chain: "find button as login :: wrap @login div.inline-flex" },
      mutate_prop: { file: "src/Page.tsx", target: "jsx:Button", "prop.set": { name: "disabled", value: true } },
      mutate_class_add: { file: "src/Page.tsx", op: "class.add", target: "jsx:h1", args: { className: "tracking-[-0.02em]" } },
      mutate_class: { file: "src/Page.tsx", op: "class.replace", target: "jsx:Button", args: { from: "primary", to: "secondary" }, dryRun: true },
      mutate_ts_body: { file: "src/server.ts", op: "body.replace", target: "fn:startServer", args: { body: "return server.start();" }, dryRun: true },
      mutate_ts_rename: { file: "src/server.ts", target: "fn:startServer", "declaration.rename": { to: "bootServer" }, dryRun: true },
      mutate_import: { file: "src/Page.tsx", op: "imports.rename", args: { from: "./old", name: "OldName", to: "NewName" }, dryRun: true },
      mutate_ast: { file: "src/messages.ts", op: "ast.replace", target: "objectKey:label", args: { replace: "Delete" }, dryRun: true },
      delete_file: { file: "src/generated/LoginButtons.tsx", dryRun: true },
      rename_file: { file: "src/old.ts", to: "src/new.ts", dryRun: true },
      edit_with_verify: { file: "src/Page.tsx", find: "oldLabel", replace: "newLabel", write: true, verify: { cmd: ["npx", "tsc", "-p", "apps/web/tsconfig.json", "--noEmit"], timeoutMs: 30000, rollbackOnFail: false } },
      file_write: { mode: "write", file: "src/generated.json", source: "{\"ok\":true}\n", write: true },
      extract_component: { mode: "direct", from: "src/Page.tsx", selector: "Card", to: "src/components/PageCard.tsx", name: "PageCard", write: true },
      extract_component_plan: { mode: "plan", from: "src/Page.tsx", selector: "Card", to: "src/components/PageCard.tsx", name: "PageCard", planOut: ".tedit/plans/extract-card.json" },
      apply_plan: { plan: ".tedit/plans/extract-card.json", write: true },
      jsx_attr: { action: "prop_set", file: "src/Page.tsx", selector: "Card", name: "data-extracted", value: true, write: true },
      search_range: { file: "src/Page.tsx", lines: "120:140", context: 3 },
      search_text: { query: "삭제", paths: ["src"], glob: "**/*.tsx", context: 2, multieditSpec: true, replace: "Delete" },
      history_trace: { file: "src/Page.tsx", lines: "120:140", limit: 5 },
      templates: { cwd: "." },
      scan_strings: { file: "src/Page.tsx", contains: "삭제" },
      ast_select: { file: "src/Page.tsx", selector: "ObjectProperty[key.name=\"label\"] > StringLiteral" },
      ast_edit: { file: "src/Page.tsx", call: "toast.error", replace: "Failed", write: true },
      ts_select_compat: { file: "src/server.ts", selector: "fn:apiGateMetadata" },
      ts_edit_compat: { file: "src/server.ts", selector: "fn:apiGateMetadata", body: "\n  return buildMetadata();\n" },
      ts_move_compat: { file: "src/server.ts", target: "fn:apiGateMetadata", before: "fn:startServer", dryRun: true },
      chain_workspace: {
        steps: [
          { action: "extract", from: "src/Page.tsx", selector: "Card", to: "src/components/PageCard.tsx", name: "PageCard" },
          { action: "chain", file: "src/components/PageCard.tsx", steps: [{ action: "prop.set", target: "Card", name: "data-extracted", value: true }] },
        ],
        write: true,
      },
    },
    mcp_write_defaults: {
      writes_by_default: ["edit", "multiedit", "mutate", "flow"],
      preview_only: "pass dryRun:true",
      conservative_by_default: ["patch", "delete_file", "rename_file", "file_write"],
    },
    cli_fallbacks: {
      edit: "node dist/cli.js edit src/Page.tsx --find '<LoginButtons variant=\"inline\" />' --replace '<button>로그인</button>' --write --json",
      multiedit: "node dist/cli.js multiedit --from-stdin --write < edits.json",
      patch_delete: "printf '*** Begin Patch\\n*** Delete File: src/generated/LoginButtons.tsx\\n*** End Patch\\n' | node dist/cli.js patch --stdin --write --json",
      patch_rename: "printf '*** Begin Patch\\n*** Update File: src/old.ts\\n*** Move to: src/new.ts\\n*** End Patch\\n' | node dist/cli.js patch --stdin --write --json",
    },
    ...(filePath ? { file: filePath, file_rules: ruleNames } : {}),
  };
}

function runAnalyzeStateTool(args: unknown): unknown {
  const input = recordInput(args, "analyze_state");
  return withAgentFields(analyzeState(requiredString(input.file, "analyze_state requires file.")), input);
}

function runVerifyFileTool(args: unknown): unknown {
  const input = recordInput(args, "verify_file");
  const filePaths = verifyFilePathsFromInput(input);
  if (filePaths.length > 1) {
    const files = filePaths.map(verifyFileEntry);
    return withAgentFields({
      success: true,
      kind: "verify-files",
      files,
      count: files.length,
      verifiedCount: files.filter((file) => file.parse_verified === true).length,
      skippedCount: files.filter((file) => file.parse_skipped === true).length,
      warningCount: files.reduce((count, file) => count + file.warnings.length, 0),
    }, input);
  }

  const filePath = filePaths[0];
  const source = readFileSync(filePath, "utf8");
  const verification = verifyParseForFile(filePath, source);
  return withAgentFields({
    success: true,
    file: filePath,
    ...parseVerificationFields(verification),
    warnings: qualityWarnings(filePath, source, source),
  }, input);
}

function verifyFilePathsFromInput(input: JsonRecord): string[] {
  const filePaths = [...stringArray(input.file, "verify_file file"), ...stringArray(input.files, "verify_file files")];
  const unique = [...new Set(filePaths)];
  if (unique.length === 0) fail("INVALID_MCP_INPUT", "verify_file requires file or files.");
  return unique;
}

function verifyFileEntry(filePath: string): VerifyFileEntry {
  const source = readFileSync(filePath, "utf8");
  const verification = verifyParseForFile(filePath, source);
  return {
    file: filePath,
    ...parseVerificationFields(verification),
    warnings: qualityWarnings(filePath, source, source),
  };
}

function runRefactorTool(args: unknown): unknown {
  const input = recordInput(args, "refactor");
  const kind = requiredString(pick(input, "kind", "type", "action"), "refactor requires kind: state, extract, apply-plan, symbol-graph, move-symbols, extract-array-entries, or module-split-plan.");
  const normalized = kind.replace(/_/g, "-");

  if (normalized === "state" || normalized === "refactor-state") return runRefactorStateTool(input);
  if (normalized === "extract" || normalized === "extract-component") {
    const mode = optionalString(input.mode);
    if (mode === "plan" || (mode === undefined && pick(input, "planOut", "plan_out", "plan-out") !== undefined)) return runExtractPlanTool(input);
    if (mode === undefined || mode === "apply" || mode === "direct") return runExtractTool(input);
    fail("INVALID_MCP_INPUT", "refactor kind=extract mode must be direct or plan.");
  }
  if (normalized === "apply-plan") return runApplyPlanTool(input);
  if (normalized === "symbol-graph") return withAgentFields(buildTsModuleGraph(requiredString(input.file, "refactor kind=symbol_graph requires file.")), input);
  if (normalized === "move-symbols") return runMoveSymbolsTool(input);
  if (normalized === "extract-array-entries") return runExtractArrayEntriesTool(input);
  if (normalized === "module-split-plan") return runModuleSplitPlanTool(input);

  fail("INVALID_MCP_INPUT", "refactor kind must be state, extract, apply-plan, symbol-graph, move-symbols, extract-array-entries, or module-split-plan.");
}

function runRefactorStateTool(args: unknown): unknown {
  const input = recordInput(args, "refactor_state");
  const mode = optionalString(input.mode);
  if (mode === "plan" || (mode === undefined && pick(input, "planOut", "plan_out", "plan-out") !== undefined)) {
    return runRefactorStatePlanTool(input);
  }
  if (mode !== undefined && mode !== "apply") fail("INVALID_MCP_INPUT", "refactor_state mode must be apply or plan.");
  return runRefactorState(requiredString(input.file, "refactor_state requires file."), {
    cluster: optionalString(input.cluster),
    to: optionalString(input.to),
    name: optionalString(input.name),
    externalDeps: externalDepsFromInput(input, "refactor_state"),
    ...writeFlagsFromInput(input),
  });
}

function runRefactorStatePlanTool(args: unknown): unknown {
  const input = recordInput(args, "refactor_state_plan");
  const filePath = requiredString(input.file, "refactor_state_plan requires file.");
  const planOut = requiredString(pick(input, "planOut", "plan_out", "plan-out"), "refactor_state_plan requires planOut.");
  const plan = buildRefactorStatePlan(filePath, {
    cluster: optionalString(input.cluster),
    to: optionalString(input.to),
    name: optionalString(input.name),
    externalDeps: externalDepsFromInput(input, "refactor_state_plan"),
  });
  writePlanFile(planOut, plan, booleanValue(input.overwrite));
  return { success: true, plan: planOut, ...plan };
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
  const restorePoints = captureRestorePoints(refactorPlanFilesForRestore(planPath));
  return withVerifiedAgentFields(applyRefactorPlan(planPath, {
    ...writeFlagsFromInput(input),
    overwrite: booleanValue(input.overwrite),
    only: stringArray(input.only, "only"),
    skip: stringArray(input.skip, "skip"),
  }) as unknown as Record<string, unknown>, input, restorePoints);
}

function runMoveSymbolsTool(input: JsonRecord): unknown {
  const from = requiredString(input.from, "refactor kind=move_symbols requires from.");
  const to = requiredString(input.to, "refactor kind=move_symbols requires to.");
  const restorePoints = captureRestorePoints([from, to]);
  return withVerifiedAgentFields(runMoveSymbols({
    from,
    to,
    symbols: stringArray(input.symbols, "symbols"),
    closure: optionalString(input.closure) as "none" | "helpers" | "ask" | undefined,
    ...writeFlagsFromInput(input),
  }), input, restorePoints);
}

function runExtractArrayEntriesTool(input: JsonRecord): unknown {
  const file = requiredString(input.file, "refactor kind=extract_array_entries requires file.");
  const to = requiredString(input.to, "refactor kind=extract_array_entries requires to.");
  const restorePoints = captureRestorePoints([file, to]);
  return withVerifiedAgentFields(runExtractArrayEntries({
    file,
    array: requiredString(input.array, "refactor kind=extract_array_entries requires array."),
    to,
    exportName: requiredString(pick(input, "exportName", "export_name", "export-name"), "refactor kind=extract_array_entries requires exportName."),
    where: recordOrUndefined(input.where, "where"),
    entries: stringArray(input.entries, "entries"),
    ...writeFlagsFromInput(input),
  }), input, restorePoints);
}

function runModuleSplitPlanTool(input: JsonRecord): unknown {
  const source = requiredString(pick(input, "source", "file", "from"), "refactor kind=module_split_plan requires source or file.");
  const planOut = requiredString(pick(input, "planOut", "plan_out", "plan-out", "to"), "refactor kind=module_split_plan requires planOut.");
  const rawOperations = input.operations;
  if (!Array.isArray(rawOperations)) fail("INVALID_MCP_INPUT", "refactor kind=module_split_plan requires operations array.");
  const operations = rawOperations.map((operation) => moduleSplitOperation(operation));
  const plan = buildModuleSplitPlan(source, operations);
  writePlanFile(planOut, plan, booleanValue(input.overwrite));
  return withAgentFields({ success: true, plan: planOut, ...plan }, input);
}

function moduleSplitOperation(operation: unknown): MoveSymbolsOperation | ExtractArrayEntriesOperation {
  const input = recordInput(operation, "module_split_plan operation");
  const action = requiredString(pick(input, "action", "kind", "type"), "module_split_plan operation requires action.").replace(/_/g, "-");
  if (action === "move-symbols") {
    rejectModuleSplitFields(input, "move_symbols", ["file", "array", "exportName", "export_name", "export-name", "where", "entries"]);
    return {
      action: "move_symbols",
      from: requiredString(input.from, "move_symbols operation requires from."),
      to: requiredString(input.to, "move_symbols operation requires to."),
      symbols: stringArray(input.symbols, "symbols"),
      closure: optionalString(input.closure) as "none" | "helpers" | "ask" | undefined,
    };
  }
  if (action === "extract-array-entries") {
    rejectModuleSplitFields(input, "extract_array_entries", ["from", "symbols", "closure"]);
    return {
      action: "extract_array_entries",
      file: requiredString(input.file, "extract_array_entries operation requires file."),
      array: requiredString(input.array, "extract_array_entries operation requires array."),
      to: requiredString(input.to, "extract_array_entries operation requires to."),
      exportName: requiredString(pick(input, "exportName", "export_name", "export-name"), "extract_array_entries operation requires exportName."),
      where: recordOrUndefined(input.where, "where"),
      entries: stringArray(input.entries, "entries"),
    };
  }
  fail("INVALID_MCP_INPUT", "module_split_plan operation action must be move_symbols or extract_array_entries.");
}

function rejectModuleSplitFields(input: JsonRecord, action: string, fields: string[]): void {
  const present = fields.filter((field) => input[field] !== undefined);
  if (present.length > 0) {
    fail("INVALID_MCP_INPUT", `${action} operation cannot include fields from the other module_split action: ${present.join(", ")}.`);
  }
}

function runWorkspaceTool(args: unknown): unknown {
  const input = recordInput(args, "chain_workspace");
  const steps = input.steps ?? input.flow;
  if (!Array.isArray(steps)) fail("INVALID_MCP_INPUT", "chain_workspace requires steps or flow array.");
  return withAgentFields(runWorkspaceFlow(steps as WorkspaceFlowStep[], {
    params: recordOrUndefined(input.params, "chain_workspace params"),
    ...writeFlagsFromInput(input),
  }), input);
}

function runJsxSelectTool(args: unknown): unknown {
  const input = recordInput(args, "jsx_select");
  return runWorkspaceFlow([jsxSelectStep(input)], writeFlagsFromInput(input));
}

function runJsxNodeTool(args: unknown): unknown {
  const input = recordInput(args, "jsx_node");
  return withAgentFields(runWorkspaceFlow([jsxNodeStep(input)], writeFlagsFromInput(input)), input);
}

function runJsxAttrTool(args: unknown): unknown {
  const input = recordInput(args, "jsx_attr");
  return withAgentFields(runWorkspaceFlow([jsxAttrStep(input)], writeFlagsFromInput(input)), input);
}

function runJsxContentTool(args: unknown): unknown {
  const input = recordInput(args, "jsx_content");
  return withAgentFields(runWorkspaceFlow([jsxContentStep(input)], writeFlagsFromInput(input)), input);
}

function runImportsTool(args: unknown): unknown {
  const input = recordInput(args, "imports");
  const action = requiredString(input.action, "imports requires action: add, remove, rename, or move.");
  if (!["add", "remove", "rename", "move"].includes(action)) fail("INVALID_MCP_INPUT", "imports action must be add, remove, rename, or move.");
  if (action === "rename" && (input.name === undefined || input.to === undefined)) fail("INVALID_MCP_INPUT", "imports action=rename requires name and to.");
  if (action === "move" && input.to === undefined) fail("INVALID_MCP_INPUT", "imports action=move requires to.");
  return withAgentFields(runWorkspaceFlow([{ action: `imports.${action}`, file: requiredString(input.file, "imports requires file."), ...importFields(input) }], writeFlagsFromInput(input)), input);
}

function runExtractComponentTool(args: unknown): unknown {
  const input = recordInput(args, "extract_component");
  const mode = requiredString(input.mode, "extract_component requires mode: plan or direct.");
  if (mode === "plan") return runExtractPlanTool(input);
  if (mode === "direct") return runExtractTool(input);
  fail("INVALID_MCP_INPUT", "extract_component mode must be plan or direct.");
}

function jsxSelectStep(input: JsonRecord): WorkspaceFlowStep {
  const action = requiredString(input.action, "jsx_select requires action: find or inspect.");
  if (action === "find") {
    return { action: "find", file: requiredString(input.file, "jsx_select action=find requires file."), selector: requiredString(input.selector, "jsx_select action=find requires selector."), all: booleanValue(input.all) };
  }
  if (action === "inspect") {
    return { action: "inspect", file: requiredString(input.file, "jsx_select action=inspect requires file."), target: targetFromInput(input, "jsx_select action=inspect") };
  }
  fail("INVALID_MCP_INPUT", "jsx_select action must be find or inspect.");
}

function jsxNodeStep(input: JsonRecord): WorkspaceFlowStep {
  const action = requiredString(input.action, "jsx_node requires action.");
  const file = requiredString(input.file, "jsx_node requires file.");
  if (action === "append") return { action: "append", file, target: targetFromInput(input, "jsx_node action=append"), element: normalizeElementInput(input.element, "jsx_node action=append requires element.") };
  if (action === "prepend") return { action: "prepend", file, target: targetFromInput(input, "jsx_node action=prepend"), element: normalizeElementInput(input.element, "jsx_node action=prepend requires element.") };
  if (action === "wrap") return { action: "wrap", file, target: targetFromInput(input, "jsx_node action=wrap"), with: normalizeElementInput(pick(input, "with", "wrapper"), "jsx_node action=wrap requires with or wrapper.") };
  if (action === "unwrap") return { action: "unwrap", file, target: targetFromInput(input, "jsx_node action=unwrap") };
  if (action === "remove") return { action: "remove", file, target: targetFromInput(input, "jsx_node action=remove") };
  if (action === "rename") return { action: "rename", file, target: targetFromInput(input, "jsx_node action=rename"), name: requiredString(pick(input, "to", "name"), "jsx_node action=rename requires to or name.") };
  if (action === "insert_comment") {
    return { action: "insertComment", file, target: targetFromInput(input, "jsx_node action=insert_comment"), text: requiredString(input.text, "jsx_node action=insert_comment requires text."), ...(input.position === undefined ? {} : { position: String(input.position) as WorkspaceFlowStep["position"] }) };
  }
  fail("INVALID_MCP_INPUT", "jsx_node action must be append, prepend, wrap, unwrap, remove, rename, or insert_comment.");
}

function jsxAttrStep(input: JsonRecord): WorkspaceFlowStep {
  const action = requiredString(input.action, "jsx_attr requires action.");
  const file = requiredString(input.file, "jsx_attr requires file.");
  if (action === "prop_set") return { action: "prop.set", file, target: targetFromInput(input, "jsx_attr action=prop_set"), name: requiredString(input.name, "jsx_attr action=prop_set requires name."), value: propValue(input) };
  if (action === "prop_remove") return { action: "prop.remove", file, target: targetFromInput(input, "jsx_attr action=prop_remove"), name: requiredString(input.name, "jsx_attr action=prop_remove requires name.") };
  if (action === "class_add") return { action: "class.add", file, target: targetFromInput(input, "jsx_attr action=class_add"), classes: classNamesInput(input, "jsx_attr action=class_add") };
  if (action === "class_remove") return { action: "class.remove", file, target: targetFromInput(input, "jsx_attr action=class_remove"), classes: classNamesInput(input, "jsx_attr action=class_remove") };
  if (action === "class_replace") return { action: "class.replace", file, target: targetFromInput(input, "jsx_attr action=class_replace"), from: requiredString(input.from, "jsx_attr action=class_replace requires from."), to: requiredString(input.to, "jsx_attr action=class_replace requires to.") };
  fail("INVALID_MCP_INPUT", "jsx_attr action must be prop_set, prop_remove, class_add, class_remove, or class_replace.");
}

function jsxContentStep(input: JsonRecord): WorkspaceFlowStep {
  const action = requiredString(input.action, "jsx_content requires action.");
  const file = requiredString(input.file, "jsx_content requires file.");
  if (action === "text_set") return { action: "text.set", file, target: targetFromInput(input, "jsx_content action=text_set"), ...textSetValue(input) };
  if (action === "text_replace") return { action: "text.replace", file, target: targetFromInput(input, "jsx_content action=text_replace"), match: textMatch(input) as WorkspaceFlowStep["match"], with: textReplacement(input) as WorkspaceFlowStep["with"] };
  if (action === "expr_replace") return { action: "expr.replace", file, target: targetFromInput(input, "jsx_content action=expr_replace"), code: requiredString(input.code, "jsx_content action=expr_replace requires code.") };
  if (action === "expr_wrap") return { action: "expr.wrap", file, target: targetFromInput(input, "jsx_content action=expr_wrap"), code: requiredString(input.code, "jsx_content action=expr_wrap requires code.") };
  if (action === "expr_unwrap") return { action: "expr.unwrap", file, target: targetFromInput(input, "jsx_content action=expr_unwrap") };
  if (action === "expr_to_ternary") return { action: "expr.toTernary", file, target: targetFromInput(input, "jsx_content action=expr_to_ternary"), ...(pick(input, "alternate", "value") === undefined ? {} : { value: String(pick(input, "alternate", "value")) }) };
  if (action === "expr_to_short_circuit") return { action: "expr.toShortCircuit", file, target: targetFromInput(input, "jsx_content action=expr_to_short_circuit") };
  fail("INVALID_MCP_INPUT", "jsx_content action must be text_set, text_replace, expr_replace, expr_wrap, expr_unwrap, expr_to_ternary, or expr_to_short_circuit.");
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
  return withAgentFields(runWorkspaceFlow([step], writeFlagsFromInput(input)), input);
}

function singleStepTool(config: SingleStepConfig): TeditMcpTool {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    category: config.category ?? "structure",
    exposure: config.exposure ?? "advanced",
    action: config.action,
    aliases: config.aliases ?? (config.action === config.name ? [] : [config.action]),
    bestFor: config.bestFor,
    annotations: config.readOnly ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true } : undefined,
    handler: (args) => {
      const input = recordInput(args, config.name);
      const result = runWorkspaceFlow([config.buildStep(input)], writeFlagsFromInput(input));
      return config.readOnly ? result : withAgentFields(result, input);
    },
  };
}

function scaffoldSpecFromInput(input: JsonRecord, label = "scaffold_file"): ScaffoldSpec {
  if (input.spec !== undefined) {
    const spec = recordOrUndefined(input.spec, label + " spec");
    if (!spec) fail("INVALID_MCP_INPUT", label + " spec must be an object.");
    return spec as ScaffoldSpec;
  }
  if (input.source !== undefined) return { source: requiredString(input.source, label + " source must be a string.") };
  fail("INVALID_MCP_INPUT", label + " requires spec or source.");
}

function templateParamsFromInput(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return parseParams(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, String(child)]));
  }
  fail("INVALID_MCP_INPUT", "new_file params must be an object or key=value string array.");
}

function withAgentFields<T>(result: T, input: JsonRecord = {}): T {
  return formatAgentResult(result, outputOptionsFromRecord(input)) as T;
}

function withVerifiedAgentFields<T extends Record<string, unknown>>(result: T, input: JsonRecord, restorePoints: RestorePoint[]): T {
  return withAgentFields(applyPostVerify(result, verifySpecFromInput(input), restorePoints), input);
}

function multieditFilesFromInput(input: JsonRecord): string[] {
  const rawEdits = input.input !== undefined
    ? parseMultieditInput(requiredString(input.input, "multiedit input must be a string."))
    : input.edits;
  if (!Array.isArray(rawEdits)) return [];
  return rawEdits.flatMap((edit) => {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) return [];
    const file = (edit as JsonRecord).file;
    return typeof file === "string" ? [file] : [];
  });
}

function patchFilesForRestore(input: string): string[] {
  return parsePatchInput(input).flatMap((patch) => {
    const files = [patch.oldPath, patch.newPath, patch.file]
      .filter((file): file is string => Boolean(file) && file !== "/dev/null");
    return [...new Set(files)];
  });
}

function refactorPlanFilesForRestore(planPath: string): string[] {
  const raw = JSON.parse(readFileSync(planPath, "utf8")) as JsonRecord;
  const files = [raw.source, raw.target].filter((file): file is string => typeof file === "string" && file.length > 0);
  const operations = Array.isArray(raw.operations) ? raw.operations : [];
  for (const operation of operations) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) continue;
    const record = operation as JsonRecord;
    for (const value of [record.file, record.from, record.to]) {
      if (typeof value === "string" && value.length > 0) files.push(value);
    }
  }
  return [...new Set(files)];
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
function classNamesInput(input: JsonRecord, label: string): string | string[] {
  const value = pick(input, "classes", "className", "class", "classNames");
  if (Array.isArray(value)) return value.map((item) => String(item));
  return requiredString(value, `${label} requires classes or className. Example: {"args":{"className":"tracking-[-0.02em]"}}`);
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

function writeFlagsFromInput(input: JsonRecord, options: WriteFlagOptions = {}): WorkspaceFlowOptions {
  const dryRun = booleanValue(pick(input, "dryRun", "dry-run", "dry_run"));
  const write = input.write === undefined ? Boolean(options.defaultWrite) && !dryRun : booleanValue(input.write);
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

function requiredPatchPath(value: unknown, message: string): string {
  const path = requiredString(value, message);
  if (path.includes("\n") || path.includes("\r")) fail("INVALID_MCP_INPUT", "Patch-backed file paths cannot contain newlines.");
  return path;
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

function externalDepsFromInput(input: JsonRecord, label: string): "fail" | "params" {
  const value = pick(input, "externalDeps", "external_deps", "external-deps") ?? "fail";
  if (value === "fail" || value === "params") return value;
  fail("INVALID_MCP_INPUT", label + " externalDeps must be fail or params.");
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) fail("INVALID_MCP_INPUT", `${label} must be an integer.`);
  return numberValue;
}

function optionalNonnegativeInteger(value: unknown, label: string): number | undefined {
  const numberValue = optionalInteger(value, label);
  if (numberValue !== undefined && numberValue < 0) fail("INVALID_MCP_INPUT", `${label} must be a nonnegative integer.`);
  return numberValue;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}
