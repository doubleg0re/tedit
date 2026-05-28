import { JsxDocument, openJsxDocument } from "./document.js";
import type { DocumentAdapter, RuleMetadata } from "../../core/document.js";

export const jsxRule: RuleMetadata = {
  name: "jsx",
  extensions: [".js", ".jsx", ".ts", ".tsx"],
  actions: [
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
    "extract",
  ],
};

export const jsxAdapter: DocumentAdapter = {
  rule: jsxRule,
  open(filePath: string): JsxDocument {
    return openJsxDocument(filePath);
  },
  parse(filePath: string, source: string): JsxDocument {
    return new JsxDocument(filePath, source);
  },
  verify(filePath: string, source: string): void {
    new JsxDocument(filePath, source);
  },
};
