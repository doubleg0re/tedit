import { readFileSync } from "node:fs";
import { BaseRuleDocument } from "../../core/base-rule-document.js";
import type { CommentPosition, TextMatchSpec, TextValueSpec, TreeNodeInfo, TreeNodeSpec, ValueSpec } from "../../core/document.js";
import { fail } from "../../errors.js";

export const MARKUP_ACTIONS = [
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
  "class.add",
  "class.remove",
  "class.replace",
  "insertComment",
  "text.set",
  "text.replace",
] as const;

type MarkupNode = {
  tag: string;
  attrs: Record<string, string | boolean>;
  start: number;
  end: number;
  openStart: number;
  openEnd: number;
  closeStart: number | null;
  closeEnd: number | null;
  nameStart: number;
  nameEnd: number;
  closeNameStart: number | null;
  closeNameEnd: number | null;
  selfClosing: boolean;
  parent: MarkupNode | null;
  children: MarkupNode[];
};

type Splice = { start: number; end: number; text: string };

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

export class MarkupDocument extends BaseRuleDocument<MarkupNode> {
  private current: string;
  private nodes: MarkupNode[] = [];

  constructor(filePath: string, source: string) {
    super("markup", filePath, source, MARKUP_ACTIONS);
    this.current = source;
    this.reindex();
  }

  append(target: string, spec: TreeNodeSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    const start = node.start;
    this.insertInside(node, renderMarkupSpec(spec) as string, "end");
    return this.infoAtStart(start);
  }

  prepend(target: string, spec: TreeNodeSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    const start = node.start;
    this.insertInside(node, renderMarkupSpec(spec) as string, "start");
    return this.infoAtStart(start);
  }

  wrap(target: string, wrapper: TreeNodeSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    const rendered = renderMarkupSpec(wrapper, true) as { open: string; close: string };
    this.applySplices([
      { start: node.start, end: node.start, text: rendered.open },
      { start: node.end, end: node.end, text: rendered.close },
    ]);
    return this.resolveInfo(target);
  }

  unwrap(target: string): TreeNodeInfo | null {
    const node = this.resolvePath(target);
    if (node.selfClosing || node.closeStart === null || node.closeEnd === null) {
      this.remove(target);
      return null;
    }
    this.applySplices([
      { start: node.closeStart, end: node.closeEnd, text: "" },
      { start: node.openStart, end: node.openEnd, text: "" },
    ]);
    return null;
  }

  rename(target: string, name: string): TreeNodeInfo {
    const node = this.resolvePath(target);
    const start = node.start;
    const splices: Splice[] = [{ start: node.nameStart, end: node.nameEnd, text: name }];
    if (node.closeNameStart !== null && node.closeNameEnd !== null) splices.push({ start: node.closeNameStart, end: node.closeNameEnd, text: name });
    this.applySplices(splices);
    return this.infoAtStart(start);
  }

  remove(target: string): void {
    const node = this.resolvePath(target);
    this.applySplices([{ start: node.start, end: node.end, text: "" }]);
  }

  setAttribute(target: string, name: string, value: ValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    const start = node.start;
    node.attrs[name] = markupAttrValue(value);
    this.replaceOpeningTag(node);
    return this.infoAtStart(start);
  }

  removeAttribute(target: string, name: string): TreeNodeInfo {
    const node = this.resolvePath(target);
    const start = node.start;
    delete node.attrs[name];
    this.replaceOpeningTag(node);
    return this.infoAtStart(start);
  }

  addClass(target: string, classNames: string | string[]): TreeNodeInfo {
    return this.updateClassList(target, (classes) => unique([...classes, ...normalizeClassNames(classNames)]));
  }

  removeClass(target: string, classNames: string | string[]): TreeNodeInfo {
    const remove = new Set(normalizeClassNames(classNames));
    return this.updateClassList(target, (classes) => classes.filter((name) => !remove.has(name)));
  }

  replaceClass(target: string, from: string, to: string): TreeNodeInfo {
    const fromNames = normalizeClassNames(from);
    const toNames = normalizeClassNames(to);
    if (fromNames.length !== 1) fail("INVALID_CLASS", "class.replace requires exactly one source class.");
    let replaced = false;
    const result = this.updateClassList(target, (classes) => unique(classes.flatMap((name) => {
      if (name !== fromNames[0]) return [name];
      replaced = true;
      return toNames;
    })));
    if (!replaced) fail("CLASS_NOT_FOUND", `Class "${fromNames[0]}" was not found on target.`);
    return result;
  }

  insertComment(target: string, text: string, position: CommentPosition = "inside-end"): TreeNodeInfo {
    const node = this.resolvePath(target);
    const comment = `<!-- ${text} -->`;
    if (position === "before") this.applySplices([{ start: node.start, end: node.start, text: comment }]);
    else if (position === "after") this.applySplices([{ start: node.end, end: node.end, text: comment }]);
    else this.insertInside(node, comment, position === "inside-start" ? "start" : "end");
    return this.resolveInfo(target);
  }

  setText(target: string, value: TextValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    this.replaceInner(node, markupText(value));
    return this.resolveInfo(target);
  }

  replaceText(target: string, match: TextMatchSpec, value: TextValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    const current = innerText(this.current, node);
    const expected = match.kind === "expr" ? match.code : match.value;
    if (match.kind !== "any" && current !== expected) {
      fail("TEXT_NOT_FOUND", "Selected markup text did not match the requested text.", { current, expected });
    }
    this.replaceInner(node, markupText(value));
    return this.resolveInfo(target);
  }

  print(): string {
    return this.current;
  }

  protected nodeForPath(path: MarkupNode): object {
    return path;
  }

  protected buildInfo(id: string, node: MarkupNode): TreeNodeInfo {
    return {
      id,
      kind: "element",
      name: node.tag,
      attributes: { ...node.attrs },
      props: { ...node.attrs },
      childCount: node.children.length,
      preview: this.current.slice(node.start, Math.min(node.end, node.start + 120)),
    };
  }

  protected parentPath(path: MarkupNode): MarkupNode | null {
    return path.parent;
  }

  protected siblingPaths(path: MarkupNode): MarkupNode[] {
    return path.parent?.children ?? this.nodes.filter((node) => !node.parent);
  }

  private updateClassList(target: string, update: (classes: string[]) => string[]): TreeNodeInfo {
    const node = this.resolvePath(target);
    const start = node.start;
    const next = update(splitClassNames(String(node.attrs.class ?? ""))).join(" ");
    node.attrs.class = next;
    this.replaceOpeningTag(node);
    return this.infoAtStart(start);
  }

  private infoAtStart(start: number): TreeNodeInfo {
    const node = this.nodes.find((candidate) => candidate.start === start);
    if (!node) fail("NODE_NOT_FOUND", "The edited markup node is no longer available.");
    return this.inspect(this.getNodeId(node));
  }

  private insertInside(node: MarkupNode, text: string, edge: "start" | "end"): void {
    if (node.selfClosing || node.closeStart === null) {
      this.applySplices([{ start: node.start, end: node.end, text: `${renderOpenTag(node, false)}${text}</${node.tag}>` }]);
      return;
    }
    const point = edge === "start" ? node.openEnd : node.closeStart;
    this.applySplices([{ start: point, end: point, text }]);
  }

  private replaceInner(node: MarkupNode, text: string): void {
    if (node.selfClosing || node.closeStart === null) {
      this.applySplices([{ start: node.start, end: node.end, text: `${renderOpenTag(node, false)}${text}</${node.tag}>` }]);
      return;
    }
    this.applySplices([{ start: node.openEnd, end: node.closeStart, text }]);
  }

  private replaceOpeningTag(node: MarkupNode): void {
    this.applySplices([{ start: node.openStart, end: node.openEnd, text: renderOpenTag(node, node.selfClosing) }]);
  }

  private applySplices(splices: Splice[]): void {
    for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
      this.current = this.current.slice(0, splice.start) + splice.text + this.current.slice(splice.end);
    }
    this.reindex();
  }

  private reindex(): void {
    this.nodes = parseMarkup(this.current);
    this.reindexPaths(this.nodes);
  }
}

export function openMarkupDocument(filePath: string): MarkupDocument {
  return new MarkupDocument(filePath, readFileSync(filePath, "utf8"));
}

export function parseMarkupDocument(filePath: string, source: string): MarkupDocument {
  return new MarkupDocument(filePath, source);
}

function parseMarkup(source: string): MarkupNode[] {
  const roots: MarkupNode[] = [];
  const stack: MarkupNode[] = [];
  const tagPattern = /<!--[^]*?-->|<[^!/?][^>]*>|<\/[^>]+>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(source))) {
    const raw = match[0];
    if (raw.startsWith("<!--")) continue;
    if (raw.startsWith("</")) {
      const closeName = raw.slice(2, -1).trim().split(/\s+/)[0];
      const node = stack.pop();
      if (!node || node.tag !== closeName) fail("INVALID_MARKUP", `Unexpected closing tag </${closeName}>.`);
      node.closeStart = match.index;
      node.closeEnd = match.index + raw.length;
      node.closeNameStart = match.index + 2;
      node.closeNameEnd = node.closeNameStart + closeName.length;
      node.end = node.closeEnd;
      continue;
    }

    const parsed = parseOpeningTag(raw, match.index);
    const parent = stack[stack.length - 1] ?? null;
    const node: MarkupNode = { ...parsed, parent, children: [] };
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (!node.selfClosing) stack.push(node);
  }

  if (stack.length > 0) fail("INVALID_MARKUP", `Unclosed tag <${stack[stack.length - 1].tag}>.`);
  return flattenMarkupNodes(roots);
}

function parseOpeningTag(raw: string, start: number): Omit<MarkupNode, "parent" | "children"> {
  const match = raw.match(/^<\s*([A-Za-z][\w:.-]*)/);
  if (!match) fail("INVALID_MARKUP", `Invalid opening tag: ${raw}`);
  const tag = match[1];
  const selfClosing = /\/\s*>$/.test(raw) || VOID_TAGS.has(tag.toLowerCase());
  const nameStart = start + raw.indexOf(tag);
  const attrsSource = raw.slice(raw.indexOf(tag) + tag.length, raw.length - (selfClosing && /\/\s*>$/.test(raw) ? 2 : 1));
  const attrs = parseAttributes(attrsSource);
  const openEnd = start + raw.length;
  return {
    tag,
    attrs,
    start,
    end: selfClosing ? openEnd : openEnd,
    openStart: start,
    openEnd,
    closeStart: null,
    closeEnd: null,
    nameStart,
    nameEnd: nameStart + tag.length,
    closeNameStart: null,
    closeNameEnd: null,
    selfClosing,
  };
}

function parseAttributes(source: string): Record<string, string | boolean> {
  const attrs: Record<string, string | boolean> = {};
  const pattern = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    attrs[match[1]] = match[3] ?? match[4] ?? match[5] ?? true;
  }
  return attrs;
}

function flattenMarkupNodes(nodes: MarkupNode[]): MarkupNode[] {
  return nodes.flatMap((node) => [node, ...flattenMarkupNodes(node.children)]);
}

function renderOpenTag(node: Pick<MarkupNode, "tag" | "attrs">, selfClosing: boolean): string {
  const attrs = Object.entries(node.attrs).map(([name, value]) => value === true ? name : `${name}=${JSON.stringify(String(value))}`).join(" ");
  return `<${node.tag}${attrs ? ` ${attrs}` : ""}${selfClosing ? " />" : ">"}`;
}

function renderMarkupSpec(spec: TreeNodeSpec, split = false): string | { open: string; close: string } {
  const tag = spec.tag ?? spec.name ?? "div";
  const attrs = attrsFromSpec(spec);
  const children = spec.text ?? spec.comment ?? (spec.children ?? []).map((child) => renderMarkupSpec(child)).join("");
  const open = renderOpenTag({ tag, attrs }, false);
  const close = `</${tag}>`;
  return split ? { open, close } : `${open}${children}</${tag}>`;
}

function attrsFromSpec(spec: TreeNodeSpec): Record<string, string | boolean> {
  const raw = spec.attrs ?? spec.attributes ?? spec.props ?? {};
  const attrs: Record<string, string | boolean> = {};
  for (const [name, value] of Object.entries(raw)) attrs[name] = markupAttrValue(value);
  return attrs;
}

function markupAttrValue(value: ValueSpec): string | boolean {
  if (value && typeof value === "object" && !Array.isArray(value) && "type" in value) {
    if (value.type === "boolean") return value.value;
    if (value.type === "string") return value.value;
    if (value.type === "expr") return value.code;
    fail("INVALID_MARKUP_VALUE", "Markup attributes do not support spread values.");
  }
  if (value === null) return "";
  if (typeof value === "boolean") return value;
  return String(value);
}

function markupText(value: TextValueSpec): string {
  return value.kind === "expr" ? value.code : value.value;
}

function innerText(source: string, node: MarkupNode): string {
  if (node.selfClosing || node.closeStart === null) return "";
  return source.slice(node.openEnd, node.closeStart).replace(/<[^>]+>/g, "");
}

function normalizeClassNames(value: string | string[]): string[] {
  const names = Array.isArray(value) ? value.flatMap(splitClassNames) : splitClassNames(value);
  if (names.length === 0) fail("INVALID_CLASS", "class action requires at least one class name.");
  return names;
}

function splitClassNames(value: string): string[] {
  return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
