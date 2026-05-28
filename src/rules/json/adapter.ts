import type { DocumentAdapter } from "../../core/document.js";
import { JSON_ACTIONS, openJsonDocument, parseJsonDocument } from "./document.js";

export const jsonAdapter: DocumentAdapter = {
  rule: {
    name: "json",
    extensions: [".json", ".jsonl", ".ndjson"],
    actions: [...JSON_ACTIONS],
  },
  open: openJsonDocument,
  parse: parseJsonDocument,
};
