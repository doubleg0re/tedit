import { z } from "zod/v4";
import type { TeditMcpTool } from "../../mcp-tools.js";

// ponytail: explicit any avoids runtime imports from the source module; tighten when dependency typing matters.
export function makeAST_TOOLS(deps: any): readonly TeditMcpTool[] {
  const { detailFlagSchema, fileSchema, runAstEditTool, runAstSelectTool, runTsEditTool, runTsMoveTool, runTsSelectTool, writeFlagSchema } = deps;
  return [
    {
      name: "ast_select",
      title: "AST Select",
      description: "Read-only JS/TS/JSX AST selector. Examples: StringLiteral[value*=\"삭제\"], CallExpression[callee.name=\"alert\"], ObjectProperty[key.name=\"label\"] > StringLiteral.",
      category: "ast",
      aliases: ["ast-select", "code_select"],
      bestFor: ["code AST discovery", "finding call expressions or object values", "narrowing ast_edit targets"],
      inputSchema: {
        file: fileSchema,
        selector: z.string().min(1).describe("AST selector with node type and optional [path=value] filters; supports direct child > combinator."),
        ...detailFlagSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: runAstSelectTool,
    },
    {
      name: "ast_edit",
      title: "AST Edit",
      description: "Safely replace one editable AST string target matched by ast_select. Supports StringLiteral, JSXText, string JSXAttribute/ObjectProperty values, and no-expression TemplateLiteral.",
      category: "ast",
      aliases: ["ast-edit", "string_literal_replace"],
      bestFor: ["safe AST string replacement", "i18n prep edits after scan_strings", "call argument or object label text replacement"],
      inputSchema: {
        file: fileSchema,
        selector: z.string().min(1).optional().describe("AST selector that must match exactly one editable string target."),
        string: z.string().optional().describe("Shortcut for StringLiteral[value=...]."),
        contains: z.string().optional().describe("Shortcut for StringLiteral[value*=...]."),
        jsxText: z.string().optional().describe("Shortcut for JSXText[value*=...]."),
        jsxAttr: z.string().optional().describe("Shortcut for JSXAttribute[name=...]."),
        objectKey: z.string().optional().describe("Shortcut for ObjectProperty[key.name=...]."),
        call: z.string().optional().describe("Shortcut for CallExpression callee string arguments, e.g. alert or toast.error."),
        replace: z.string().describe("Replacement text."),
        ...writeFlagSchema,
      },
      handler: runAstEditTool,
    },
    {
      name: "ts_select",
      title: "TS Select",
      description: "Read-only TS/JS named declaration selector. Examples: fn:apiGateMetadata, class:Server, method:Server.start, prop:configKey, var:cache.",
      category: "ast",
      aliases: ["ts-select", "declaration_select", "code_block_select"],
      bestFor: ["large plain-TS files", "named declaration discovery", "finding exact source ranges before ts_edit or ts_move"],
      inputSchema: {
        file: fileSchema,
        selector: z.string().min(1).optional().describe("Optional declaration selector: fn:name, class:Name, method:Owner.name, prop:name, prop:Owner.name, or var:name."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      handler: runTsSelectTool,
    },
    {
      name: "ts_edit",
      title: "TS Edit",
      description: "Safely edit TS/JS named declarations: replace only the tool-owned block body, or insert source before/after a declaration. Uses source-range patches and parse verification. MCP writes by default; pass dryRun:true to preview.",
      category: "ast",
      aliases: ["ts-edit", "declaration_edit", "body_replace"],
      bestFor: ["large plain-TS files", "function body replacement without authoring outer braces", "insert before/after a named declaration"],
      inputSchema: {
        file: fileSchema,
        selector: z.string().min(1).describe("Declaration selector: fn:name, class:Name, method:Owner.name, prop:name, prop:Owner.name, or var:name."),
        action: z.enum(["replace-body", "insert-before", "insert-after"]).optional().describe("Optional when body, insertBefore, or insertAfter makes the action unambiguous."),
        body: z.string().optional().describe("Replacement for the inside of the target block body. Do not include the outer braces."),
        insertBefore: z.string().optional().describe("Source to insert before the selected declaration."),
        insertAfter: z.string().optional().describe("Source to insert after the selected declaration."),
        ...writeFlagSchema,
      },
      handler: runTsEditTool,
    },
    {
      name: "ts_move",
      title: "TS Move",
      description: "Move a TS/JS named declaration before or after another declaration as a source-range cut/paste with compact carried-trivia hints and take/drop overrides.",
      category: "ast",
      aliases: ["ts-move", "declaration_move", "declaration_reorder"],
      bestFor: ["safe declaration reorder", "moving functions with owned comments", "dry-run trivia review before write"],
      inputSchema: {
        file: fileSchema,
        target: z.string().min(1).describe("Declaration selector to move."),
        before: z.string().min(1).optional().describe("Move target before this declaration selector. Mutually exclusive with after."),
        after: z.string().min(1).optional().describe("Move target after this declaration selector. Mutually exclusive with before."),
        take: z.union([z.string(), z.array(z.string())]).optional().describe("Trivia id or ids to carry in addition to the default."),
        drop: z.union([z.string(), z.array(z.string())]).optional().describe("Trivia id or ids to leave behind from the default carried set."),
        confirmTrivia: z.boolean().optional().describe("Required for writes after reviewing carried/adjacent trivia hints."),
        sourceHash: z.string().optional().describe("Optional source hash from a prior dry-run; rejects stale writes."),
        includeTriviaContent: z.boolean().optional().describe("Include full trivia text, not just compact previews."),
        ...writeFlagSchema,
      },
      handler: runTsMoveTool,
    }
  ] satisfies readonly TeditMcpTool[];
}
