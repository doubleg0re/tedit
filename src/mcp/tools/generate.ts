import { z } from "zod/v4";
import type { TeditMcpTool } from "../../mcp-tools.js";

// ponytail: explicit any avoids runtime imports from the source module; tighten when dependency typing matters.
export function makeGENERATE_TOOLS(deps: any): readonly TeditMcpTool[] {
  const { fileSchema, runCreateFileTool, runFileWriteTool, runNewFileTool, runScaffoldFileTool, runWriteFileTool, writeFlagSchema } = deps;
  return [
    {
      name: "write_file",
      title: "Write File",
      description: "Safer replacement for Write on complete file contents: create or overwrite through tedit write policy and parse verification.",
      category: "generate",
      exposure: "advanced",
      aliases: ["write", "overwrite_file"],
      bestFor: ["full-file generation", "overwrite with parser guardrails", "agent-authored source strings"],
      inputSchema: {
        file: fileSchema,
        source: z.string(),
        overwrite: z.boolean().optional(),
        ...writeFlagSchema,
      },
      handler: runWriteFileTool,
    },
    {
      name: "create_file",
      title: "Create File",
      description: "Safer replacement for creating a new file from complete contents through tedit write policy and parse verification.",
      category: "generate",
      aliases: ["create", "new_source_file"],
      bestFor: ["new files", "parse-verified generated content", "no-overwrite creation"],
      inputSchema: {
        file: fileSchema,
        source: z.string(),
        overwrite: z.boolean().optional(),
        ...writeFlagSchema,
      },
      handler: runCreateFileTool,
    },
    {
      name: "scaffold_file",
      title: "Scaffold File",
      description: "Generate a file from a tedit scaffold spec, then apply write policy and parse verification.",
      category: "generate",
      exposure: "advanced",
      aliases: ["scaffold"],
      bestFor: ["structured TSX/JSX generation", "spec-driven boilerplate", "repeatable component skeletons"],
      inputSchema: {
        file: fileSchema,
        spec: z.record(z.string(), z.unknown()).optional(),
        source: z.string().optional(),
        overwrite: z.boolean().optional(),
        ...writeFlagSchema,
      },
      handler: runScaffoldFileTool,
    },
    {
      name: "new_file",
      title: "New File From Template",
      description: "Generate a file from a built-in or local tedit template, then apply write policy and parse verification.",
      category: "generate",
      exposure: "advanced",
      aliases: ["new", "template_file"],
      bestFor: ["known templates", "repeatable project-local file generation", "component/action starters"],
      inputSchema: {
        file: fileSchema,
        template: z.string().min(1),
        params: z.union([z.record(z.string(), z.unknown()), z.array(z.string())]).optional(),
        cwd: z.string().optional(),
        overwrite: z.boolean().optional(),
        ...writeFlagSchema,
      },
      handler: runNewFileTool,
    },
    {
      name: "file_write",
      title: "File Write",
      description: "Whole-file generation facade. Required mode: write for complete source writes, scaffold for scaffold specs, or template for project templates. create_file stays separate because no-overwrite creation is a safety boundary.",
      category: "generate",
      aliases: ["write_file", "scaffold_file", "new_file"],
      bestFor: ["whole-file generated content", "scaffolded component skeletons", "template-backed files"],
      inputSchema: {
        mode: z.enum(["write", "scaffold", "template"]).describe("Required. write=complete source, scaffold=tedit scaffold spec/source, template=built-in or local template. Use create_file for must-be-new files."),
        file: fileSchema,
        source: z.string().optional().describe("Required when mode=write, or accepted as scaffold source when mode=scaffold."),
        spec: z.record(z.string(), z.unknown()).optional().describe("Required when mode=scaffold unless source is provided."),
        template: z.string().optional().describe("Required when mode=template."),
        params: z.union([z.record(z.string(), z.unknown()), z.array(z.string())]).optional().describe("Template params for mode=template."),
        cwd: z.string().optional().describe("Template search cwd for mode=template."),
        overwrite: z.boolean().optional().describe("Explicitly allow overwriting an existing file."),
        ...writeFlagSchema,
      },
      handler: runFileWriteTool,
    }
  ] satisfies readonly TeditMcpTool[];
}
