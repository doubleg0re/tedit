import type { TreeNodeInfo } from "./document.js";
import { fail } from "../errors.js";

export type SelectorCombinator = "descendant" | "child" | "adjacent" | "sibling";

export type AttrSelector = {
  name: string;
  op: "exists" | "eq" | "contains" | "starts" | "ends" | "word" | "dash" | "class";
  value?: string;
};

export type PseudoSelector =
  | { kind: "scope" }
  | { kind: "expr" }
  | { kind: "first-child" }
  | { kind: "last-child" }
  | { kind: "nth-of-type"; index: number }
  | { kind: "has"; selector: ParsedSelector }
  | { kind: "not"; selector: ParsedSelector };

export type SimpleSelector = {
  tag?: string;
  attrs: AttrSelector[];
  pseudos: PseudoSelector[];
};

export type SelectorPart = {
  combinator?: SelectorCombinator;
  selector: SimpleSelector;
};

export type ParsedSelector = {
  parts: SelectorPart[];
};

const SUPPORTED_PSEUDOS = [":scope", ":expr", ":first-child", ":last-child", ":nth-of-type(n)", ":has(...)", ":not(...)"];

export function parseSelector(input: string): ParsedSelector {
  const parts = splitSelector(input.trim()).map(({ combinator, text }) => ({
    ...(combinator ? { combinator } : {}),
    selector: parseSimpleSelector(text),
  }));

  if (parts.length === 0) fail("INVALID_SELECTOR", "Selector cannot be empty.");
  return { parts };
}

export function matchesSimpleSelector(info: TreeNodeInfo, selector: SimpleSelector): boolean {
  if (selector.tag && info.name !== selector.tag) return false;

  for (const attr of selector.attrs) {
    if (attr.op === "class") {
      const classValue = propToComparableString(info.attributes.className) ?? propToComparableString(info.attributes.class);
      if (!classValue || !classValue.split(/\s+/).includes(attr.value ?? "")) return false;
      continue;
    }

    const prop = info.attributes[attr.name];
    if (attr.op === "exists") {
      if (prop === undefined) return false;
      continue;
    }

    const value = propToComparableString(prop);
    if (value === undefined) return false;

    if (attr.op === "eq" && value !== attr.value) return false;
    if (attr.op === "contains" && !value.includes(attr.value ?? "")) return false;
    if (attr.op === "starts" && !value.startsWith(attr.value ?? "")) return false;
    if (attr.op === "ends" && !value.endsWith(attr.value ?? "")) return false;
    if (attr.op === "word" && !value.split(/\s+/).includes(attr.value ?? "")) return false;
    if (attr.op === "dash" && value !== attr.value && !value.startsWith((attr.value ?? "") + "-")) return false;
  }

  for (const pseudo of selector.pseudos) {
    if (pseudo.kind === "expr" && info.kind !== "expression") return false;
  }

  return true;
}

export function selectorHasScope(selector: SimpleSelector): boolean {
  return selector.pseudos.some((pseudo) => pseudo.kind === "scope");
}

function parseSimpleSelector(input: string): SimpleSelector {
  const selector = input.trim();
  if (!selector) fail("INVALID_SELECTOR", "Selector cannot be empty.");

  const tagResult = readTag(selector);
  const tag = tagResult.tag === "*" ? undefined : tagResult.tag;
  let rest = tagResult.rest;
  const attrs: AttrSelector[] = [];
  const pseudos: PseudoSelector[] = [];

  while (rest.length > 0) {
    if (rest.startsWith("#")) {
      const id = readCssName(rest, 1, "id", input);
      attrs.push({ name: "id", op: "eq", value: id.value });
      rest = rest.slice(id.end);
      continue;
    }

    if (rest.startsWith(".")) {
      const className = readCssName(rest, 1, "class", input);
      attrs.push({ name: "className", op: "class", value: className.value });
      rest = rest.slice(className.end);
      continue;
    }

    if (rest.startsWith("[")) {
      const attr = readBalanced(rest, 0, "[", "]");
      const match = attr.inner.match(/^([A-Za-z_$][\w:-]*)(?:(\*|\^|\$|~|\|)?=(?:(["'])(.*?)\3|([^\s"']+)))?$/);
      if (!match) fail("UNSUPPORTED_SELECTOR", `Unsupported attribute selector: [${attr.inner}]`);

      const [, rawName, rawOperator, , quotedValue, unquotedValue] = match;
      const value = quotedValue ?? unquotedValue;
      attrs.push({
        name: normalizeAttrName(rawName),
        op: value === undefined ? "exists" : attrOperatorToOp(rawOperator),
        ...(value === undefined ? {} : { value }),
      });
      rest = rest.slice(attr.end + 1);
      continue;
    }

    if (rest.startsWith(":scope")) {
      pseudos.push({ kind: "scope" });
      rest = rest.slice(":scope".length);
      continue;
    }

    if (rest.startsWith(":expr")) {
      pseudos.push({ kind: "expr" });
      rest = rest.slice(":expr".length);
      continue;
    }

    if (rest.startsWith(":first-child")) {
      pseudos.push({ kind: "first-child" });
      rest = rest.slice(":first-child".length);
      continue;
    }

    if (rest.startsWith(":last-child")) {
      pseudos.push({ kind: "last-child" });
      rest = rest.slice(":last-child".length);
      continue;
    }

    if (rest.startsWith(":nth-of-type")) {
      const open = rest.indexOf("(");
      if (open < 0) fail("INVALID_SELECTOR", `Invalid :nth-of-type selector: ${input}`);
      const arg = readBalanced(rest, open, "(", ")");
      const index = Number(arg.inner.trim());
      if (!Number.isInteger(index) || index < 1) fail("INVALID_SELECTOR", `:nth-of-type requires a positive integer: ${input}`);
      pseudos.push({ kind: "nth-of-type", index });
      rest = rest.slice(arg.end + 1);
      continue;
    }

    if (rest.startsWith(":has")) {
      const open = rest.indexOf("(");
      if (open < 0) fail("INVALID_SELECTOR", `Invalid :has selector: ${input}`);
      const arg = readBalanced(rest, open, "(", ")");
      pseudos.push({ kind: "has", selector: parseSelector(arg.inner) });
      rest = rest.slice(arg.end + 1);
      continue;
    }

    if (rest.startsWith(":not")) {
      const open = rest.indexOf("(");
      if (open < 0) fail("INVALID_SELECTOR", `Invalid :not selector: ${input}`);
      const arg = readBalanced(rest, open, "(", ")");
      pseudos.push({ kind: "not", selector: parseSelector(arg.inner) });
      rest = rest.slice(arg.end + 1);
      continue;
    }

    if (rest.startsWith("::")) {
      const match = rest.match(/^::([A-Za-z-]+)/);
      const name = match?.[1] ?? rest.slice(2);
      fail("UNSUPPORTED_SELECTOR", `Unsupported pseudo-element ::${name}. JSX selectors do not support CSS pseudo-elements.`);
    }

    if (rest.startsWith(":")) {
      const match = rest.match(/^:([A-Za-z-]+)/);
      const name = match?.[1] ?? rest.slice(1);
      fail("UNSUPPORTED_SELECTOR", `Unsupported pseudo-class :${name}. Supported pseudos: ${SUPPORTED_PSEUDOS.join(", ")}.`);
    }

    fail("UNSUPPORTED_SELECTOR", `Unsupported selector syntax: ${input}`);
  }

  return { tag, attrs, pseudos };
}

function readTag(input: string): { tag?: string; rest: string } {
  if (input.startsWith("*")) return { tag: "*", rest: input.slice(1) };
  if (!isTagStart(input[0])) return { rest: input };

  const first = readTagSegment(input, 0);
  if (!first) fail("INVALID_SELECTOR", `Invalid selector tag: ${input}`);
  let tag = first.value;
  let cursor = first.end;

  while (input[cursor] === ".") {
    const next = readTagSegment(input, cursor + 1, true);
    if (!next || !isMemberTagSegment(tag, next.value)) break;
    tag = `${tag}.${next.value}`;
    cursor = next.end;
  }

  return { tag, rest: input.slice(cursor) };
}

function readTagSegment(input: string, start: number, optional = false): { value: string; end: number } | null {
  if (!isTagStart(input[start])) {
    if (optional) return null;
    fail("INVALID_SELECTOR", `Invalid selector tag: ${input}`);
  }
  let end = start + 1;
  while (end < input.length && /[\w$-]/.test(input[end])) end++;
  return { value: input.slice(start, end), end };
}

function isMemberTagSegment(currentTag: string, segment: string): boolean {
  const first = currentTag.split(".")[0] ?? "";
  return isComponentLikeName(first) && isComponentLikeName(segment);
}

function isComponentLikeName(value: string): boolean {
  return /^[A-Z_$]/.test(value);
}

function isTagStart(char: string | undefined): boolean {
  return !!char && /[A-Za-z_$]/.test(char);
}

function readCssName(input: string, start: number, label: string, source: string): { value: string; end: number } {
  if (!/[A-Za-z_-]/.test(input[start] ?? "")) fail("INVALID_SELECTOR", `Invalid ${label} selector: ${source}`);
  let end = start + 1;
  while (end < input.length && /[\w-]/.test(input[end])) end++;
  return { value: input.slice(start, end), end };
}

function normalizeAttrName(name: string): string {
  return name === "class" ? "className" : name;
}

function attrOperatorToOp(operator: string | undefined): AttrSelector["op"] {
  if (operator === "*") return "contains";
  if (operator === "^") return "starts";
  if (operator === "$") return "ends";
  if (operator === "~") return "word";
  if (operator === "|") return "dash";
  return "eq";
}

function splitSelector(input: string): Array<{ combinator?: SelectorCombinator; text: string }> {
  if (!input) fail("INVALID_SELECTOR", "Selector cannot be empty.");

  const parts: Array<{ combinator?: SelectorCombinator; text: string }> = [];
  let current = "";
  let nextCombinator: SelectorCombinator | undefined;
  let quote: string | null = null;
  let squareDepth = 0;
  let parenDepth = 0;

  const push = (): void => {
    const text = current.trim();
    if (!text) return;
    parts.push({ ...(nextCombinator ? { combinator: nextCombinator } : {}), text });
    current = "";
    nextCombinator = "descendant";
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      current += char;
      if (char === quote && input[i - 1] !== "\\") quote = null;
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "[") squareDepth++;
    if (char === "]") squareDepth--;
    if (char === "(") parenDepth++;
    if (char === ")") parenDepth--;

    if (squareDepth === 0 && parenDepth === 0 && (char === ">" || char === "+" || char === "~")) {
      push();
      nextCombinator = combinatorForToken(char);
      continue;
    }

    if (squareDepth === 0 && parenDepth === 0 && /\s/.test(char)) {
      push();
      while (i + 1 < input.length && /\s/.test(input[i + 1])) i++;
      continue;
    }

    current += char;
  }

  push();
  return parts;
}

function combinatorForToken(char: string): SelectorCombinator {
  if (char === ">") return "child";
  if (char === "+") return "adjacent";
  if (char === "~") return "sibling";
  fail("INVALID_SELECTOR", `Unsupported combinator: ${char}`);
}

function readBalanced(input: string, start: number, open: string, close: string): { inner: string; end: number } {
  if (input[start] !== open) fail("INVALID_SELECTOR", `Expected "${open}" in selector.`);

  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === open) depth++;
    if (char === close) {
      depth--;
      if (depth === 0) return { inner: input.slice(start + 1, i), end: i };
    }
  }

  fail("INVALID_SELECTOR", `Unbalanced selector: ${input}`);
}

function propToComparableString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && "value" in value) {
    const raw = (value as { value?: unknown }).value;
    return typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? String(raw) : undefined;
  }
  return undefined;
}
