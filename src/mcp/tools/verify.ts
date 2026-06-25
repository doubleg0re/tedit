import { z } from "zod/v4";
import type { TeditMcpTool } from "../../mcp-tools.js";

// ponytail: explicit any avoids runtime imports from the source module; tighten when dependency typing matters.
export function makeVERIFY_TOOLS(deps: any) {
  const { fileSchema, runVerifyFileTool } = deps;
  return [
    {
      name: "verify_file",
      title: "Verify File",
      description: "Verify one or more current files after native Read or before/after edits; this is parser coverage, not a full-content read replacement.",
      category: "discover",
      aliases: ["parse_check", "verify"],
      bestFor: ["checking parser support", "post-edit validation", "distinguishing parse skips from parse failures"],
      inputSchema: {
        file: fileSchema.optional(),
        files: z.array(fileSchema).optional().describe("Additional target file paths for one call."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: runVerifyFileTool,
    }
  ] satisfies readonly TeditMcpTool[];
}
