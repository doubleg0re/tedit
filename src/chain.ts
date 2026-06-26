import { fail } from "./errors.js";
import type { TreeNodeSpec } from "./core/document.js";
import type { FlowStep } from "./flow.js";
import type { WorkspaceFlowStep } from "./workspace-flow.js";

export type ChainSegment = {
  action: string;
  args: string[];
  line?: number;
  source?: string;
};

const CHAINABLE_ACTIONS = new Set([
  "find",
  "inspect",
  "append",
  "prepend",
  "wrap",
  "unwrap",
  "rename",
  "remove",
  "prop.set",
  "prop.remove",
  "class.replace",
  "class.remove",
  "class.add",
  "insertComment",
  "text.set",
  "text.replace",
  "imports.add",
  "imports.remove",
  "imports.rename",
  "imports.move",
  "expr.replace",
  "expr.wrap",
  "expr.unwrap",
  "expr.toTernary",
  "expr.toShortCircuit",
  "log",
]);

export function parseChainSegments(argv: string[]): ChainSegment[] {
  const segments: ChainSegment[] = [];
  let current: string[] = [];

  for (const arg of argv) {
    if (arg === "::") {
      if (current.length > 0) segments.push({ action: current[0], args: current.slice(1) });
      current = [];
    } else {
      current.push(arg);
    }
  }

  if (current.length > 0) segments.push({ action: current[0], args: current.slice(1) });
  return segments;
}

export function parseChainText(input: string): ChainSegment[] {
  const segments: ChainSegment[] = [];

  input.split(/\r?\n/).forEach((line, index) => {
    const tokens = tokenizeChainLine(line);
    if (tokens.length === 0) return;

    let current: string[] = [];
    const push = (): void => {
      if (current.length === 0) return;
      segments.push({
        action: current[0],
        args: current.slice(1),
        line: index + 1,
        source: line.trim(),
      });
      current = [];
    };

    for (const token of tokens) {
      if (token === "::") push();
      else current.push(token);
    }
    push();
  });

  return segments;
}

export function chainToFlow(segments: ChainSegment[]): FlowStep[] {
  return segments.map((segment, index) => {
    if (!CHAINABLE_ACTIONS.has(segment.action)) {
      fail("UNSUPPORTED_CHAIN_ACTION", `Action "${segment.action}" is not chainable.`);
    }

    const { cleanSegment, out } = extractNamedOutput(segment, index);
    const step = segmentToStep(cleanSegment, index);
    return out ? { ...step, out } : step;
  });
}

export function workspaceChainToFlow(segments: ChainSegment[]): WorkspaceFlowStep[] {
  return segments.map((segment, index) => {
    if (segment.action === "extract") return extractSegmentToWorkspaceStep(segment, index);
    if (segment.action === "in") return inSegmentToWorkspaceStep(segment, index);
    fail("UNSUPPORTED_CHAIN_ACTION", `Workspace chain action "${segment.action}" must be "extract" or "in".`);
  });
}

export function fileChainToWorkspaceFlow(file: string, segments: ChainSegment[]): WorkspaceFlowStep[] {
  const steps: WorkspaceFlowStep[] = [];
  let pending: ChainSegment[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    steps.push({ action: "chain", file: normalizeChainRef(file), steps: chainToFlow(pending) });
    pending = [];
  };

  segments.forEach((segment, index) => {
    if (segment.action === "create" || segment.action === "write") {
      if (steps.length > 0 || pending.length > 0) {
        fail("INVALID_CHAIN", `${chainLoc(segment, index)}: ${segment.action} is only supported as the first chain step.`);
      }
      steps.push(writeSegmentToWorkspaceStep(segment, file, index));
      return;
    }
    if (segment.action === "edit") {
      flush();
      steps.push(editSegmentToWorkspaceStep(segment, file, index));
      return;
    }
    pending.push(segment);
  });
  flush();
  return steps;
}

function extractNamedOutput(segment: ChainSegment, index: number): { cleanSegment: ChainSegment; out?: string } {
  const asIndex = segment.args.length - 2;
  if (asIndex < 0 || segment.args[asIndex] !== "as") return { cleanSegment: segment };

  const out = segment.args[asIndex + 1];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(out)) {
    fail("INVALID_CHAIN", `chain segment ${index} (${segment.action}): invalid output name "${out}".`);
  }
  return {
    cleanSegment: { ...segment, args: segment.args.slice(0, asIndex) },
    out,
  };
}

type ChainStepHandler = (segment: ChainSegment, index: number, loc: string) => FlowStep;

const CHAIN_STEP_HANDLERS: Record<string, ChainStepHandler> = {
  find: findStep,
  inspect: inspectStep,
  append: appendPrependStep,
  prepend: appendPrependStep,
  wrap: wrapStep,
  unwrap: targetOnlyStep,
  remove: targetOnlyStep,
  rename: renameStep,
  "prop.set": propSetStep,
  "prop.remove": propRemoveStep,
  "class.add": classToggleStep,
  "class.remove": classToggleStep,
  "class.replace": classReplaceStep,
  insertComment: insertCommentStep,
  "text.set": textSetStep,
  "text.replace": textReplaceStep,
  "imports.add": importsAddRemoveStep,
  "imports.remove": importsAddRemoveStep,
  "imports.rename": importsRenameStep,
  "imports.move": importsMoveStep,
  "expr.replace": exprCodeStep,
  "expr.wrap": exprCodeStep,
  "expr.unwrap": exprTargetOnlyStep,
  "expr.toShortCircuit": exprTargetOnlyStep,
  "expr.toTernary": exprToTernaryStep,
  log: logStep,
};

function segmentToStep(segment: ChainSegment, index: number): FlowStep {
  const handler = CHAIN_STEP_HANDLERS[segment.action];
  if (!handler) fail("UNSUPPORTED_CHAIN_ACTION", `Action "${segment.action}" is not chainable.`);
  return handler(segment, index, chainLoc(segment, index));
}

function findStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, []);
  const [selector] = parsed.positionals;
  if (!selector) fail("INVALID_CHAIN", `${loc}: find requires <selector>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, 1);
  return { action: "find", selector: normalizeChainRef(selector) };
}

function inspectStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id"]);
  const { target, offset } = targetWithOffset(parsed);
  if (!target) fail("INVALID_CHAIN", `${loc}: inspect requires <target>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, offset);
  return { action: "inspect", target: normalizeChainRef(target) };
}

function appendPrependStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id", "element"]);
  const { target, offset } = targetWithOffset(parsed);
  const element = getFlag(parsed, "element") ?? parsed.positionals[offset];
  if (!target || !element) fail("INVALID_CHAIN", `${loc}: ${segment.action} requires <target> <tag-or-json>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, offset + (getFlag(parsed, "element") ? 0 : 1));
  return {
    action: segment.action,
    target: normalizeChainRef(target),
    element: parseElementArg(element),
  };
}

function wrapStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id", "with"]);
  const { target, offset } = targetWithOffset(parsed);
  const wrapper = getFlag(parsed, "with") ?? parsed.positionals[offset];
  if (!target || !wrapper) fail("INVALID_CHAIN", `${loc}: wrap requires <target> <tag-or-json>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, offset + (getFlag(parsed, "with") ? 0 : 1));
  return { action: "wrap", target: normalizeChainRef(target), with: parseWrapperArg(wrapper) };
}

function targetOnlyStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id"]);
  const { target, offset } = targetWithOffset(parsed);
  if (!target) fail("INVALID_CHAIN", `${loc}: ${segment.action} requires <target>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, offset);
  return { action: segment.action, target: normalizeChainRef(target) };
}

function renameStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id", "to"]);
  const { target, offset } = targetWithOffset(parsed);
  const name = getFlag(parsed, "to") ?? parsed.positionals[offset];
  if (!target || !name) fail("INVALID_CHAIN", `${loc}: rename requires <target> <name> or <target> --to <name>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, offset + (getFlag(parsed, "to") ? 0 : 1));
  return { action: "rename", target: normalizeChainRef(target), name: normalizeChainRef(name) };
}

function propSetStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id", "expr"]);
  const { target, offset } = targetWithOffset(parsed);
  const name = parsed.positionals[offset];
  const value = getFlag(parsed, "expr")
    ? { type: "expr", code: getFlag(parsed, "expr") }
    : parseValueArg(parsed.positionals[offset + 1] ?? true);
  if (!target || !name) fail("INVALID_CHAIN", `${loc}: prop.set requires <target> <name> [value].`);
  ensureNoExtraArgs(segment, index, parsed.positionals, offset + 1 + (getFlag(parsed, "expr") ? 0 : 1));
  return { action: "prop.set", target: normalizeChainRef(target), name: normalizeChainRef(name), value };
}

function propRemoveStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id"]);
  const { target, offset } = targetWithOffset(parsed);
  const name = parsed.positionals[offset];
  if (!target || !name) fail("INVALID_CHAIN", `${loc}: prop.remove requires <target> <name>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, offset + 1);
  return { action: "prop.remove", target: normalizeChainRef(target), name: normalizeChainRef(name) };
}

function classToggleStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id", "classes"]);
  const { target, offset } = targetWithOffset(parsed);
  const classes = getFlag(parsed, "classes") ?? parsed.positionals.slice(offset).join(" ");
  if (!target || !classes) fail("INVALID_CHAIN", `${loc}: ${segment.action} requires <target> <class...>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, getFlag(parsed, "classes") ? offset : parsed.positionals.length);
  return { action: segment.action, target: normalizeChainRef(target), classes: normalizeChainRef(classes) };
}

function classReplaceStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id", "from", "to"]);
  const { target, offset } = targetWithOffset(parsed);
  const from = getFlag(parsed, "from") ?? parsed.positionals[offset];
  const to = getFlag(parsed, "to") ?? parsed.positionals[offset + (getFlag(parsed, "from") ? 0 : 1)];
  if (!target || !from || !to) fail("INVALID_CHAIN", `${loc}: class.replace requires <target> <from> <to>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, offset + (getFlag(parsed, "from") ? 0 : 1) + (getFlag(parsed, "to") ? 0 : 1));
  return { action: "class.replace", target: normalizeChainRef(target), from: normalizeChainRef(from), to: normalizeChainRef(to) };
}

function insertCommentStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id", "position", "text"]);
  const { target, offset } = targetWithOffset(parsed);
  const explicitText = getFlag(parsed, "text");
  const explicitPosition = getFlag(parsed, "position");
  if (!target) fail("INVALID_CHAIN", `${loc}: insertComment requires <target> [position] <text>.`);
  if (explicitText) {
    ensureNoExtraArgs(segment, index, parsed.positionals, offset);
    return { action: "insertComment", target: normalizeChainRef(target), ...(explicitPosition ? { position: explicitPosition as FlowStep["position"] } : {}), text: normalizeChainRef(explicitText) };
  }
  const first = parsed.positionals[offset];
  if (!first) fail("INVALID_CHAIN", `${loc}: insertComment requires <target> [position] <text>.`);
  if (["inside-start", "inside-end", "before", "after"].includes(first)) {
    return { action: "insertComment", target: normalizeChainRef(target), position: first as FlowStep["position"], text: normalizeChainRef(parsed.positionals.slice(offset + 1).join(" ")) };
  }
  return { action: "insertComment", target: normalizeChainRef(target), text: normalizeChainRef(parsed.positionals.slice(offset).join(" ")) };
}

function textSetStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id", "value", "expr"]);
  const { target, offset } = targetWithOffset(parsed);
  const value = getFlag(parsed, "value") ?? parsed.positionals[offset];
  const expr = getFlag(parsed, "expr");
  if (!target) fail("INVALID_CHAIN", `${loc}: text.set requires <target> and --value/--expr.`);
  if ((value === undefined) === (expr === undefined)) fail("INVALID_CHAIN", `${loc}: text.set requires exactly one of --value or --expr.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, offset + (getFlag(parsed, "value") || expr ? 0 : 1));
  return { action: "text.set", target: normalizeChainRef(target), ...(expr !== undefined ? { expr: normalizeChainRef(expr) } : { value: normalizeChainRef(value ?? "") }) };
}

function textReplaceStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id", "match-text", "match-expr", "match-any", "with-text", "with-expr"]);
  const { target, offset } = targetWithOffset(parsed);
  if (!target) fail("INVALID_CHAIN", `${loc}: text.replace requires <target>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, offset);
  return { action: "text.replace", target: normalizeChainRef(target), match: parseTextMatchArg(parsed, loc), with: parseTextWithArg(parsed, loc) };
}

function importsAddRemoveStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["from", "named", "default", "namespace"]);
  const from = getFlag(parsed, "from") ?? parsed.positionals[0];
  const named = getFlag(parsed, "named") ?? parsed.positionals[1];
  if (!from) fail("INVALID_CHAIN", `${loc}: ${segment.action} requires --from <source>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, (getFlag(parsed, "from") ? 0 : 1) + (getFlag(parsed, "named") ? 0 : named ? 1 : 0));
  return {
    action: segment.action,
    from: normalizeChainRef(from),
    ...(named ? { named } : {}),
    ...(getFlag(parsed, "default") ? { default: getFlag(parsed, "default") } : {}),
    ...(getFlag(parsed, "namespace") ? { namespace: getFlag(parsed, "namespace") } : {}),
  };
}

function importsRenameStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["from", "name", "to"]);
  const from = getFlag(parsed, "from") ?? parsed.positionals[0];
  const name = getFlag(parsed, "name") ?? parsed.positionals[getFlag(parsed, "from") ? 0 : 1];
  const to = getFlag(parsed, "to") ?? parsed.positionals[(getFlag(parsed, "from") ? 0 : 1) + (getFlag(parsed, "name") ? 0 : 1)];
  if (!from || !name || !to) fail("INVALID_CHAIN", `${loc}: imports.rename requires <from> <name> <to>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, (getFlag(parsed, "from") ? 0 : 1) + (getFlag(parsed, "name") ? 0 : 1) + (getFlag(parsed, "to") ? 0 : 1));
  return { action: "imports.rename", from: normalizeChainRef(from), name, to };
}

function importsMoveStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["from", "to", "named", "default", "namespace"]);
  const from = getFlag(parsed, "from") ?? parsed.positionals[0];
  const to = getFlag(parsed, "to") ?? parsed.positionals[getFlag(parsed, "from") ? 0 : 1];
  const named = getFlag(parsed, "named") ?? parsed.positionals[(getFlag(parsed, "from") ? 0 : 1) + (getFlag(parsed, "to") ? 0 : 1)];
  if (!from || !to) fail("INVALID_CHAIN", `${loc}: imports.move requires <from> <to>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, (getFlag(parsed, "from") ? 0 : 1) + (getFlag(parsed, "to") ? 0 : 1) + (getFlag(parsed, "named") ? 0 : named ? 1 : 0));
  return {
    action: "imports.move",
    from: normalizeChainRef(from),
    to: normalizeChainRef(to),
    ...(named ? { named } : {}),
    ...(getFlag(parsed, "default") ? { default: getFlag(parsed, "default") } : {}),
    ...(getFlag(parsed, "namespace") ? { namespace: getFlag(parsed, "namespace") } : {}),
  };
}

function exprCodeStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id", "code"]);
  const { target, offset } = targetWithOffset(parsed);
  const code = getFlag(parsed, "code") ?? parsed.positionals.slice(offset).join(" ");
  if (!target || !code) fail("INVALID_CHAIN", `${loc}: ${segment.action} requires <target> <code>.`);
  return { action: segment.action, target: normalizeChainRef(target), code: normalizeChainRef(code) };
}

function exprTargetOnlyStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id"]);
  const { target, offset } = targetWithOffset(parsed);
  if (!target) fail("INVALID_CHAIN", `${loc}: ${segment.action} requires <target>.`);
  ensureNoExtraArgs(segment, index, parsed.positionals, offset);
  return { action: segment.action, target: normalizeChainRef(target) };
}

function exprToTernaryStep(segment: ChainSegment, index: number, loc: string): FlowStep {
  const parsed = parseStepArgs(segment, index, ["id", "alternate"]);
  const { target, offset } = targetWithOffset(parsed);
  const value = getFlag(parsed, "alternate") ?? parsed.positionals.slice(offset).join(" ");
  if (!target) fail("INVALID_CHAIN", `${loc}: expr.toTernary requires <target> [alternate].`);
  return { action: "expr.toTernary", target: normalizeChainRef(target), ...(value ? { value: normalizeChainRef(value) } : {}) };
}

function logStep(segment: ChainSegment, index: number): FlowStep {
  const parsed = parseStepArgs(segment, index, ["ref"]);
  const ref = getFlag(parsed, "ref") ?? parsed.positionals[0];
  ensureNoExtraArgs(segment, index, parsed.positionals, getFlag(parsed, "ref") ? 0 : ref ? 1 : 0);
  return ref ? { action: "log", ref: normalizeChainRef(ref) } : { action: "log" };
}

function targetWithOffset(parsed: ParsedStepArgs): { target?: string; offset: number } {
  const id = getFlag(parsed, "id");
  return { target: id ?? parsed.positionals[0], offset: id ? 0 : 1 };
}

function extractSegmentToWorkspaceStep(segment: ChainSegment, index: number): WorkspaceFlowStep {
  const { cleanSegment, out } = extractNamedOutput(segment, index);
  const parsed = parseWorkspaceExtractArgs(cleanSegment, index);
  const [from, selector] = parsed.positionals;
  const to = getWorkspaceFlag(parsed, "to");
  const name = getWorkspaceFlag(parsed, "name");
  if (!from || !selector || !to || !name) {
    fail("INVALID_CHAIN", `${chainLoc(segment, index)}: extract requires <from> <selector> --to <file> --name <ComponentName>.`);
  }
  ensureNoExtraArgs(segment, index, parsed.positionals, 2);

  const step: WorkspaceFlowStep = {
    action: "extract",
    from: normalizeChainRef(from),
    selector: normalizeChainRef(selector),
    to: normalizeChainRef(to),
    name: normalizeChainRef(name),
    ...(getWorkspaceFlag(parsed, "export") ? { exportKind: getWorkspaceFlag(parsed, "export") as "named" | "default" } : {}),
    ...(getWorkspaceFlag(parsed, "depth") ? { depth: getWorkspaceFlag(parsed, "depth") } : {}),
    ...(hasWorkspaceFlag(parsed, "auto-slot") ? { autoSlot: true } : {}),
    ...(hasWorkspaceFlag(parsed, "overwrite") ? { overwrite: true } : {}),
    ...(hasWorkspaceFlag(parsed, "typecheck") ? { typecheck: true } : {}),
    ...(hasWorkspaceFlag(parsed, "accept-large-props") ? { acceptLargeProps: true } : {}),
    ...(getWorkspaceFlag(parsed, "max-props") ? { maxProps: getWorkspaceFlag(parsed, "max-props") } : {}),
    ...(getWorkspaceFlag(parsed, "helpers") ? { helpersPolicy: getWorkspaceFlag(parsed, "helpers") as WorkspaceFlowStep["helpersPolicy"] } : {}),
    ...(getWorkspaceFlags(parsed, "slot").length > 0 ? { slots: getWorkspaceFlags(parsed, "slot") } : {}),
    ...(getWorkspaceFlags(parsed, "helper").length > 0 ? { helperOverrides: getWorkspaceFlags(parsed, "helper") } : {}),
  };
  return out ? { ...step, out } : step;
}

function inSegmentToWorkspaceStep(segment: ChainSegment, index: number): WorkspaceFlowStep {
  const [file, action, ...args] = segment.args;
  if (!file || !action) {
    fail("INVALID_CHAIN", `${chainLoc(segment, index)}: in requires <file> <chain-action> [args...].`);
  }
  if (action === "edit") {
    return editSegmentToWorkspaceStep({ action, args, line: segment.line, source: segment.source }, file, index);
  }
  const steps = chainToFlow([{ action, args, line: segment.line, source: segment.source }]);
  return { action: "chain", file: normalizeChainRef(file), steps };
}

function writeSegmentToWorkspaceStep(segment: ChainSegment, file: string, index: number): WorkspaceFlowStep {
  const parsed = parseWorkspaceWriteArgs(segment, index);
  const source = getWorkspaceFlag(parsed, "source") ?? parsed.positionals.join(" ");
  if (!source) fail("INVALID_CHAIN", `${chainLoc(segment, index)}: ${segment.action} requires --source <text> or inline source text.`);
  return {
    action: segment.action,
    file: normalizeChainRef(file),
    source: normalizeChainRef(source),
  };
}

function editSegmentToWorkspaceStep(segment: ChainSegment, file: string, index: number): WorkspaceFlowStep {
  const parsed = parseWorkspaceEditArgs(segment, index);
  ensureNoExtraArgs(segment, index, parsed.positionals, 0);
  const step: WorkspaceFlowStep = {
    action: "edit",
    file: normalizeChainRef(file),
  };
  copyWorkspaceEditFlag(parsed, step, "find");
  copyWorkspaceEditFlag(parsed, step, "find-exact");
  copyWorkspaceEditFlag(parsed, step, "find-fuzzy");
  copyWorkspaceEditFlag(parsed, step, "find-anchor-after");
  copyWorkspaceEditFlag(parsed, step, "contains");
  copyWorkspaceEditFlag(parsed, step, "find-regex");
  copyWorkspaceEditFlag(parsed, step, "flags");
  copyWorkspaceEditFlag(parsed, step, "find-lines");
  copyWorkspaceEditFlag(parsed, step, "replace");
  copyWorkspaceEditFlag(parsed, step, "insert-before");
  copyWorkspaceEditFlag(parsed, step, "insert-after");
  copyWorkspaceEditFlag(parsed, step, "expect-count");
  if (hasWorkspaceFlag(parsed, "delete")) step.delete = true;
  if (hasWorkspaceFlag(parsed, "replace-all")) step["replace-all"] = true;
  return step;
}

type ParsedWorkspaceExtractArgs = {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
};

function parseWorkspaceExtractArgs(segment: ChainSegment, index: number): ParsedWorkspaceExtractArgs {
  const valueFlags = new Set(["to", "name", "slot", "depth", "helpers", "helper", "export", "max-props"]);
  const booleanFlags = new Set(["auto-slot", "overwrite", "typecheck", "accept-large-props"]);
  const positionals: string[] = [];
  const flags: ParsedWorkspaceExtractArgs["flags"] = {};

  for (let cursor = 0; cursor < segment.args.length; cursor++) {
    const arg = segment.args[cursor];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (booleanFlags.has(name)) {
      addWorkspaceFlag(flags, name, eq >= 0 ? arg.slice(eq + 1) : true);
      continue;
    }
    if (!valueFlags.has(name)) {
      fail("INVALID_CHAIN", `${chainLoc(segment, index)}: unknown argument "${arg}".${chainSourceHint(segment)}`);
    }

    const value = eq >= 0 ? arg.slice(eq + 1) : segment.args[cursor + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_CHAIN", `${chainLoc(segment, index)}: --${name} requires a value.${chainSourceHint(segment)}`);
    }
    addWorkspaceFlag(flags, name, value);
    if (eq < 0) cursor++;
  }

  return { positionals, flags };
}

function parseWorkspaceWriteArgs(segment: ChainSegment, index: number): ParsedWorkspaceExtractArgs {
  const valueFlags = new Set(["source"]);
  const positionals: string[] = [];
  const flags: ParsedWorkspaceExtractArgs["flags"] = {};

  for (let cursor = 0; cursor < segment.args.length; cursor++) {
    const arg = segment.args[cursor];
    if (!arg.startsWith("--")) {
      positionals.push(normalizeChainRef(arg));
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (!valueFlags.has(name)) {
      fail("INVALID_CHAIN", `${chainLoc(segment, index)}: unknown argument "${arg}".${chainSourceHint(segment)}`);
    }

    const value = eq >= 0 ? arg.slice(eq + 1) : segment.args[cursor + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_CHAIN", `${chainLoc(segment, index)}: --${name} requires a value.${chainSourceHint(segment)}`);
    }
    addWorkspaceFlag(flags, name, normalizeChainRef(value));
    if (eq < 0) cursor++;
  }

  return { positionals, flags };
}

function parseWorkspaceEditArgs(segment: ChainSegment, index: number): ParsedWorkspaceExtractArgs {
  const valueFlags = new Set([
    "find",
    "find-exact",
    "find-fuzzy",
    "find-anchor-after",
    "contains",
    "find-regex",
    "flags",
    "find-lines",
    "replace",
    "insert-before",
    "insert-after",
    "expect-count",
  ]);
  const booleanFlags = new Set(["delete", "replace-all"]);
  const positionals: string[] = [];
  const flags: ParsedWorkspaceExtractArgs["flags"] = {};

  for (let cursor = 0; cursor < segment.args.length; cursor++) {
    const arg = segment.args[cursor];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (booleanFlags.has(name)) {
      addWorkspaceFlag(flags, name, eq >= 0 ? arg.slice(eq + 1) : true);
      continue;
    }
    if (!valueFlags.has(name)) {
      fail("INVALID_CHAIN", `${chainLoc(segment, index)}: unknown argument "${arg}".${chainSourceHint(segment)}`);
    }

    const value = eq >= 0 ? arg.slice(eq + 1) : segment.args[cursor + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_CHAIN", `${chainLoc(segment, index)}: --${name} requires a value.${chainSourceHint(segment)}`);
    }
    addWorkspaceFlag(flags, name, normalizeChainRef(value));
    if (eq < 0) cursor++;
  }

  return { positionals, flags };
}

function copyWorkspaceEditFlag(parsed: ParsedWorkspaceExtractArgs, step: WorkspaceFlowStep, name: string): void {
  const value = getWorkspaceFlag(parsed, name);
  if (value === undefined) return;
  (step as Record<string, unknown>)[name] = value;
}

function addWorkspaceFlag(flags: ParsedWorkspaceExtractArgs["flags"], name: string, value: string | boolean): void {
  const existing = flags[name];
  if (existing === undefined) flags[name] = value;
  else if (Array.isArray(existing)) existing.push(String(value));
  else flags[name] = [String(existing), String(value)];
}

function getWorkspaceFlag(parsed: ParsedWorkspaceExtractArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  if (value === undefined || value === false) return undefined;
  if (Array.isArray(value)) return value.at(-1);
  return String(value);
}

function getWorkspaceFlags(parsed: ParsedWorkspaceExtractArgs, name: string): string[] {
  const value = parsed.flags[name];
  if (value === undefined || value === false || value === true) return [];
  return Array.isArray(value) ? value : [String(value)];
}

function hasWorkspaceFlag(parsed: ParsedWorkspaceExtractArgs, name: string): boolean {
  const value = parsed.flags[name];
  return value === true || value === "true";
}

type ParsedStepArgs = {
  positionals: string[];
  flags: Record<string, string>;
};

function parseStepArgs(segment: ChainSegment, index: number, allowedFlags: string[]): ParsedStepArgs {
  const allowed = new Set(allowedFlags);
  const positionals: string[] = [];
  const flags: Record<string, string> = {};

  for (let cursor = 0; cursor < segment.args.length; cursor++) {
    const arg = segment.args[cursor];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (!allowed.has(name)) {
      fail("INVALID_CHAIN", `${chainLoc(segment, index)}: unknown argument "${arg}".${chainSourceHint(segment)}`);
    }

    const value = eq >= 0 ? arg.slice(eq + 1) : segment.args[cursor + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_CHAIN", `${chainLoc(segment, index)}: --${name} requires a value.${chainSourceHint(segment)}`);
    }
    flags[name] = value;
    if (eq < 0) cursor++;
  }

  return { positionals, flags };
}

function getFlag(parsed: ParsedStepArgs, name: string): string | undefined {
  return parsed.flags[name];
}

function parseTextMatchArg(parsed: ParsedStepArgs, loc: string): { kind: "text"; value: string } | { kind: "expr"; code: string } | { kind: "any"; value: string } {
  const text = getFlag(parsed, "match-text");
  const expr = getFlag(parsed, "match-expr");
  const any = getFlag(parsed, "match-any");
  const count = [text !== undefined, expr !== undefined, any !== undefined].filter(Boolean).length;
  if (count !== 1) fail("INVALID_CHAIN", `${loc}: text.replace requires exactly one match flag.`);
  if (text !== undefined) return { kind: "text", value: normalizeChainRef(text) };
  if (expr !== undefined) return { kind: "expr", code: normalizeChainRef(expr) };
  return { kind: "any", value: normalizeChainRef(any ?? "") };
}

function parseTextWithArg(parsed: ParsedStepArgs, loc: string): { kind: "text"; value: string } | { kind: "expr"; code: string } {
  const text = getFlag(parsed, "with-text");
  const expr = getFlag(parsed, "with-expr");
  if ((text === undefined) === (expr === undefined)) fail("INVALID_CHAIN", `${loc}: text.replace requires exactly one replacement flag.`);
  if (expr !== undefined) return { kind: "expr", code: normalizeChainRef(expr) };
  return { kind: "text", value: normalizeChainRef(text ?? "") };
}

function ensureNoExtraArgs(segment: ChainSegment, index: number, positionals: string[], max: number): void {
  if (positionals.length <= max) return;
  const extra = positionals[max];
  fail("INVALID_CHAIN", `${chainLoc(segment, index)}: unknown argument "${extra}".${chainSourceHint(segment)}`);
}

function chainLoc(segment: ChainSegment, index: number): string {
  const line = segment.line ? ` line ${segment.line}` : "";
  return `chain segment ${index}${line} (${segment.action})`;
}

function chainSourceHint(segment: ChainSegment): string {
  return segment.source ? ` Source: ${JSON.stringify(segment.source)}.` : "";
}

function parseElementArg(value: string): TreeNodeSpec {
  if (value.trim().startsWith("{")) return normalizeJsonRefs(JSON.parse(value)) as TreeNodeSpec;
  return parseElementShorthand(value);
}

function parseWrapperArg(value: string): TreeNodeSpec | string {
  if (value.trim().startsWith("{")) return normalizeJsonRefs(JSON.parse(value)) as TreeNodeSpec;
  return parseElementShorthand(value);
}

function parseValueArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.trim().startsWith("{")) return normalizeJsonRefs(JSON.parse(value));
  return normalizeChainRef(value);
}

function normalizeJsonRefs(value: unknown): unknown {
  if (typeof value === "string") return normalizeChainRef(value);
  if (Array.isArray(value)) return value.map((item) => normalizeJsonRefs(item));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) result[key] = normalizeJsonRefs(child);
    return result;
  }
  return value;
}

function normalizeChainRef(value: string): string {
  if (/^@[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/.test(value)) return `{{${value.slice(1)}}}`;
  return /^\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/.test(value) ? `{{${value}}}` : value;
}

export function parseElementShorthand(input: string): TreeNodeSpec {
  const value = input.trim();
  if (!value) fail("INVALID_ELEMENT", "Element shorthand cannot be empty.");

  const cssStyleSpec = parseCssStyleElementShorthand(value);
  if (cssStyleSpec) return cssStyleSpec;

  const parts = splitShorthandParts(value);
  const attrStart = findAttributeStart(parts);
  const tag = parts.slice(0, attrStart).join(".");
  if (!tag) fail("INVALID_ELEMENT", `Invalid element shorthand: ${input}`);

  const attributes: Record<string, unknown> = {};
  const spec: TreeNodeSpec = { tag };

  for (const part of parts.slice(attrStart)) {
    const parsed = parseShorthandAttribute(part, input);
    if (parsed.name === "children") {
      if (typeof parsed.value !== "string") fail("INVALID_ELEMENT", "children shorthand only supports string text.");
      spec.children = [...(spec.children ?? []), { text: parsed.value }];
    } else {
      attributes[parsed.name] = parsed.value;
    }
  }

  if (Object.keys(attributes).length > 0) {
    spec.attributes = attributes as TreeNodeSpec["attributes"];
  }
  return spec;
}

function parseCssStyleElementShorthand(value: string): TreeNodeSpec | null {
  if (!looksLikeCssStyleElementShorthand(value)) return null;

  const tagResult = readCssStyleTag(value);
  const attributes: Record<string, unknown> = {};
  let cursor = tagResult.end;
  let consumed = false;

  while (cursor < value.length) {
    const char = value[cursor];
    if (char === "#") {
      const id = readCssStyleName(value, cursor + 1, "id");
      attributes.id = id.value;
      cursor = id.end;
      consumed = true;
      continue;
    }

    if (char === ".") {
      const className = readCssStyleName(value, cursor + 1, "class");
      addClassName(attributes, className.value);
      cursor = className.end;
      consumed = true;
      continue;
    }

    if (char === "[") {
      const attr = readBalancedShorthand(value, cursor, "[", "]");
      const parsed = parseShorthandAttribute(attr.inner, value);
      const name = parsed.name === "class" ? "className" : parsed.name;
      if (name === "className" && typeof parsed.value === "string") addClassName(attributes, parsed.value);
      else attributes[name] = parsed.value;
      cursor = attr.end + 1;
      consumed = true;
      continue;
    }

    return null;
  }

  if (!consumed) return null;
  return {
    tag: tagResult.tag ?? "div",
    ...(Object.keys(attributes).length > 0 ? { attributes: attributes as TreeNodeSpec["attributes"] } : {}),
  };
}

function looksLikeCssStyleElementShorthand(value: string): boolean {
  if (value.startsWith(".") || value.startsWith("#")) return true;
  if (value.includes("#") || value.includes("[")) return true;
  return /^[a-z][\w-]*\.[A-Za-z_-][\w-]*/.test(value) && !/^[a-z][\w-]*\.[A-Za-z_$][\w$:-]*=/.test(value);
}

function readCssStyleTag(value: string): { tag?: string; end: number } {
  if (value.startsWith(".") || value.startsWith("#") || value.startsWith("[")) return { end: 0 };
  const match = value.match(/^[A-Za-z_$][\w$-]*/);
  if (!match) fail("INVALID_ELEMENT", `Invalid element shorthand: ${value}`);
  return { tag: match[0], end: match[0].length };
}

function readCssStyleName(value: string, start: number, label: string): { value: string; end: number } {
  if (!/[A-Za-z_-]/.test(value[start] ?? "")) fail("INVALID_ELEMENT", `Invalid ${label} shorthand in ${value}`);
  let end = start + 1;
  while (end < value.length && /[\w-]/.test(value[end])) end++;
  return { value: value.slice(start, end), end };
}

function addClassName(attributes: Record<string, unknown>, className: string): void {
  const current = attributes.className;
  if (current === undefined) {
    attributes.className = className;
    return;
  }
  if (typeof current === "string") {
    attributes.className = `${current} ${className}`;
    return;
  }
  fail("INVALID_ELEMENT", "Cannot combine class shorthand with non-string className.");
}

function readBalancedShorthand(input: string, start: number, open: string, close: string): { inner: string; end: number } {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote && input[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === open) depth++;
    if (char === close) {
      depth--;
      if (depth === 0) return { inner: input.slice(start + 1, index), end: index };
    }
  }
  fail("INVALID_ELEMENT", `Unbalanced element shorthand: ${input}`);
}

function findAttributeStart(parts: string[]): number {
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index];
    if (findTopLevelEquals(part) >= 0) return index;
    if (/^[a-z_][\w$:-]*$/.test(part)) return index;
  }
  return parts.length;
}

function parseShorthandAttribute(part: string, source: string): { name: string; value: unknown } {
  const eq = findTopLevelEquals(part);
  const name = eq >= 0 ? part.slice(0, eq) : part;
  if (!/^[A-Za-z_$][\w$:-]*$/.test(name)) fail("INVALID_ELEMENT", `Invalid shorthand attribute in ${source}`);
  if (eq < 0) return { name, value: true };

  const raw = part.slice(eq + 1).trim();
  if (raw.startsWith("{") && raw.endsWith("}")) {
    return { name, value: { type: "expr", code: raw.slice(1, -1) } };
  }
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return { name, value: raw.slice(1, -1) };
  }
  if (raw === "true") return { name, value: true };
  if (raw === "false") return { name, value: false };
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return { name, value: Number(raw) };
  return { name, value: raw };
}

function splitShorthandParts(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      current += char;
      if (char === quote && input[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "{") braceDepth++;
    if (char === "}") braceDepth--;
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth--;
    if (char === "(") parenDepth++;
    if (char === ")") parenDepth--;

    if (char === "." && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      if (!current) fail("INVALID_ELEMENT", `Invalid element shorthand: ${input}`);
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function findTopLevelEquals(input: string): number {
  let quote: string | null = null;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote && input[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") braceDepth++;
    if (char === "}") braceDepth--;
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth--;
    if (char === "(") parenDepth++;
    if (char === ")") parenDepth--;
    if (char === "=" && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) return index;
  }

  return -1;
}

function tokenizeChainLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: { char: string; strip: boolean } | null = null;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  const push = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < line.length; index++) {
    const char = line[index];

    if (quote) {
      if (char === quote.char && line[index - 1] !== "\\") {
        if (!quote.strip) current += char;
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "#" && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0 && (current.trim() === "" || /\s/.test(line[index - 1] ?? ""))) {
      break;
    }

    if (char === "\"" || char === "'") {
      const strip = current.length === 0;
      if (!strip) current += char;
      quote = { char, strip };
      continue;
    }

    if (char === "{") braceDepth++;
    if (char === "}") braceDepth--;
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth--;
    if (char === "(") parenDepth++;
    if (char === ")") parenDepth--;

    if (/\s/.test(char) && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      push();
      continue;
    }

    current += char;
  }

  push();
  return tokens;
}
