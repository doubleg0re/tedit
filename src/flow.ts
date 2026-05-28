import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommentPosition, ImportEditSpec, StructuredDocument, TextMatchSpec, TextValueSpec, TreeNodeSpec, ValueSpec } from "./core/document.js";
import { fail } from "./errors.js";

export type FlowRoot = FlowStep[] | { info?: FlowInfo; flow: FlowStep[] };

export type FlowInfo = {
  name?: string;
  parameters?: string[];
};

export type FlowStep = {
  action?: string;
  args?: unknown[] | Record<string, unknown>;
  out?: string;
  comment?: string;
  selector?: string;
  target?: string;
  element?: TreeNodeSpec;
  with?: TreeNodeSpec | TextValueSpec | string;
  name?: string;
  value?: unknown;
  text?: string;
  expr?: string;
  match?: TextMatchSpec;
  code?: string;
  ref?: string;
  position?: CommentPosition;
  from?: string;
  to?: string;
  named?: string | string[];
  default?: string;
  namespace?: string;
  items?: Record<string, { ref?: string; value?: unknown }>;
  all?: boolean;
};

export type FlowResult = {
  success: true;
  results: Array<{ step: number; action: string; success: true; data?: unknown }>;
  vars: Record<string, unknown>;
};

const KNOWN_ACTIONS = new Set([
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
  "set",
]);

export function parseFlowInput(input: string): { info?: FlowInfo; flow: FlowStep[] } {
  const raw = loadJsonOrFile(input);
  if (Array.isArray(raw)) return { flow: raw as FlowStep[] };
  if (raw && typeof raw === "object" && Array.isArray((raw as { flow?: unknown }).flow)) {
    return raw as { info?: FlowInfo; flow: FlowStep[] };
  }
  if (raw && typeof raw === "object" && "action" in raw) {
    return { flow: [raw as FlowStep] };
  }
  fail("INVALID_FLOW", "Flow must be an array of steps, an object with { flow }, or a single step object.");
}

export function validateFlow(steps: FlowStep[]): string[] {
  const errors: string[] = [];

  steps.forEach((step, index) => {
    const loc = `Step ${index}`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      errors.push(`${loc}: step must be an object`);
      return;
    }

    if (!step.action && step.comment) return;
    if (!step.action && !step.comment) {
      errors.push(`${loc}: step has no action or comment`);
      return;
    }
    if (step.action && step.comment) {
      errors.push(`${loc}: step cannot have both "comment" and "action"`);
    }
    if (step.action && !KNOWN_ACTIONS.has(step.action)) {
      errors.push(`${loc}: unknown action "${step.action}"`);
    }
    if (step.out && step.out.startsWith("$")) {
      errors.push(`${loc}: "out" cannot start with "$"`);
    }

    if (step.action === "find" && !step.selector) errors.push(`${loc}: find requires "selector"`);
    if (["append", "prepend"].includes(step.action ?? "") && (!step.target || !step.element)) {
      errors.push(`${loc}: ${step.action} requires "target" and "element"`);
    }
    if (step.action === "wrap" && (!step.target || !step.with)) errors.push(`${loc}: wrap requires "target" and "with"`);
    if (["unwrap", "remove", "inspect"].includes(step.action ?? "") && !step.target) {
      errors.push(`${loc}: ${step.action} requires "target"`);
    }
    if (step.action === "rename" && (!step.target || !step.name)) errors.push(`${loc}: rename requires "target" and "name"`);
    if (step.action === "prop.set" && (!step.target || !step.name || step.value === undefined)) {
      errors.push(`${loc}: prop.set requires "target", "name", and "value"`);
    }
    if (step.action === "prop.remove" && (!step.target || !step.name)) {
      errors.push(`${loc}: prop.remove requires "target" and "name"`);
    }
    if (step.action === "insertComment" && (!step.target || !step.text)) {
      errors.push(`${loc}: insertComment requires "target" and "text"`);
    }
    if (step.action === "text.set" && (!step.target || (step.value === undefined && !step.expr) || (step.value !== undefined && !!step.expr))) {
      errors.push(`${loc}: text.set requires "target" and "value" or "expr"`);
    }
    if (step.action === "text.replace" && (!step.target || !step.match || !step.with)) {
      errors.push(`${loc}: text.replace requires "target", "match", and "with"`);
    }
    if (step.action === "imports.add" && !step.from) errors.push(`${loc}: imports.add requires "from"`);
    if (step.action === "imports.remove" && !step.from) errors.push(`${loc}: imports.remove requires "from"`);
    if (step.action === "imports.rename" && (!step.from || !step.name || !step.to)) {
      errors.push(`${loc}: imports.rename requires "from", "name", and "to"`);
    }
    if (step.action === "imports.move" && (!step.from || !step.to)) {
      errors.push(`${loc}: imports.move requires "from" and "to"`);
    }
    if (step.action === "expr.replace" && (!step.target || !step.code)) {
      errors.push(`${loc}: expr.replace requires "target" and "code"`);
    }
    if (step.action === "expr.wrap" && (!step.target || !step.code)) {
      errors.push(`${loc}: expr.wrap requires "target" and "code"`);
    }
    if (["expr.unwrap", "expr.toTernary", "expr.toShortCircuit"].includes(step.action ?? "") && !step.target) {
      errors.push(`${loc}: ${step.action} requires "target"`);
    }
  });

  return errors;
}

export function runFlow(doc: StructuredDocument, steps: FlowStep[], params: Record<string, unknown> = {}): FlowResult {
  const validationErrors = validateFlow(steps);
  if (validationErrors.length > 0) fail("INVALID_FLOW", "Flow validation failed.", validationErrors);

  const vars = new VarStore(params);
  const results: FlowResult["results"] = [];

  steps.forEach((step, index) => {
    if (!step.action) return;

    const data = runStep(doc, vars, step);
    if (step.out) vars.set(step.out, data);
    vars.set("$ret", data);
    results.push({ step: index, action: step.action, success: true, ...(data === undefined ? {} : { data }) });
  });

  return { success: true, results, vars: vars.snapshot() };
}

export function loadParams(input?: string): Record<string, unknown> {
  if (!input) return {};
  const data = loadJsonOrFile(input);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail("INVALID_PARAMS", "--params must be a JSON object or a path to a JSON object.");
  }
  return data as Record<string, unknown>;
}

function runStep(doc: StructuredDocument, vars: VarStore, step: FlowStep): unknown {
  switch (step.action) {
    case "find": {
      const matches = doc.find(String(vars.resolveValue(step.selector)));
      if (matches.length === 0) fail("NODE_NOT_FOUND", `No JSX node matched "${step.selector}".`);
      return step.all ? matches : matches[0].id;
    }

    case "inspect":
      return doc.inspect(resolveTarget(vars, step.target));

    case "append":
      return doc.append(resolveTarget(vars, step.target), vars.resolveValue(step.element) as TreeNodeSpec);

    case "prepend":
      return doc.prepend(resolveTarget(vars, step.target), vars.resolveValue(step.element) as TreeNodeSpec);

    case "wrap":
      return doc.wrap(resolveTarget(vars, step.target), normalizeWrapper(vars.resolveValue(step.with)));

    case "unwrap":
      return doc.unwrap(resolveTarget(vars, step.target));

    case "rename":
      return doc.rename(resolveTarget(vars, step.target), String(vars.resolveValue(step.name)));

    case "remove":
      doc.remove(resolveTarget(vars, step.target));
      return { removed: true };

    case "prop.set":
      return doc.setAttribute(
        resolveTarget(vars, step.target),
        String(vars.resolveValue(step.name)),
        vars.resolveValue(step.value) as ValueSpec,
      );

    case "prop.remove":
      return doc.removeAttribute(resolveTarget(vars, step.target), String(vars.resolveValue(step.name)));

    case "insertComment":
      return doc.insertComment(
        resolveTarget(vars, step.target),
        String(vars.resolveValue(step.text)),
        step.position,
      );

    case "text.set":
      return doc.setText(resolveTarget(vars, step.target), resolveTextValue(vars, step));

    case "text.replace":
      return doc.replaceText(
        resolveTarget(vars, step.target),
        vars.resolveValue(step.match) as TextMatchSpec,
        normalizeTextValue(vars.resolveValue(step.with)),
      );

    case "imports.add":
      return doc.addImport(resolveImportSpec(vars, step));

    case "imports.remove":
      return doc.removeImport(resolveImportSpec(vars, step));

    case "imports.rename":
      return doc.renameImport(resolveImportSpec(vars, step));

    case "imports.move":
      return doc.moveImport(resolveImportSpec(vars, step));

    case "expr.replace":
      return doc.replaceExpression(resolveTarget(vars, step.target), String(vars.resolveValue(step.code)));

    case "expr.wrap":
      return doc.wrapExpression(resolveTarget(vars, step.target), String(vars.resolveValue(step.code)));

    case "expr.unwrap":
      return doc.unwrapExpression(resolveTarget(vars, step.target));

    case "expr.toTernary":
      return doc.toTernaryExpression(
        resolveTarget(vars, step.target),
        step.value === undefined ? undefined : String(vars.resolveValue(step.value)),
      );

    case "expr.toShortCircuit":
      return doc.toShortCircuitExpression(resolveTarget(vars, step.target));

    case "log":
      if (step.ref) return vars.get(String(vars.resolveValue(step.ref)));
      if (step.text) return vars.resolveValue(step.text);
      return vars.snapshot();

    case "set": {
      const data: Record<string, unknown> = {};
      for (const [name, source] of Object.entries(step.items ?? {})) {
        if (name.startsWith("$")) fail("INVALID_FLOW", `set destination "${name}" cannot start with "$".`);
        const hasRef = source && "ref" in source;
        const hasValue = source && "value" in source;
        if (hasRef === hasValue) fail("INVALID_FLOW", `set item "${name}" must contain exactly one of "ref" or "value".`);
        const value = hasRef ? vars.get(String(vars.resolveValue(source.ref))) : vars.resolveValue(source.value);
        vars.set(name, value);
        data[name] = value;
      }
      return data;
    }

    default:
      fail("UNKNOWN_ACTION", `Unknown action: ${step.action}`);
  }
}

function resolveImportSpec(vars: VarStore, step: FlowStep): ImportEditSpec {
  return {
    from: String(vars.resolveValue(step.from)),
    ...(step.to ? { to: String(vars.resolveValue(step.to)) } : {}),
    ...(step.named ? { named: vars.resolveValue(step.named) as string | string[] } : {}),
    ...(step.default ? { default: String(vars.resolveValue(step.default)) } : {}),
    ...(step.namespace ? { namespace: String(vars.resolveValue(step.namespace)) } : {}),
    ...(step.name ? { name: String(vars.resolveValue(step.name)) } : {}),
    ...(step.value !== undefined ? { value: vars.resolveValue(step.value) } : {}),
  };
}

function resolveTarget(vars: VarStore, value: unknown): string {
  const resolved = vars.resolveValue(value);
  if (resolved && typeof resolved === "object" && "id" in resolved && typeof resolved.id === "string") {
    return resolved.id;
  }
  return String(resolved);
}

function normalizeWrapper(value: unknown): TreeNodeSpec {
  if (typeof value === "string") return { tag: value };
  if (value && typeof value === "object") return value as TreeNodeSpec;
  fail("INVALID_ELEMENT", "wrap `with` must be a tag string or element spec.");
}

function resolveTextValue(vars: VarStore, step: FlowStep): TextValueSpec {
  const hasValue = step.value !== undefined;
  const hasExpr = step.expr !== undefined;
  if (hasValue === hasExpr) fail("INVALID_TEXT", "text.set requires exactly one of value or expr.");
  if (hasExpr) return { kind: "expr", code: String(vars.resolveValue(step.expr)) };
  return { kind: "text", value: String(vars.resolveValue(step.value)) };
}

function normalizeTextValue(value: unknown): TextValueSpec {
  if (typeof value === "string") return { kind: "text", value };
  if (value && typeof value === "object") {
    const spec = value as Partial<TextValueSpec>;
    if (spec.kind === "text" && typeof spec.value === "string") return { kind: "text", value: spec.value };
    if (spec.kind === "expr" && typeof spec.code === "string") return { kind: "expr", code: spec.code };
  }
  fail("INVALID_TEXT", "text value must be a string, { kind: \"text\", value }, or { kind: \"expr\", code }.");
}

function loadJsonOrFile(input: string): unknown {
  const candidate = resolve(input);
  const raw = existsSync(candidate) ? readFileSync(candidate, "utf8") : input;
  try {
    return JSON.parse(raw);
  } catch {
    fail("INVALID_JSON", `Invalid JSON or file not found: ${input}`);
  }
}

class VarStore {
  private vars: Record<string, unknown>;

  constructor(initial: Record<string, unknown>) {
    this.vars = { ...initial };
  }

  set(name: string, value: unknown): void {
    this.vars[name] = value;
  }

  get(path: string): unknown {
    const parts = path.split(".");
    let current: unknown = this.vars;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return undefined;
      if (Array.isArray(current) && /^\d+$/.test(part)) {
        current = current[Number(part)];
      } else {
        current = (current as Record<string, unknown>)[part];
      }
    }
    return current;
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
