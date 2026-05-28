import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { BaseRuleDocument } from "../../core/base-rule-document.js";
import type { TextMatchSpec, TextValueSpec, TreeNodeInfo, ValueSpec } from "../../core/document.js";
import { fail } from "../../errors.js";

export const JSON_ACTIONS = [
  "find",
  "inspect",
  "remove",
  "prop.set",
  "prop.remove",
  "text.set",
  "text.replace",
] as const;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonContainer = JsonValue[] | { [key: string]: JsonValue };
type JsonPathSegment = string | number;

type JsonNode = {
  value: JsonValue;
  path: string;
  segments: JsonPathSegment[];
  parent: JsonNode | null;
  key: JsonPathSegment | null;
  children: JsonNode[];
};

type JsonMode = "json" | "jsonl";

type ParsedJsonSource = {
  data: JsonValue;
  mode: JsonMode;
  trailingNewline: boolean;
  indent: number;
};

export class JsonDocument extends BaseRuleDocument<JsonNode> {
  private data: JsonValue;
  private readonly mode: JsonMode;
  private readonly trailingNewline: boolean;
  private readonly indent: number;
  private nodesByPath = new Map<string, JsonNode>();

  constructor(filePath: string, source: string, parsed = parseJsonSource(filePath, source)) {
    super("json", filePath, source, JSON_ACTIONS);
    this.data = parsed.data;
    this.mode = parsed.mode;
    this.trailingNewline = parsed.trailingNewline;
    this.indent = parsed.indent;
    this.reindex();
  }

  remove(target: string): void {
    const node = this.resolvePath(target);
    if (!node.parent || node.key === null) fail("JSON_ROOT_REMOVE", "Cannot remove the JSON root node.");
    removeChild(parentContainer(node), node.key);
    this.reindex();
  }

  setAttribute(target: string, name: string, value: ValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    if (!isPlainObject(node.value)) {
      fail("JSON_NOT_OBJECT", "prop.set requires a selected JSON object node.", { path: node.path, type: jsonKind(node.value) });
    }
    node.value[name] = jsonValueFromSpec(value);
    return this.reindexAndResolve(node.path);
  }

  removeAttribute(target: string, name: string): TreeNodeInfo {
    const node = this.resolvePath(target);
    if (!isPlainObject(node.value)) {
      fail("JSON_NOT_OBJECT", "prop.remove requires a selected JSON object node.", { path: node.path, type: jsonKind(node.value) });
    }
    delete node.value[name];
    return this.reindexAndResolve(node.path);
  }

  setText(target: string, value: TextValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    this.replaceNodeValue(node, jsonValueFromText(value));
    return this.reindexAndResolve(node.path);
  }

  replaceText(target: string, match: TextMatchSpec, value: TextValueSpec): TreeNodeInfo {
    const node = this.resolvePath(target);
    const current = scalarText(node.value);
    if (current === null) fail("JSON_NOT_SCALAR", "text.replace requires a selected scalar JSON node.", { path: node.path, type: jsonKind(node.value) });
    const expected = match.kind === "expr" ? JSON.stringify(parseJsonLiteral(match.code)) : match.value;
    if (match.kind !== "any" && current !== expected) {
      fail("TEXT_NOT_FOUND", "Selected JSON scalar did not match the requested text.", { path: node.path, current, expected });
    }
    this.replaceNodeValue(node, jsonValueFromText(value));
    return this.reindexAndResolve(node.path);
  }

  print(): string {
    if (this.mode === "jsonl") {
      const rows = Array.isArray(this.data) ? this.data : [this.data];
      return rows.map((row) => JSON.stringify(row)).join("\n") + (this.trailingNewline ? "\n" : "");
    }
    return JSON.stringify(this.data, null, this.indent) + (this.trailingNewline ? "\n" : "");
  }

  protected nodeForPath(path: JsonNode): object {
    return path;
  }

  protected buildInfo(id: string, node: JsonNode): TreeNodeInfo {
    const kind = jsonKind(node.value);
    const attributes: Record<string, unknown> = {
      path: node.path,
      type: kind,
      ...(node.key === null ? {} : typeof node.key === "number" ? { index: node.key } : { key: node.key }),
      ...(isScalar(node.value) ? { value: node.value } : {}),
    };
    return {
      id,
      kind,
      name: nodeName(node),
      attributes,
      props: attributes,
      childCount: node.children.length,
      preview: previewJson(node.value),
    };
  }

  protected parentPath(path: JsonNode): JsonNode | null {
    return path.parent;
  }

  protected siblingPaths(path: JsonNode): JsonNode[] {
    return path.parent?.children ?? [];
  }

  private replaceNodeValue(node: JsonNode, next: JsonValue): void {
    if (!node.parent || node.key === null) {
      this.data = next;
      return;
    }
    setChild(parentContainer(node), node.key, next);
  }

  private reindexAndResolve(path: string): TreeNodeInfo {
    this.reindex();
    const next = this.nodesByPath.get(path);
    if (!next) fail("NODE_NOT_FOUND", `JSON path ${path} is no longer available.`);
    return this.inspect(this.getNodeId(next));
  }

  private reindex(): void {
    const root = buildJsonNode(this.data, [], null, null);
    const nodes = flattenJsonNodes(root);
    this.nodesByPath = new Map(nodes.map((node) => [node.path, node]));
    this.reindexPaths(nodes);
  }
}

export function openJsonDocument(filePath: string): JsonDocument {
  return new JsonDocument(filePath, readFileSync(filePath, "utf8"));
}

export function parseJsonDocument(filePath: string, source: string): JsonDocument {
  return new JsonDocument(filePath, source);
}

function parseJsonSource(filePath: string, source: string): ParsedJsonSource {
  const mode: JsonMode = [".jsonl", ".ndjson"].includes(extname(filePath).toLowerCase()) ? "jsonl" : "json";
  const trailingNewline = source.endsWith("\n");
  const indent = detectJsonIndent(source);
  try {
    if (mode === "jsonl") {
      const lines = source.split(/\r?\n/).filter((line, index, lines) => !(line === "" && index === lines.length - 1));
      return { data: lines.map((line) => JSON.parse(line) as JsonValue), mode, trailingNewline, indent };
    }
    return { data: JSON.parse(source) as JsonValue, mode, trailingNewline, indent };
  } catch (error) {
    fail("INVALID_JSON", `Invalid ${mode.toUpperCase()} source.`, { parser_error: error instanceof Error ? error.message : String(error) });
  }
}

function buildJsonNode(value: JsonValue, segments: JsonPathSegment[], parent: JsonNode | null, key: JsonPathSegment | null): JsonNode {
  const node: JsonNode = { value, path: formatJsonPath(segments), segments, parent, key, children: [] };
  if (Array.isArray(value)) {
    node.children = value.map((child, index) => buildJsonNode(child, [...segments, index], node, index));
  } else if (isPlainObject(value)) {
    node.children = Object.entries(value).map(([childKey, child]) => buildJsonNode(child, [...segments, childKey], node, childKey));
  }
  return node;
}

function flattenJsonNodes(root: JsonNode): JsonNode[] {
  return [root, ...root.children.flatMap(flattenJsonNodes)];
}

function formatJsonPath(segments: JsonPathSegment[]): string {
  let path = "$";
  for (const segment of segments) {
    if (typeof segment === "number") path += `[${segment}]`;
    else if (/^[A-Za-z_$][\w$-]*$/.test(segment)) path += `.${segment}`;
    else path += `[${JSON.stringify(segment)}]`;
  }
  return path;
}

function nodeName(node: JsonNode): string {
  if (node.key === null) return "root";
  return typeof node.key === "number" ? "item" : node.key;
}

function parentContainer(node: JsonNode): JsonContainer {
  if (!node.parent || !isContainer(node.parent.value)) fail("JSON_PATH_MISMATCH", "JSON node parent is not a container.");
  return node.parent.value;
}

function isContainer(value: JsonValue): value is JsonContainer {
  return Array.isArray(value) || isPlainObject(value);
}

function setChild(container: JsonContainer, key: JsonPathSegment, value: JsonValue): void {
  if (Array.isArray(container) && typeof key === "number") {
    container[key] = value;
    return;
  }
  if (isPlainObject(container) && typeof key === "string") {
    container[key] = value;
    return;
  }
  fail("JSON_PATH_MISMATCH", "JSON node parent/key relationship is invalid.");
}

function removeChild(container: JsonContainer, key: JsonPathSegment): void {
  if (Array.isArray(container) && typeof key === "number") {
    container.splice(key, 1);
    return;
  }
  if (isPlainObject(container) && typeof key === "string") {
    delete container[key];
    return;
  }
  fail("JSON_PATH_MISMATCH", "JSON node parent/key relationship is invalid.");
}

function jsonValueFromSpec(value: ValueSpec): JsonValue {
  if (value && typeof value === "object" && !Array.isArray(value) && "type" in value) {
    if (value.type === "string") return value.value;
    if (value.type === "boolean") return value.value;
    if (value.type === "expr") return parseJsonLiteral(value.code);
    fail("INVALID_JSON_VALUE", "JSON prop values do not support JSX spread values.");
  }
  return assertJsonValue(value);
}

function jsonValueFromText(value: TextValueSpec): JsonValue {
  if (value.kind === "text") return value.value;
  return parseJsonLiteral(value.code);
}

function parseJsonLiteral(source: string): JsonValue {
  try {
    return assertJsonValue(JSON.parse(source));
  } catch (error) {
    fail("INVALID_JSON_VALUE", "Expected a valid JSON literal.", { parser_error: error instanceof Error ? error.message : String(error) });
  }
}

function assertJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(assertJsonValue);
  if (isPlainObject(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) result[key] = assertJsonValue(child);
    return result;
  }
  fail("INVALID_JSON_VALUE", "Value is not representable as JSON.");
}

function scalarText(value: JsonValue): string | null {
  if (!isScalar(value)) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function jsonKind(value: JsonValue): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function isScalar(value: JsonValue): value is JsonPrimitive {
  return value === null || typeof value !== "object";
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function previewJson(value: JsonValue): string {
  const raw = JSON.stringify(value);
  if (raw === undefined) return String(value);
  return raw.length > 100 ? `${raw.slice(0, 97)}...` : raw;
}

function detectJsonIndent(source: string): number {
  const match = source.match(/\n( +)\S/);
  return match ? Math.min(Math.max(match[1].length, 0), 8) : 2;
}
