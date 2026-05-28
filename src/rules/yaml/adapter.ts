import type { DocumentAdapter } from "../../core/document.js";
import { openYamlDocument, parseYamlDocument, YAML_ACTIONS } from "./document.js";

export const yamlAdapter: DocumentAdapter = {
  rule: {
    name: "yaml",
    extensions: [".yaml", ".yml"],
    actions: [...YAML_ACTIONS],
  },
  open: openYamlDocument,
  parse: parseYamlDocument,
};
