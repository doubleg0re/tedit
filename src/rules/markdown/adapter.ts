import type { DocumentAdapter } from "../../core/document.js";
import { MARKDOWN_ACTIONS, openMarkdownDocument, parseMarkdownDocument } from "./document.js";

export const markdownAdapter: DocumentAdapter = {
  rule: {
    name: "markdown",
    extensions: [".md", ".markdown", ".mdx"],
    actions: [...MARKDOWN_ACTIONS],
  },
  open: openMarkdownDocument,
  parse: parseMarkdownDocument,
};
