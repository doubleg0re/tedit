import { extname } from "node:path";
import { fail } from "../errors.js";
import { jsxAdapter } from "../rules/jsx/adapter.js";
import { jsonAdapter } from "../rules/json/adapter.js";
import type { DocumentAdapter, StructuredDocument } from "./document.js";

const adapters: DocumentAdapter[] = [
  jsxAdapter,
  jsonAdapter,
];

export function getAdapterForFile(filePath: string): DocumentAdapter {
  const adapter = getOptionalAdapterForFile(filePath);
  if (!adapter) {
    const ext = extname(filePath).toLowerCase();
    fail("UNSUPPORTED_FORMAT", `No tedit rule supports "${ext || filePath}".`);
  }
  return adapter;
}

export function getOptionalAdapterForFile(filePath: string): DocumentAdapter | null {
  const ext = extname(filePath).toLowerCase();
  const adapter = adapters.find((candidate) => candidate.rule.extensions.includes(ext));
  return adapter ?? null;
}

export function hasAdapterForFile(filePath: string): boolean {
  return getOptionalAdapterForFile(filePath) !== null;
}

export function openDocumentForFile(filePath: string): StructuredDocument {
  return getAdapterForFile(filePath).open(filePath);
}

export function parseDocumentForFile(filePath: string, source: string): StructuredDocument {
  return getAdapterForFile(filePath).parse(filePath, source);
}

export function listRules(): Array<DocumentAdapter["rule"]> {
  return adapters.map((adapter) => adapter.rule);
}
