import { readFileSync } from "node:fs";
import { BaseRuleDocument } from "../../core/base-rule-document.js";
import type { TextMatchSpec, TextValueSpec, TreeNodeInfo, TreeNodeSpec, ValueSpec } from "../../core/document.js";
import { fail } from "../../errors.js";

export const MARKDOWN_ACTIONS = [
  "find",
  "inspect",
  "append",
  "prepend",
  "rename",
  "remove",
  "prop.set",
  "prop.remove",
  "text.set",
  "text.replace",
] as const;

type MarkdownKind = "root" | "frontmatter" | "frontmatter-entry" | "heading" | "paragraph" | "list-item" | "code";

type MarkdownNode = {
  path: string;
  kind: MarkdownKind;
  name: string;
  line: number;
  endLine: number;
  parent: MarkdownNode | null;
  children: MarkdownNode[];
  attrs: Record<string, unknown>;
};

export class MarkdownDocument extends BaseRuleDocument<MarkdownNode> {
  private lines: string[];
  private readonly trailingNewline: boolean;
  private nodesByPath = new Map<string, MarkdownNode>();

  constructor(filePath: string, source: string) {
    super("markdown", filePath, source, MARKDOWN_ACTIONS);
    this.trailingNewline = source.endsWith("\n");
    this.lines = source.replace(/\r\n/g, "\n").split("\n");
    if (this.trailingNewline) this.lines.pop();
    this.reindex();
  }

  append(target: string, spec: TreeNodeSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    const block = blockFromSpec(spec);
    const insertion = node.kind === "heading" ? headingAppendInsertion(node) : node.kind === "root" ? this.lines.length : node.endLine + 1;
    this.lines.splice(insertion, 0, ...withBlockSeparation(this.lines, insertion, block));
    this.reindex();
    return this.inspect(this.getNodeId(this.resolvePath(target)));
  }

  prepend(target: string, spec: TreeNodeSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    const block = blockFromSpec(spec);
    const insertion = node.kind === "heading" ? node.line + 1 : node.kind === "root" ? 0 : node.line;
    this.lines.splice(insertion, 0, ...withBlockSeparation(this.lines, insertion, block));
    this.reindex();
    return this.inspect(this.getNodeId(this.resolvePath(target)));
  }

  rename(target: string, name: string): TreeNodeInfo {
    const node = this.resolvePath(target);
    if (node.kind !== "heading") return this.unsupported("rename");
    this.lines[node.line] = `${"#".repeat(Number(node.attrs.level ?? 1))} ${name}`;
    return this.reindexAndResolve(node.path);
  }

  remove(target: string): void {
    const node = this.resolvePath(target);
    if (node.kind === "root") fail("MARKDOWN_ROOT_REMOVE", "Cannot remove the Markdown root node.");
    this.lines.splice(node.line, node.endLine - node.line + 1);
    this.trimAdjacentBlankLines(node.line);
    this.reindex();
  }

  setAttribute(target: string, name: string, value: ValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    if (node.kind !== "frontmatter") return this.unsupported("prop.set");
    const scalar = markdownFrontmatterScalar(value);
    const existing = node.children.find((child) => child.kind === "frontmatter-entry" && child.attrs.key === name);
    if (existing) {
      this.lines[existing.line] = `${name}: ${scalar}`;
      return this.reindexAndResolve(existing.path);
    }
    this.lines.splice(node.endLine, 0, `${name}: ${scalar}`);
    this.reindex();
    return this.inspect(name);
  }

  removeAttribute(target: string, name: string): TreeNodeInfo {
    const node = this.resolvePath(target);
    if (node.kind !== "frontmatter") return this.unsupported("prop.remove");
    const existing = node.children.find((child) => child.kind === "frontmatter-entry" && child.attrs.key === name);
    if (!existing) return this.inspect(this.getNodeId(node));
    this.lines.splice(existing.line, 1);
    this.reindex();
    return this.inspect(this.getNodeId(this.resolvePath(target)));
  }

  setText(target: string, value: TextValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    this.replaceNodeText(node, markdownText(value));
    return this.reindexAndResolve(node.path);
  }

  replaceText(target: string, match: TextMatchSpec, value: TextValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    const current = nodeText(this.lines, node);
    const expected = match.kind === "expr" ? match.code : match.value;
    if (match.kind !== "any" && current !== expected) {
      fail("TEXT_NOT_FOUND", "Selected Markdown block did not match the requested text.", { path: node.path, current, expected });
    }
    this.replaceNodeText(node, markdownText(value));
    return this.reindexAndResolve(node.path);
  }

  print(): string {
    return this.lines.join("\n") + (this.trailingNewline ? "\n" : "");
  }

  protected nodeForPath(path: MarkdownNode): object {
    return path;
  }

  protected buildInfo(id: string, node: MarkdownNode): TreeNodeInfo {
    return {
      id,
      kind: node.kind,
      name: node.name,
      loc: node.line >= 0 ? { start: { line: node.line + 1, column: 1 }, end: { line: node.endLine + 1, column: 1 } } : undefined,
      attributes: { path: node.path, ...node.attrs },
      props: { path: node.path, ...node.attrs },
      childCount: node.children.length,
      preview: node.line >= 0 ? this.lines.slice(node.line, node.endLine + 1).join("\n") : "root",
    };
  }

  protected parentPath(path: MarkdownNode): MarkdownNode | null {
    return path.parent;
  }

  protected siblingPaths(path: MarkdownNode): MarkdownNode[] {
    return path.parent?.children ?? [];
  }

  private replaceNodeText(node: MarkdownNode, text: string): void {
    if (node.kind === "root" || node.kind === "frontmatter") fail("UNSUPPORTED_MARKDOWN_TEXT", `Cannot set text on ${node.kind}.`);
    const parts = text.split("\n");
    if (node.kind === "heading") {
      this.lines[node.line] = `${"#".repeat(Number(node.attrs.level ?? 1))} ${text}`;
    } else if (node.kind === "frontmatter-entry") {
      this.lines[node.line] = `${String(node.attrs.key)}: ${text}`;
    } else if (node.kind === "list-item") {
      const prefix = String(node.attrs.marker ?? "-");
      this.lines.splice(node.line, node.endLine - node.line + 1, `${prefix} ${text}`);
    } else if (node.kind === "code") {
      this.lines.splice(node.line + 1, Math.max(0, node.endLine - node.line - 1), ...parts);
    } else {
      this.lines.splice(node.line, node.endLine - node.line + 1, ...parts);
    }
  }

  private reindexAndResolve(path: string): TreeNodeInfo {
    this.reindex();
    const next = this.nodesByPath.get(path);
    if (!next) fail("NODE_NOT_FOUND", `Markdown path ${path} is no longer available.`);
    return this.inspect(this.getNodeId(next));
  }

  private trimAdjacentBlankLines(index: number): void {
    while (index > 0 && index < this.lines.length && this.lines[index] === "" && this.lines[index - 1] === "") {
      this.lines.splice(index, 1);
    }
  }

  private reindex(): void {
    const root = parseMarkdownLines(this.lines);
    const nodes = flattenMarkdownNodes(root);
    this.nodesByPath = new Map(nodes.map((node) => [node.path, node]));
    this.reindexPaths(nodes);
  }
}

export function openMarkdownDocument(filePath: string): MarkdownDocument {
  return new MarkdownDocument(filePath, readFileSync(filePath, "utf8"));
}

export function parseMarkdownDocument(filePath: string, source: string): MarkdownDocument {
  return new MarkdownDocument(filePath, source);
}

function parseMarkdownLines(lines: string[]): MarkdownNode {
  const root = markdownNode("$", "root", "root", -1, Math.max(lines.length - 1, -1), null, {});
  let index = parseFrontmatter(lines, root);
  const headingStack: MarkdownNode[] = [root];
  const counters = new Map<string, number>();
  const headings: MarkdownNode[] = [];

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      while (headingStack.length > 1 && Number(headingStack[headingStack.length - 1].attrs.level) >= level) headingStack.pop();
      const parent = headingStack[headingStack.length - 1] ?? root;
      const path = `${parent.path}/h${level}-${nextCounter(counters, `${parent.path}:h${level}`)}`;
      const node = markdownNode(path, "heading", "heading", index, index, parent, { level, text: heading[2] });
      parent.children.push(node);
      headingStack.push(node);
      headings.push(node);
      index++;
      continue;
    }

    const parent = headingStack[headingStack.length - 1] ?? root;
    if (/^(```|~~~)/.test(line.trimStart())) {
      index = parseCodeFence(lines, index, parent, counters);
      continue;
    }

    const list = line.match(/^(\s*)((?:[-*+])|(?:\d+\.))\s+(.*)$/);
    if (list) {
      const path = `${parent.path}/li-${nextCounter(counters, `${parent.path}:li`)}`;
      parent.children.push(markdownNode(path, "list-item", "list-item", index, index, parent, { marker: `${list[1]}${list[2]}`, text: list[3] }));
      index++;
      continue;
    }

    const start = index;
    while (index + 1 < lines.length && lines[index + 1]?.trim() && !/^(#{1,6})\s+/.test(lines[index + 1] ?? "") && !/^(```|~~~)/.test((lines[index + 1] ?? "").trimStart()) && !/^(\s*)((?:[-*+])|(?:\d+\.))\s+/.test(lines[index + 1] ?? "")) {
      index++;
    }
    const path = `${parent.path}/p-${nextCounter(counters, `${parent.path}:p`)}`;
    parent.children.push(markdownNode(path, "paragraph", "paragraph", start, index, parent, { text: lines.slice(start, index + 1).join("\n") }));
    index++;
  }

  for (const heading of headings) heading.endLine = sectionEndLine(heading, lines.length - 1, headings);
  return root;
}

function parseFrontmatter(lines: string[], root: MarkdownNode): number {
  if (lines[0] !== "---") return 0;
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end < 0) fail("INVALID_MARKDOWN", "Frontmatter fence is not closed.");
  const node = markdownNode("$/frontmatter", "frontmatter", "frontmatter", 0, end, root, {});
  root.children.push(node);
  for (let line = 1; line < end; line++) {
    const match = lines[line]?.match(/^([^:#][^:]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    node.children.push(markdownNode(`$/frontmatter/${key}`, key, "frontmatter-entry", line, line, node, { key, value: match[2] }));
  }
  return end + 1;
}

function parseCodeFence(lines: string[], start: number, parent: MarkdownNode, counters: Map<string, number>): number {
  const open = lines[start]?.trimStart() ?? "";
  const fence = open.startsWith("~~~") ? "~~~" : "```";
  let end = start + 1;
  while (end < lines.length && !(lines[end] ?? "").trimStart().startsWith(fence)) end++;
  if (end >= lines.length) fail("INVALID_MARKDOWN", "Code fence is not closed.", { line: start + 1 });
  const path = `${parent.path}/code-${nextCounter(counters, `${parent.path}:code`)}`;
  const lang = open.slice(fence.length).trim();
  parent.children.push(markdownNode(path, "code", "code", start, end, parent, { fence, lang, text: lines.slice(start + 1, end).join("\n") }));
  return end + 1;
}

function sectionEndLine(node: MarkdownNode, fallback: number, headings: MarkdownNode[]): number {
  const level = Number(node.attrs.level ?? 1);
  const next = headings.find((candidate) => candidate.line > node.line && Number(candidate.attrs.level ?? 1) <= level);
  return next ? next.line - 1 : fallback;
}

function markdownNode(path: string, name: string, kind: MarkdownKind, line: number, endLine: number, parent: MarkdownNode | null, attrs: Record<string, unknown>): MarkdownNode {
  return { path, name, kind, line, endLine, parent, attrs, children: [] };
}

function flattenMarkdownNodes(root: MarkdownNode): MarkdownNode[] {
  return [root, ...root.children.flatMap(flattenMarkdownNodes)];
}

function nextCounter(counters: Map<string, number>, key: string): number {
  const value = counters.get(key) ?? 1;
  counters.set(key, value + 1);
  return value;
}

function headingAppendInsertion(node: MarkdownNode): number {
  const childHeading = node.children.find((child) => child.kind === "heading");
  return childHeading ? childHeading.line : node.endLine + 1;
}

function nodeText(lines: string[], node: MarkdownNode): string {
  if (node.kind === "heading") return String(node.attrs.text ?? "");
  if (node.kind === "frontmatter-entry") return String(node.attrs.value ?? "");
  if (node.kind === "list-item") return String(node.attrs.text ?? "");
  if (node.kind === "code") return lines.slice(node.line + 1, node.endLine).join("\n");
  return lines.slice(node.line, node.endLine + 1).join("\n");
}

function markdownText(value: TextValueSpec): string {
  return value.kind === "expr" ? value.code : value.value;
}

function markdownFrontmatterScalar(value: ValueSpec): string {
  if (value && typeof value === "object" && !Array.isArray(value) && "type" in value) {
    if (value.type === "string") return value.value;
    if (value.type === "boolean") return value.value ? "true" : "false";
    if (value.type === "expr") return value.code;
    fail("INVALID_MARKDOWN_VALUE", "Markdown frontmatter does not support spread values.");
  }
  return value === null ? "null" : String(value);
}

function blockFromSpec(spec: TreeNodeSpec): string[] {
  const text = spec.text ?? spec.comment ?? String(spec.name ?? spec.tag ?? "");
  if (!text) fail("INVALID_MARKDOWN_BLOCK", "Markdown append/prepend requires a text, comment, name, or tag value.");
  return text.split("\n");
}

function withBlockSeparation(lines: string[], insertion: number, block: string[]): string[] {
  const result = [...block];
  if (insertion > 0 && lines[insertion - 1] !== "") result.unshift("");
  if (insertion < lines.length && lines[insertion] !== "") result.push("");
  return result;
}
