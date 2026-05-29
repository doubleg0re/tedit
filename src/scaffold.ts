import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseElementShorthand } from "./chain.js";
import type { TreeNodeSpec, ValueSpec } from "./core/document.js";
import { fail } from "./errors.js";

export type ScaffoldImportSpec = {
  from: string;
  named?: string | string[];
  default?: string;
  namespace?: string;
  type?: boolean;
};

export type ScaffoldExportSpec = {
  kind: "function";
  name: string;
  params?: string;
  body?: TreeNodeSpec | string;
  default?: boolean;
  async?: boolean;
  returnType?: string;
};

export type ScaffoldSpec = {
  source?: string;
  directives?: string | string[];
  imports?: ScaffoldImportSpec[];
  exports?: ScaffoldExportSpec[];
};

export type TemplateInfo = {
  name: string;
  source: "builtin" | "local" | "global";
  path?: string;
};

const builtInTemplates: Record<string, ScaffoldSpec> = {
  "react-component": {
    source: `export type {{name}}Props = {\n};\n\nexport function {{name}}(props: {{name}}Props) {\n  return <div />;\n}\n`,
  },
  "react-client-component": {
    source: `"use client";\n\nexport type {{name}}Props = {\n};\n\nexport function {{name}}(props: {{name}}Props) {\n  return <div />;\n}\n`,
  },
  "next-page": {
    exports: [{ kind: "function", name: "Page", default: true, body: { tag: "main" } }],
  },
  "server-action": {
    source: `"use server";\n\nexport async function {{name}}() {\n}\n`,
  },
  "custom-hook": {
    source: `export function {{name}}() {\n  return null;\n}\n`,
  },
  "vitest-component-test": {
    source: `import { describe, expect, it } from "vitest";\n\nimport { {{name}} } from "./{{name}}";\n\ndescribe("{{name}}", () => {\n  it("exports the component", () => {\n    expect({{name}}).toBeDefined();\n  });\n});\n`,
  },
};

export function buildScaffoldSource(spec: ScaffoldSpec): string {
  if (spec.source !== undefined) return ensureTrailingNewline(spec.source);

  const chunks: string[] = [];
  const directives = normalizeStringList(spec.directives);
  if (directives.length > 0) {
    chunks.push(directives.map((directive) => `${JSON.stringify(directive)};`).join("\n"));
  }

  const imports = [...(spec.imports ?? [])].sort((a, b) => a.from.localeCompare(b.from));
  if (imports.length > 0) chunks.push(imports.map(renderImport).join("\n"));

  const exports = spec.exports ?? [];
  if (exports.length === 0) fail("INVALID_SCAFFOLD", "scaffold requires source or at least one export.");
  chunks.push(exports.map(renderExport).join("\n\n"));

  return `${chunks.filter(Boolean).join("\n\n")}\n`;
}

export function loadScaffoldSpec(input: string): ScaffoldSpec {
  const raw = loadJsonOrFile(input);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("INVALID_SCAFFOLD", "Scaffold spec must be a JSON object.");
  }
  return raw as ScaffoldSpec;
}

export function loadTemplateSpec(name: string, params: Record<string, string>, cwd = process.cwd()): ScaffoldSpec {
  const local = resolve(cwd, ".tedit", "templates", `${name}.tedit-template.json`);
  const global = join(homedir(), ".tedit", "templates", `${name}.tedit-template.json`);
  const raw = existsSync(local)
    ? loadScaffoldSpec(local)
    : existsSync(global)
      ? loadScaffoldSpec(global)
      : builtInTemplates[name];

  if (!raw) fail("TEMPLATE_NOT_FOUND", `No tedit template named "${name}".`);
  return substituteParams(raw, params) as ScaffoldSpec;
}

export function listTemplates(cwd = process.cwd()): TemplateInfo[] {
  const localDir = resolve(cwd, ".tedit", "templates");
  const globalDir = join(homedir(), ".tedit", "templates");
  return [
    ...Object.keys(builtInTemplates).sort().map((name) => ({ name, source: "builtin" as const })),
    ...templateFiles(globalDir, "global"),
    ...templateFiles(localDir, "local"),
  ];
}

export function parseScaffoldImport(input: string): ScaffoldImportSpec {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as ScaffoldImportSpec;

  const separator = trimmed.indexOf(":");
  if (separator < 0) return { from: trimmed };

  const from = trimmed.slice(0, separator);
  const rest = trimmed.slice(separator + 1).trim();
  if (rest.startsWith("type ")) return { from, named: rest.slice("type ".length).split(",").map((item) => item.trim()), type: true };
  if (rest.startsWith("default ")) return { from, default: rest.slice("default ".length).trim() };
  if (rest.startsWith("namespace ")) return { from, namespace: rest.slice("namespace ".length).trim() };
  return { from, named: rest.split(",").map((item) => item.trim()).filter(Boolean) };
}

export function parseScaffoldExport(input: string, body?: TreeNodeSpec | string): ScaffoldExportSpec {
  const match = input.match(/^(default:)?function:([A-Za-z_$][\w$]*)(?:\((.*)\))?$/);
  if (!match) fail("INVALID_SCAFFOLD", `Unsupported export spec: ${input}`);
  return {
    kind: "function",
    name: match[2],
    ...(match[1] ? { default: true } : {}),
    ...(match[3] !== undefined ? { params: match[3] } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

export function parseParams(values: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const value of values) {
    const eq = value.indexOf("=");
    if (eq < 1) fail("INVALID_PARAMS", `Template param must be key=value: ${value}`);
    params[value.slice(0, eq)] = value.slice(eq + 1);
  }
  return params;
}

function renderImport(spec: ScaffoldImportSpec): string {
  const clauses: string[] = [];
  if (spec.default) clauses.push(spec.default);
  if (spec.namespace) clauses.push(`* as ${spec.namespace}`);

  const named = normalizeStringList(spec.named);
  if (named.length > 0) clauses.push(`${spec.type ? "type " : ""}{ ${named.join(", ")} }`);

  if (clauses.length === 0) return `import ${JSON.stringify(spec.from)};`;
  return `import ${clauses.join(", ")} from ${JSON.stringify(spec.from)};`;
}

function renderExport(spec: ScaffoldExportSpec): string {
  if (spec.kind !== "function") fail("INVALID_SCAFFOLD", `Unsupported export kind: ${String((spec as { kind?: unknown }).kind)}`);
  const body = spec.body === undefined ? "null" : renderBody(spec.body);
  const prefix = `export ${spec.default ? "default " : ""}${spec.async ? "async " : ""}function ${spec.name}(${spec.params ?? ""})${spec.returnType ? `: ${spec.returnType}` : ""}`;
  return `${prefix} {\n  return (${body.includes("\n") ? `\n${indent(body, 4)}\n  ` : body});\n}`;
}

function renderBody(body: TreeNodeSpec | string): string {
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed.startsWith("<")) return trimmed;
    return renderNode(parseElementShorthand(trimmed));
  }
  return renderNode(body);
}

function renderNode(spec: TreeNodeSpec): string {
  if (spec.text !== undefined) return spec.text;
  if (spec.comment !== undefined) return `{/* ${spec.comment} */}`;

  const tag = spec.tag ?? spec.name;
  if (!tag) fail("INVALID_SCAFFOLD", "Element spec requires tag or name.");

  const attrs = renderAttributes(spec.props ?? spec.attrs ?? spec.attributes ?? {});
  const children = spec.children ?? [];
  if (children.length === 0) return `<${tag}${attrs} />`;
  return `<${tag}${attrs}>${children.map(renderNode).join("")}</${tag}>`;
}

function renderAttributes(attributes: Record<string, ValueSpec>): string {
  const rendered = Object.entries(attributes).map(([name, value]) => {
    if (name.startsWith("...")) return `{...${name.slice(3)}}`;
    if (value === true || (isValueSpecObject(value) && value.type === "boolean" && value.value === true)) return name;
    if (typeof value === "string") return `${name}=${JSON.stringify(value)}`;
    if (typeof value === "number" || typeof value === "boolean" || value === null) return `${name}={${String(value)}}`;
    if (isValueSpecObject(value) && value.type === "string") return `${name}=${JSON.stringify(value.value)}`;
    if (isValueSpecObject(value) && value.type === "expr") return `${name}={${value.code}}`;
    if (isValueSpecObject(value) && value.type === "spread") return `{...${value.code}}`;
    fail("INVALID_SCAFFOLD", `Unsupported attribute value for ${name}.`);
  });

  return rendered.length > 0 ? ` ${rendered.join(" ")}` : "";
}

function isValueSpecObject(value: unknown): value is Extract<ValueSpec, { type: string }> {
  return !!value && typeof value === "object" && "type" in value;
}

function normalizeStringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
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

function templateFiles(dir: string, source: "local" | "global"): TemplateInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".tedit-template.json"))
    .sort()
    .map((file) => ({
      name: file.slice(0, -".tedit-template.json".length),
      source,
      path: join(dir, file),
    }));
}

function substituteParams(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([^}]+)\}\}/g, (_match, name: string) => {
      const key = name.trim();
      if (!(key in params)) fail("MISSING_TEMPLATE_PARAM", `Missing template param "${key}".`);
      return params[key];
    });
  }
  if (Array.isArray(value)) return value.map((item) => substituteParams(item, params));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) result[key] = substituteParams(child, params);
    return result;
  }
  return value;
}

function indent(value: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return value.split("\n").map((line) => `${pad}${line}`).join("\n");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
