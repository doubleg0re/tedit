import { runWorkspaceFlow } from "../workspace-flow.js";
import type { WorkspaceFlowStep } from "../workspace-flow.js";
import { MCP_WRITE_BY_DEFAULT } from "./profile.js";
import { fail } from "../errors.js";
import { assertJsxFile, booleanValue, classNamesInput, functionNameFromTextReplaceArgs, importFields, normalizeElementInput, optionalString, pick, propValue, recordInput, recordOrUndefined, requiredString, runAstEditTool, runTsEditTool, runTsMoveTool, runTsRenameTool, splitTargetPrefix, textMatch, textReplacement, textSetValue, withAgentFields, writeFlagsFromInput, type JsonRecord } from "../mcp-tools.js";

export const MUTATE_JSX_OPS = [
  "prop.set", "prop.remove", "class.add", "class.remove", "class.replace",
  "text.set", "text.replace", "expr.replace", "expr.wrap", "expr.unwrap", "expr.toTernary", "expr.toShortCircuit",
  "wrap", "unwrap", "rename", "remove", "append", "prepend", "insertComment",
] as const;
export const MUTATE_IMPORT_OPS = ["imports.add", "imports.remove", "imports.rename", "imports.move"] as const;
export const MUTATE_TS_OPS = ["body.replace", "body.insertBefore", "body.insertAfter", "declaration.move", "declaration.rename"] as const;
export const MUTATE_AST_OPS = ["ast.replace"] as const;
export const MUTATE_SUPPORTED_OPS = [...MUTATE_JSX_OPS, ...MUTATE_IMPORT_OPS, ...MUTATE_TS_OPS, ...MUTATE_AST_OPS] as const;
export const MUTATE_OP_ALIASES = new Map<string, string>([
  ...MUTATE_SUPPORTED_OPS.map((op) => [op, op] as const),
  ["replace-body", "body.replace"],
  ["insert-before", "body.insertBefore"],
  ["insert-after", "body.insertAfter"],
  ["symbol.rename", "declaration.rename"],
]);
export const MUTATE_JSX_TARGETS = "jsx:<selector> or id:jsx:<id>";
export const MUTATE_TS_TARGETS = "fn:<name>, class:<name>, method:<owner.name>, prop:<name>, or var:<name>";
export const MUTATE_AST_TARGETS = "ast:<selector>, string:<exact>, contains:<text>, jsxText:<text>, jsxAttr:<name>, objectKey:<key>, or call:<callee>";
export function runMutateTool(args: unknown): unknown {
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
export function mutateOperationFromInput(input: JsonRecord): { op: string; args: JsonRecord } {
  if (input.op !== undefined) {
    const op = normalizeMutateOp(requiredString(input.op, "mutate requires op."));
    return { op, args: recordOrUndefined(input.args, "mutate args") ?? recordOrUndefined(input[op], `mutate ${op} args`) ?? {} };
  }
  const opKeys = Object.keys(input).filter((key) => MUTATE_OP_ALIASES.has(key));
  if (opKeys.length === 1) return { op: normalizeMutateOp(opKeys[0]), args: recordOrUndefined(input[opKeys[0]], `mutate ${opKeys[0]} args`) ?? {} };
  if (opKeys.length > 1) fail("INVALID_MCP_INPUT", `mutate accepts only one operation key. Found: ${opKeys.join(", ")}.`);
  fail("INVALID_MCP_INPUT", 'mutate requires op+args or one operation key like {"prop.set":{"name":"disabled","value":true}}.');
}
export function normalizeMutateOp(op: string): string {
  return MUTATE_OP_ALIASES.get(op) ?? op;
}
export function isMutateJsxOp(op: string): op is typeof MUTATE_JSX_OPS[number] {
  return (MUTATE_JSX_OPS as readonly string[]).includes(op);
}
export function isMutateImportOp(op: string): op is typeof MUTATE_IMPORT_OPS[number] {
  return (MUTATE_IMPORT_OPS as readonly string[]).includes(op);
}
export function validateMutateImportArgs(op: typeof MUTATE_IMPORT_OPS[number], args: JsonRecord): void {
  if (op === "imports.add" && args.from === undefined) fail("INVALID_MCP_INPUT", 'mutate op "imports.add" requires args.from.');
  if (op === "imports.remove" && args.from === undefined) fail("INVALID_MCP_INPUT", 'mutate op "imports.remove" requires args.from.');
  if (op === "imports.rename" && (args.from === undefined || args.name === undefined || args.to === undefined)) {
    fail("INVALID_MCP_INPUT", 'mutate op "imports.rename" requires args.from, args.name, and args.to. Example: {"imports.rename":{"from":"./old","name":"OldName","to":"NewName"}}');
  }
  if (op === "imports.move" && (args.from === undefined || args.to === undefined)) fail("INVALID_MCP_INPUT", 'mutate op "imports.move" requires args.from and args.to.');
}
export function mutateJsxStep(file: string, op: typeof MUTATE_JSX_OPS[number], target: string, args: JsonRecord): WorkspaceFlowStep {
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
export function mutateUnsupportedOp(op: string): never {
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
export function mutateJsxTarget(value: unknown, file: string, op: string, opArgs: JsonRecord = {}): string {
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
export function mutateMissingTargetFail(op: string, file: string, opArgs: JsonRecord): never {
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
export function mutateTsSelector(value: unknown, file: string, op: string): string {
  const raw = requiredString(value, `mutate op "${op}" requires target. Valid prefixes: ${mutateTargetHelp(op).prefixes.join(", ")}.`);
  const [prefix] = splitTargetPrefix(raw);
  if (mutateTargetHelp(op).prefixes.map((item) => item.replace(/:$/, "")).includes(prefix ?? "")) return raw;
  mutateTargetFail(op, file, raw, prefix);
}
export function mutateAstTarget(value: unknown, op: string): JsonRecord {
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
export function mutateTargetHelp(op: string): { prefixes: string[]; examples: string[] } {
  if (op === "body.replace") return { prefixes: ["fn:", "method:", "class:"], examples: ['target="fn:<name>"', 'target="method:<owner.name>"'] };
  if (op === "body.insertBefore" || op === "body.insertAfter" || op === "declaration.move") return { prefixes: ["fn:", "class:", "method:", "prop:", "var:"], examples: ['target="fn:<name>"', 'target="class:<name>"'] };
  if (op === "declaration.rename") return { prefixes: ["fn:", "class:", "var:"], examples: ['target="fn:<name>"', 'target="var:<name>"'] };
  if (isMutateJsxOp(op)) return { prefixes: ["jsx:", "id:jsx:"], examples: ['target="jsx:Button"', 'target="id:jsx:<id>"'] };
  if (op === "ast.replace") return { prefixes: ["objectKey:", "call:", "string:", "contains:", "jsxText:", "jsxAttr:", "ast:"], examples: ['target="objectKey:label"', 'target="call:toast.error"'] };
  return { prefixes: [], examples: [] };
}
export function mutateTargetFail(op: string, file: string | undefined, raw: string, prefix: string | undefined): never {
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
export function mutateTargetSuggestion(raw: string, prefixes: string[]): string | undefined {
  const [, rest] = splitTargetPrefix(raw);
  if (!rest || prefixes.length === 0) return undefined;
  const prefix = prefixes[0].replace(/:$/, "");
  return `${prefix}:${rest}`;
}
