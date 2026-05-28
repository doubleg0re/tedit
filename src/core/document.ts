export type ValueSpec =
  | string
  | number
  | boolean
  | null
  | { type: "string"; value: string }
  | { type: "expr"; code: string }
  | { type: "boolean"; value: boolean }
  | { type: "spread"; code: string };

export type TreeNodeSpec = {
  kind?: string;
  name?: string;
  tag?: string;
  props?: Record<string, ValueSpec>;
  attrs?: Record<string, ValueSpec>;
  attributes?: Record<string, ValueSpec>;
  children?: TreeNodeSpec[];
  text?: string;
  comment?: string;
};

export type TreeNodeInfo = {
  id: string;
  kind: string;
  name: string;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  attributes: Record<string, unknown>;
  props?: Record<string, unknown>;
  childCount: number;
  preview: string;
};

export type CommentPosition = "inside-start" | "inside-end" | "before" | "after";

export type TextValueSpec =
  | { kind: "text"; value: string }
  | { kind: "expr"; code: string };

export type TextMatchSpec =
  | { kind: "text"; value: string }
  | { kind: "expr"; code: string }
  | { kind: "any"; value: string };

export type ImportEditSpec = {
  from: string;
  to?: string;
  named?: string | string[];
  default?: string;
  namespace?: string;
  name?: string;
  value?: unknown;
};

export interface StructuredDocument {
  readonly ruleName: string;
  readonly filePath: string;
  readonly source: string;

  find(selector: string): TreeNodeInfo[];
  inspect(target: string): TreeNodeInfo;
  append(target: string, spec: TreeNodeSpec): TreeNodeInfo;
  prepend(target: string, spec: TreeNodeSpec): TreeNodeInfo;
  wrap(target: string, wrapper: TreeNodeSpec): TreeNodeInfo;
  unwrap(target: string): TreeNodeInfo | null;
  rename(target: string, name: string): TreeNodeInfo;
  remove(target: string): void;
  setAttribute(target: string, name: string, value: ValueSpec): TreeNodeInfo;
  removeAttribute(target: string, name: string): TreeNodeInfo;
  insertComment(target: string, text: string, position?: CommentPosition): TreeNodeInfo;
  setText(target: string, value: TextValueSpec): TreeNodeInfo;
  replaceText(target: string, match: TextMatchSpec, value: TextValueSpec): TreeNodeInfo;
  addImport(spec: ImportEditSpec): unknown;
  removeImport(spec: ImportEditSpec): unknown;
  renameImport(spec: ImportEditSpec): unknown;
  moveImport(spec: ImportEditSpec): unknown;
  replaceExpression(target: string, code: string): TreeNodeInfo;
  wrapExpression(target: string, code: string): TreeNodeInfo;
  unwrapExpression(target: string): TreeNodeInfo;
  toTernaryExpression(target: string, alternate?: string): TreeNodeInfo;
  toShortCircuitExpression(target: string): TreeNodeInfo;
  print(): string;
}

export type RuleMetadata = {
  name: string;
  extensions: string[];
  actions: string[];
};

export interface DocumentAdapter {
  readonly rule: RuleMetadata;
  open(filePath: string): StructuredDocument;
  parse(filePath: string, source: string): StructuredDocument;
}
