import { readFileSync } from "node:fs";
import { BaseRuleDocument } from "../../core/base-rule-document.js";
import type { TextMatchSpec, TextValueSpec, TreeNodeInfo, ValueSpec } from "../../core/document.js";
import { fail } from "../../errors.js";

export const YAML_ACTIONS = [
  "find",
  "inspect",
  "remove",
  "prop.set",
  "prop.remove",
  "text.set",
  "text.replace",
] as const;

type YamlNode = {
  path: string;
  name: string;
  key: string | number | null;
  kind: "root" | "mapping" | "sequence-item" | "scalar";
  indent: number;
  line: number;
  endLine: number;
  value: string | null;
  parent: YamlNode | null;
  children: YamlNode[];
};

export class YamlDocument extends BaseRuleDocument<YamlNode> {
  private lines: string[];
  private readonly trailingNewline: boolean;
  private nodesByPath = new Map<string, YamlNode>();

  constructor(filePath: string, source: string) {
    super("yaml", filePath, source, YAML_ACTIONS);
    this.trailingNewline = source.endsWith("\n");
    this.lines = source.replace(/\r\n/g, "\n").split("\n");
    if (this.trailingNewline) this.lines.pop();
    this.reindex();
  }

  remove(target: string): void {
    const node = this.resolvePath(target);
    if (!node.parent) fail("YAML_ROOT_REMOVE", "Cannot remove the YAML root node.");
    this.lines.splice(node.line, node.endLine - node.line + 1);
    this.reindex();
  }

  setAttribute(target: string, name: string, value: ValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    ensureMappingTarget(node, "prop.set");
    const existing = node.children.find((child) => child.key === name);
    const scalar = yamlScalarFromSpec(value);
    if (existing) {
      this.replaceNodeScalar(existing, scalar);
      return this.reindexAndResolve(existing.path);
    }

    const indent = node.indent < 0 ? 0 : node.indent + 2;
    const line = `${" ".repeat(indent)}${name}: ${scalar}`;
    this.lines.splice(node.endLine + 1, 0, line);
    this.reindex();
    return this.reindexAndResolve(formatYamlPath([...nodePathSegments(node), name]));
  }

  removeAttribute(target: string, name: string): TreeNodeInfo {
    const node = this.resolvePath(target);
    ensureMappingTarget(node, "prop.remove");
    const existing = node.children.find((child) => child.key === name);
    if (!existing) return this.inspect(this.getNodeId(node));
    this.lines.splice(existing.line, existing.endLine - existing.line + 1);
    this.reindex();
    return this.reindexAndResolve(node.path);
  }

  setText(target: string, value: TextValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    this.replaceNodeScalar(node, yamlScalarFromText(value));
    return this.reindexAndResolve(node.path);
  }

  replaceText(target: string, match: TextMatchSpec, value: TextValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    const current = node.value ?? "";
    const expected = match.kind === "expr" ? yamlScalarFromText({ kind: "expr", code: match.code }) : match.value;
    if (match.kind !== "any" && current !== expected) {
      fail("TEXT_NOT_FOUND", "Selected YAML scalar did not match the requested text.", { path: node.path, current, expected });
    }
    this.replaceNodeScalar(node, yamlScalarFromText(value));
    return this.reindexAndResolve(node.path);
  }

  print(): string {
    return this.lines.join("\n") + (this.trailingNewline ? "\n" : "");
  }

  protected nodeForPath(path: YamlNode): object {
    return path;
  }

  protected buildInfo(id: string, node: YamlNode): TreeNodeInfo {
    const attributes: Record<string, unknown> = {
      path: node.path,
      indent: node.indent,
      ...(node.key === null ? {} : typeof node.key === "number" ? { index: node.key } : { key: node.key }),
      ...(node.value === null ? {} : { value: node.value }),
    };
    return {
      id,
      kind: node.kind,
      name: node.name,
      loc: node.line >= 0 ? { start: { line: node.line + 1, column: node.indent + 1 }, end: { line: node.endLine + 1, column: 1 } } : undefined,
      attributes,
      props: attributes,
      childCount: node.children.length,
      preview: node.line >= 0 ? this.lines.slice(node.line, node.endLine + 1).join("\n") : "root",
    };
  }

  protected parentPath(path: YamlNode): YamlNode | null {
    return path.parent;
  }

  protected siblingPaths(path: YamlNode): YamlNode[] {
    return path.parent?.children ?? [];
  }

  private replaceNodeScalar(node: YamlNode, scalar: string): void {
    if (node.kind === "root") fail("YAML_ROOT_TEXT", "Cannot set root YAML text through text.set.");
    const line = this.lines[node.line] ?? "";
    if (typeof node.key === "number") {
      this.lines[node.line] = `${" ".repeat(node.indent)}- ${scalar}`;
      return;
    }
    const match = line.match(/^(\s*[^:#][^:]*:)(?:\s*.*)?$/);
    if (!match) fail("UNSUPPORTED_YAML_NODE", "Can only set scalar mapping or sequence item nodes.", { path: node.path });
    this.lines[node.line] = `${match[1]} ${scalar}`;
  }

  private reindexAndResolve(path: string): TreeNodeInfo {
    this.reindex();
    const next = this.nodesByPath.get(path);
    if (!next) fail("NODE_NOT_FOUND", `YAML path ${path} is no longer available.`);
    return this.inspect(this.getNodeId(next));
  }

  private reindex(): void {
    const root = parseYamlLines(this.lines);
    const nodes = flattenYamlNodes(root);
    this.nodesByPath = new Map(nodes.map((node) => [node.path, node]));
    this.reindexPaths(nodes);
  }
}

export function openYamlDocument(filePath: string): YamlDocument {
  return new YamlDocument(filePath, readFileSync(filePath, "utf8"));
}

export function parseYamlDocument(filePath: string, source: string): YamlDocument {
  return new YamlDocument(filePath, source);
}

function ensureMappingTarget(node: YamlNode, action: string): void {
  if (node.kind === "root" || node.kind === "mapping") return;
  fail("YAML_NOT_MAPPING", `${action} requires a YAML mapping/root node.`, { path: node.path, kind: node.kind });
}

function parseYamlLines(lines: string[]): YamlNode {
  const root = node("$", "root", null, "root", -1, -1, null, null);
  const stack: YamlNode[] = [root];
  const sequenceCounts = new Map<string, number>();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex];
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = leadingSpaces(raw);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1] ?? root;
    const trimmed = raw.trimStart();

    if (trimmed.startsWith("- ")) {
      const indexKey = `${parent.path}:${indent}`;
      const index = sequenceCounts.get(indexKey) ?? 0;
      sequenceCounts.set(indexKey, index + 1);
      const value = trimmed.slice(2).trim();
      const child = node(`${parent.path}[${index}]`, "item", index, value ? "sequence-item" : "mapping", indent, lineIndex, value || null, parent);
      parent.children.push(child);
      stack.push(child);
      continue;
    }

    const match = trimmed.match(/^([^:#][^:]*):(\s*(.*))?$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = (match[3] ?? "").trim();
    const childPath = formatYamlPath([...nodePathSegments(parent), key]);
    const child = node(childPath, key, key, value ? "scalar" : "mapping", indent, lineIndex, value || null, parent);
    parent.children.push(child);
    stack.push(child);
  }

  computeEndLines(root);
  return root;
}

function node(path: string, name: string, key: string | number | null, kind: YamlNode["kind"], indent: number, line: number, value: string | null, parent: YamlNode | null): YamlNode {
  return { path, name, key, kind, indent, line, endLine: line, value, parent, children: [] };
}

function computeEndLines(node: YamlNode): number {
  node.endLine = node.children.reduce((end, child) => Math.max(end, computeEndLines(child)), node.line);
  return node.endLine;
}

function flattenYamlNodes(root: YamlNode): YamlNode[] {
  return [root, ...root.children.flatMap(flattenYamlNodes)];
}

function nodePathSegments(node: YamlNode): Array<string | number> {
  const result: Array<string | number> = [];
  let cursor: YamlNode | null = node;
  while (cursor && cursor.key !== null) {
    result.unshift(cursor.key);
    cursor = cursor.parent;
  }
  return result;
}

function formatYamlPath(segments: Array<string | number>): string {
  let path = "$";
  for (const segment of segments) {
    if (typeof segment === "number") path += `[${segment}]`;
    else if (/^[A-Za-z_$][\w$-]*$/.test(segment)) path += `.${segment}`;
    else path += `[${JSON.stringify(segment)}]`;
  }
  return path;
}

function yamlScalarFromSpec(value: ValueSpec): string {
  if (value && typeof value === "object" && !Array.isArray(value) && "type" in value) {
    if (value.type === "string") return formatYamlScalar(value.value);
    if (value.type === "boolean") return value.value ? "true" : "false";
    if (value.type === "expr") return value.code;
    fail("INVALID_YAML_VALUE", "YAML prop values do not support JSX spread values.");
  }
  return formatYamlScalar(value);
}

function yamlScalarFromText(value: TextValueSpec): string {
  return value.kind === "expr" ? value.code : formatYamlScalar(value.value);
}

function formatYamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return JSON.stringify(value);
  if (/^[A-Za-z0-9_./@-]+(?: [A-Za-z0-9_./@-]+)*$/.test(value)) return value;
  return JSON.stringify(value);
}

function leadingSpaces(value: string): number {
  const match = value.match(/^ */);
  return match ? match[0].length : 0;
}
