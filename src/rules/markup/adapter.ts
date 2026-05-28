import type { DocumentAdapter } from "../../core/document.js";
import { MARKUP_ACTIONS, openMarkupDocument, parseMarkupDocument } from "./document.js";

export const markupAdapter: DocumentAdapter = {
  rule: {
    name: "markup",
    extensions: [".html", ".htm", ".xml", ".svg"],
    actions: [...MARKUP_ACTIONS],
  },
  open: openMarkupDocument,
  parse: parseMarkupDocument,
  verify: parseMarkupDocument,
};
