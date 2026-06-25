import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { z } from "zod/v4";
import {
  BASE_ACTIONS,
  parseLineRange,
  parseVerificationFields,
  planBaseEdit,
  verifyParseForFile,
  type BaseEditMutation,
  type BaseFindStrategy,
  type ParseVerificationFields,
} from "./base-edit.js";
import { parseElementShorthand } from "./chain.js";
import { getOptionalAdapterForFile } from "./core/registry.js";
import { runAstEdit as runAstEditEngine, runAstSelect, runScanStrings } from "./ast-tools.js";
import { inspectRange, searchText } from "./search-tools.js";
import { historyTrace } from "./history-tools.js";
import { runTsEdit as runTsEditEngine, runTsMove as runTsMoveEngine, runTsSelect } from "./ts-tools.js";
import { unifiedDiff } from "./diff.js";
import { fail } from "./errors.js";
import { formatAgentResult, outputOptionsFromRecord } from "./output.js";
import { parseMultieditInput, runMultiedit, runMultieditInput } from "./multiedit.js";
import { parsePatchInput, runPatchInput } from "./patch.js";
import { analyzeState, qualityWarnings } from "./quality.js";
import { runRefactorState } from "./refactor-state.js";
import { applyRefactorPlan, buildExtractComponentPlan, buildRefactorStatePlan, writePlanFile } from "./refactor-plan.js";
import type { ExtractOptions, HelperPolicy } from "./extract.js";
import { runWorkspaceFlow, type WorkspaceFlowOptions, type WorkspaceFlowStep } from "./workspace-flow.js";
import { buildScaffoldSource, listTemplates, loadTemplateSpec, parseParams, type ScaffoldSpec } from "./scaffold.js";
import { maybeWriteBackup, resolveWritePolicy, writePolicyReport, type BackupResult } from "./write-policy.js";
import { applyPostVerify, captureRestorePoints, verifySpecFromInput, type RestorePoint } from "./verify-command.js";

export type TeditMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  category?: "edit" | "generate" | "discover" | "jsx" | "ast" | "refactor" | "workflow";
  exposure?: "default" | "advanced";
  action?: string;
  aliases?: readonly string[];
  bestFor?: readonly string[];
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: unknown) => unknown;
};

type JsonRecord = Record<string, unknown>;

type VerifyFileEntry = { file: string } & ParseVerificationFields & { warnings: unknown[] };

type SingleStepConfig = {
  name: string;
  title: string;
  action: string;
  description: string;
  inputSchema: z.ZodRawShape;
  readOnly?: boolean;
  category?: TeditMcpTool["category"];
  exposure?: TeditMcpTool["exposure"];
  aliases?: readonly string[];
  bestFor?: readonly string[];
  buildStep: (input: JsonRecord) => WorkspaceFlowStep;
};

const writeFlagSchema = {
  write: z.boolean().optional().describe("Write changes when true; otherwise git-aware defaults apply."),
  dryRun: z.boolean().optional().describe("Force dry-run mode."),
  backup: z.boolean().optional().describe("Force .tedit.bak backup creation."),
  noBackup: z.boolean().optional().describe("Disable .tedit.bak backup creation."),
  output: z.enum(["compact", "detailed"]).optional().describe("Response shape. MCP defaults to compact; use detailed for legacy full diffs and internals."),
  includeDiffs: z.boolean().optional().describe("Legacy detailed-diff opt-in. Prefer diffMode for compact agent responses."),
  includeDetails: z.boolean().optional().describe("Return the detailed response shape."),
  diffMode: z.enum(["off", "stats", "auto", "full"]).optional().describe("Compact diff payload policy. auto inlines small diffs and spills large write diffs to .tedit-cache/diffs artifacts."),
  inlineDiffMaxBytes: z.number().int().positive().optional().describe("Maximum diff bytes to inline when diffMode is auto."),
  inlineDiffMaxHunks: z.number().int().positive().optional().describe("Maximum hunk count to inline when diffMode is auto."),
  diffArtifactDir: z.string().min(1).optional().describe("Artifact directory for large auto diffs; must stay inside the current working directory."),
  diffArtifacts: z.boolean().optional().describe("Allow large diff artifact writes. Dry-runs only write artifacts when this is explicitly true."),
  verify: z.unknown().optional().describe("Optional post-write verify command: string, argv array, or {cmd, args, timeoutMs, cwd, rollbackOnFail}. Runs only after files are written."),
  verifyCommand: z.unknown().optional().describe("Alias for verify. Prefer verify.cmd as an argv array for safer execution."),
  verify_command: z.unknown().optional().describe("Alias for verifyCommand."),
  rollbackOnVerifyFail: z.boolean().optional().describe("Top-level rollback alias for verify command strings/arrays. Prefer verify.rollbackOnFail."),
  rollback_on_verify_fail: z.boolean().optional().describe("Alias for rollbackOnVerifyFail."),
} satisfies z.ZodRawShape;

const fileSchema = z.string().min(1).describe("Target file path.");
const targetSchema = z.string().min(1).describe("Selector or previously returned node id.");
const selectorSchema = z.string().min(1).describe("Structural selector.");
const valueSchema = z.unknown().describe("Literal value or tedit value spec.");
const elementSchema = z.unknown().describe("Element shorthand string or tree node spec.");

export const TEDIT_MCP_ALL_TOOLS: readonly TeditMcpTool[] = [
  {
    name: "edit",
    title: "Universal Edit",
    description: "Safer replacement for routine Edit calls: exact, fuzzy, anchor, regex, or line-range edits with dry-run, git-aware write policy, parse verification, and retry hints.",
    category: "edit",
    aliases: ["safe_edit", "base_edit", "edit.replace"],
    bestFor: ["single localized text/code edit", "retryable exact/fuzzy match", "line-range or regex replacement"],
    inputSchema: {
      file: fileSchema,
      find: z.string().optional(),
      findExact: z.string().optional(),
      findFuzzy: z.string().optional(),
      findAnchorAfter: z.string().optional(),
      contains: z.string().optional(),
      findRegex: z.string().optional(),
      flags: z.string().optional(),
      findLines: z.string().optional(),
      replace: z.string().optional(),
      insertBefore: z.string().optional(),
      insertAfter: z.string().optional(),
      delete: z.boolean().optional(),
      replaceAll: z.boolean().optional(),
      expectCount: z.number().int().nonnegative().optional(),
      noFuzzyFallback: z.boolean().optional(),
      ...writeFlagSchema,
    },
    handler: runEditTool,
  },
  {
    name: "multiedit",
    title: "Atomic Multiedit",
    description: "Safer replacement for multiple Edit calls: apply many universal base edits atomically across one or more files with parse verification.",
    category: "edit",
    aliases: ["multi_edit", "bulk_edit"],
    bestFor: ["coordinated repeated edits", "same-file sequential edits", "cross-file atomic text changes"],
    inputSchema: {
      edits: z.array(z.record(z.string(), z.unknown())).optional(),
      input: z.string().optional().describe("Raw multiedit JSON string; use when forwarding existing CLI input."),
      ...writeFlagSchema,
    },
    handler: runMultieditTool,
  },
  {
    name: "patch",
    title: "Patch",
    description: "Safer replacement for patch/apply_patch when the change is already a diff: apply unified diff or Codex apply-patch input atomically with verification.",
    category: "edit",
    aliases: ["apply_patch", "unified_diff"],
    bestFor: ["large generated diffs", "file additions/deletions/renames", "Codex apply-patch envelopes"],
    inputSchema: {
      patch: z.string().min(1).describe("Unified diff or apply-patch envelope."),
      ...writeFlagSchema,
    },
    handler: runPatchTool,
  },
  {
    name: "delete_file",
    title: "Delete File",
    description: "Delete one existing file through tedit's atomic workspace transaction and write policy. Use patch for coordinated delete+edit batches.",
    category: "edit",
    aliases: ["file_delete", "remove_file"],
    bestFor: ["deleting generated files", "small rollback cleanup", "dry-run delete confirmation"],
    inputSchema: {
      file: fileSchema,
      ...writeFlagSchema,
    },
    handler: runDeleteFileTool,
  },
  {
    name: "rename_file",
    title: "Rename File",
    description: "Rename one existing file through tedit's atomic workspace transaction and write policy. Use patch for coordinated rename+edit batches.",
    category: "edit",
    aliases: ["file_rename", "move_file"],
    bestFor: ["renaming generated files", "moving one file", "dry-run rename confirmation"],
    inputSchema: {
      file: fileSchema,
      to: z.string().min(1).describe("Destination file path."),
      ...writeFlagSchema,
    },
    handler: runRenameFileTool,
  },
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
  },
  {
    name: "actions",
    title: "Actions",
    description: "List tedit tools/actions plus agent guidance for choosing between native read/edit/write/patch and tedit.",
    category: "discover",
    aliases: ["capabilities", "tool_guide"],
    bestFor: ["tool discovery", "choosing an edit strategy", "checking file-specific rule support"],
    inputSchema: {
      file: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runActionsTool,
  },
  {
    name: "templates",
    title: "Templates",
    description: "Read-only list of built-in, global, and project-local .tedit/templates available for file_write mode=template.",
    category: "discover",
    aliases: ["template_list", "list_templates"],
    bestFor: ["discovering scaffold templates", "checking project conventions before file generation", "choosing file_write mode=template"],
    inputSchema: {
      cwd: z.string().optional().describe("Project directory used to resolve .tedit/templates. Defaults to process cwd."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runTemplatesTool,
  },
  {
    name: "inspect_range",
    title: "Inspect Range",
    description: "Read-only line/context inspection for sed-style workflows. Returns line objects, byte range, parse status, and edit-ready suggestions.",
    category: "discover",
    aliases: ["inspect-range", "range_context", "sed_range"],
    bestFor: ["viewing line context", "turning a line range into edit findLines", "checking parser status around a target"],
    inputSchema: {
      file: fileSchema,
      lines: z.string().min(1).describe("Line range such as 42 or 40:50."),
      context: z.number().int().nonnegative().optional().describe("Additional lines before and after the requested range."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runInspectRangeTool,
  },
  {
    name: "search_text",
    title: "Search Text",
    description: "Read-only text search bridge for rg/grep workflows. Returns structured candidates with line/byte ranges and inspect/edit follow-ups.",
    category: "discover",
    aliases: ["search-text", "grep_text", "text_search"],
    bestFor: ["raw text discovery", "grep then edit workflows", "finding literal or regex matches across files"],
    inputSchema: {
      query: z.string().min(1).describe("Literal search text or regex pattern when regex=true."),
      paths: z.array(z.string().min(1)).optional().describe("Files or directories to search. Defaults to cwd."),
      path: z.string().min(1).optional().describe("Single file or directory alias for paths."),
      regex: z.boolean().optional().describe("Treat query as a JavaScript regular expression."),
      glob: z.string().optional().describe("Simple glob filter, e.g. **/*.tsx."),
      context: z.number().int().nonnegative().optional().describe("Additional context lines before and after each result."),
      multieditSpec: z.boolean().optional().describe("Also return a file-grouped multiedit spec for replacing the matched query."),
      replace: z.string().optional().describe("Replacement text for multieditSpec. Defaults to a placeholder."),
      maxResults: z.number().int().positive().optional().describe("Maximum result count. Defaults to 100."),
      caseSensitive: z.boolean().optional().describe("Use case-sensitive matching. Literal and regex searches default to case-insensitive."),
      includeHidden: z.boolean().optional().describe("Include hidden files and directories except built-in excluded directories."),
      output: z.enum(["compact", "detailed"]).optional().describe("Response shape. Defaults to compact; detailed includes full per-result context and suggestions."),
      includeDetails: z.boolean().optional().describe("Return the detailed response shape."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runSearchTextTool,
  },
  {
    name: "history_trace",
    title: "History Trace",
    description: "Read-only git history trace. Uses blame/log -L for line ranges and log -S/-G for text or regex history.",
    category: "discover",
    aliases: ["history-trace", "git_history", "trace_history"],
    bestFor: ["checking when code changed", "understanding why a line exists before editing", "finding commits that introduced text"],
    inputSchema: {
      file: fileSchema,
      lines: z.string().optional().describe("Line range such as 42 or 40:50. Uses git blame and git log -L."),
      contains: z.string().optional().describe("Literal text to trace with git log -S."),
      regex: z.string().optional().describe("Regex to trace with git log -G."),
      limit: z.number().int().positive().optional().describe("Maximum commits to return. Defaults to 10."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runHistoryTraceTool,
  },
  {
    name: "scan_strings",
    title: "Scan Strings",
    description: "Read-only JS/TS/JSX AST string scanner for hardcoded user-facing text. Covers JSX text/attrs, string literals, object values, and simple template literals while excluding obvious technical strings by default.",
    category: "ast",
    aliases: ["scan-strings", "hardcoded_text", "i18n_scan"],
    bestFor: ["hardcoded text inventory", "i18n preparation", "finding JS/TS strings beyond JSX selectors"],
    inputSchema: {
      file: fileSchema,
      contains: z.string().optional().describe("Only return strings containing this text."),
      includeExcluded: z.boolean().optional().describe("Include technical strings that are normally excluded, with excludeReason."),
      minLength: z.number().int().positive().optional().describe("Minimum string length. Defaults to 1."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runScanStringsTool,
  },
  {
    name: "select",
    title: "Universal Select",
    description: "Read-only facade that routes selection by file type: TS/JS declarations, JSX/TSX elements, or text fallback with one common response shape.",
    category: "discover",
    aliases: ["smart_select", "find_symbol", "select_node"],
    bestFor: ["one entrypoint before edit", "TS/JS/JSX/TSX target discovery", "choosing the safest follow-up edit route"],
    inputSchema: {
      file: fileSchema,
      selector: z.string().min(1).optional().describe("Common selector/name/query. Examples: LoginButton, fn:start, class:Server, button.primary, 삭제."),
      name: z.string().min(1).optional().describe("Alias for selector when selecting a named declaration or JSX element."),
      contains: z.string().min(1).optional().describe("Text fallback query or secondary filter for previews."),
      kind: z.enum(["auto", "function", "class", "method", "prop", "var", "import", "jsx", "text"]).optional().describe("Optional route hint. Defaults to auto."),
      context: z.number().int().nonnegative().optional().describe("Context lines for text fallback."),
      maxResults: z.number().int().positive().optional().describe("Maximum normalized matches to return."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runSelectTool,
  },
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
    description: "Safely edit TS/JS named declarations: replace only the tool-owned block body, or insert source before/after a declaration. Uses source-range patches and parse verification.",
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
  },
  {
    name: "refactor",
    title: "Refactor",
    description: "Small facade for existing refactor workflows. kind=state applies or plans refactor-state; kind=extract extracts or plans JSX component extraction; kind=apply-plan applies a saved plan.",
    category: "refactor",
    aliases: ["refactor_state", "extract_component", "apply_plan"],
    bestFor: ["agent default access to CLI refactors", "React state refactors", "JSX component extraction", "reviewable refactor plans"],
    inputSchema: {
      kind: z.enum(["state", "refactor-state", "extract", "extract-component", "apply-plan"]).describe("Which existing refactor workflow to run."),
      mode: z.enum(["apply", "plan", "direct"]).optional().describe("state: apply/plan. extract: direct/plan. apply-plan ignores mode."),
      file: z.string().optional().describe("State refactor source file, or apply-plan alias for plan."),
      plan: z.string().optional().describe("Plan path for kind=apply-plan."),
      path: z.string().optional().describe("Plan path alias for kind=apply-plan."),
      planOut: z.string().optional().describe("Required for mode=plan."),
      cluster: z.string().optional(),
      to: z.string().optional(),
      name: z.string().optional(),
      externalDeps: z.enum(["fail", "params"]).optional(),
      from: fileSchema.optional().describe("Source JSX/TSX file for kind=extract."),
      selector: selectorSchema.optional().describe("JSX selector for kind=extract."),
      overwrite: z.boolean().optional(),
      only: z.union([z.string(), z.array(z.string())]).optional(),
      skip: z.union([z.string(), z.array(z.string())]).optional(),
      ...writeFlagSchema,
    },
    handler: runRefactorTool,
  },
  {
    name: "analyze_state",
    title: "Analyze State",
    description: "Analyze React useState clusters and refactor recommendations without modifying files.",
    category: "refactor",
    bestFor: ["React state cleanup", "finding custom hook candidates", "pre-refactor inspection"],
    inputSchema: {
      file: fileSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runAnalyzeStateTool,
  },
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
  },

  {
    name: "refactor_state",
    title: "Refactor State",
    description: "Apply tedit's React state refactor helper, including custom hook extraction, with dry-run and write policy.",
    category: "refactor",
    aliases: ["react_state_refactor"],
    bestFor: ["object-state grouping", "custom hook extraction", "React state refactors"],
    inputSchema: {
      mode: z.enum(["apply", "plan"]).optional().describe("Prefer explicit mode. apply runs the refactor with dry-run/write policy; plan writes a reviewable plan and requires planOut."),
      file: fileSchema,
      planOut: z.string().optional().describe("Required when mode=plan."),
      cluster: z.string().optional(),
      to: z.string().optional(),
      name: z.string().optional(),
      externalDeps: z.enum(["fail", "params"]).optional(),
      overwrite: z.boolean().optional(),
      ...writeFlagSchema,
    },
    handler: runRefactorStateTool,
  },
  {
    name: "refactor_state_plan",
    title: "Refactor State Plan",
    description: "Generate a reviewable refactor-state plan file without changing source files.",
    category: "refactor",
    exposure: "advanced",
    aliases: ["refactor-state --plan-out"],
    bestFor: ["review-before-apply state refactors", "custom hook extraction planning", "step-gated React state cleanup"],
    inputSchema: {
      file: fileSchema,
      planOut: z.string().min(1),
      cluster: z.string().optional(),
      to: z.string().optional(),
      name: z.string().optional(),
      externalDeps: z.enum(["fail", "params"]).optional(),
      overwrite: z.boolean().optional(),
    },
    handler: runRefactorStatePlanTool,
  },
  {
    name: "extract_plan",
    title: "Extract Plan",
    description: "Plan a JSX component extraction without changing source files. Use before apply_plan for large/risky extracts, helper movement, or any extraction the agent/user should review before writes.",
    category: "refactor",
    exposure: "advanced",
    aliases: ["extract --plan-out", "plan_extract"],
    bestFor: ["review-before-apply extract workflows", "large JSX component extraction", "helper movement decisions", "step-gated refactors"],
    inputSchema: {
      from: fileSchema.describe("Source JSX/TSX file containing the component subtree to extract."),
      selector: selectorSchema.describe("CSS-like selector for the JSX subtree to extract, e.g. Card, DialogFooter > Button, main > section:has(> h2)."),
      to: z.string().min(1).describe("Destination component file to create or overwrite when the plan is later applied."),
      name: z.string().min(1).describe("New component name to generate and import at the call site."),
      planOut: z.string().min(1).describe("Plan JSON path to write. apply_plan consumes this path later."),
      export: z.enum(["named", "default"]).optional().describe("Generated component export style. Defaults to named."),
      exportKind: z.enum(["named", "default"]).optional().describe("Alias for export. Defaults to named."),
      slots: z.unknown().optional().describe("Slot selectors such as ['CardBody.children'] or ['CardHeader.children=header'] to leave selected children at the call site."),
      slot: z.unknown().optional().describe("Single slot or repeated slot input; same semantics as slots."),
      depth: z.number().int().optional().describe("Ask tedit to suggest slot boundaries at this depth. Requires autoSlot to accept suggestions automatically."),
      autoSlot: z.boolean().optional().describe("Accept depth-generated slot suggestions intentionally."),
      helpers: z.string().optional().describe("Default helper policy: ask, move, share, or as-prop."),
      helpersPolicy: z.string().optional().describe("Alias for helpers: ask, move, share, or as-prop."),
      helper: z.unknown().optional().describe("Per-helper override such as helperName=as-prop, helperName=move, helperName=share, or helperName=leave."),
      helperOverrides: z.unknown().optional().describe("Per-helper overrides; same semantics as helper."),
      overwrite: z.boolean().optional().describe("Allow the eventual destination file to overwrite an existing file."),
      typecheck: z.boolean().optional().describe("Use the local TypeScript checker for stronger prop type inference when available."),
      maxProps: z.number().int().optional().describe("Run-specific maximum generated prop count before tedit refuses the extraction."),
      acceptLargeProps: z.boolean().optional().describe("Explicitly accept an extraction whose generated prop count exceeds the configured threshold."),
    },
    handler: runExtractPlanTool,
  },
  {
    name: "apply_plan",
    title: "Apply Plan",
    description: "Validate and apply a plan created by extract_plan or refactor_state_plan. Dry-run by default; pass write:true to persist after reviewing the plan/result.",
    category: "refactor",
    aliases: ["apply-plan", "apply_extract_plan", "apply_refactor_plan"],
    bestFor: ["accepted plan application", "partial extract apply", "extract plan execution", "refactor-state plan execution"],
    inputSchema: {
      plan: z.string().min(1).optional().describe("Plan JSON path from extract_plan or refactor_state_plan."),
      file: z.string().min(1).optional().describe("Alias for plan."),
      path: z.string().min(1).optional().describe("Alias for plan."),
      only: z.union([z.string(), z.array(z.string())]).optional().describe("Apply only selected plan step ids."),
      skip: z.union([z.string(), z.array(z.string())]).optional().describe("Skip selected plan step ids. For extract plans, skipping move-helper-* can force prop fallback."),
      overwrite: z.boolean().optional().describe("Allow destination overwrite when the plan supports it."),
      ...writeFlagSchema,
    },
    handler: runApplyPlanTool,
  },

  {
    name: "chain_workspace",
    title: "Workspace Chain",
    description: "Run multi-file structural workflow steps atomically. Use when an agent needs extract plus follow-up mutations on the created file or coordinated edits across files.",
    category: "workflow",
    aliases: ["workspace_flow", "chain"],
    bestFor: ["extract then mutate generated component", "multi-step structural edits", "find-then-mutate flows", "cross-file JSX workflows"],
    inputSchema: {
      steps: z.array(z.record(z.string(), z.unknown())).optional().describe("Workspace-flow steps. Can include {action:'extract', from, selector, to, name} and per-file chain/edit steps."),
      flow: z.array(z.record(z.string(), z.unknown())).optional().describe("Alias for steps."),
      params: z.record(z.string(), z.unknown()).optional().describe("Optional flow parameters for templated workspace flows."),
      ...writeFlagSchema,
    },
    handler: runWorkspaceTool,
  },
  {
    name: "jsx_select",
    title: "JSX Select",
    description: "Read-only JSX selector facade. action=find returns matching node ids/previews; action=inspect returns one node's details. Both are safe discovery operations.",
    category: "jsx",
    aliases: ["find", "inspect"],
    bestFor: ["selector discovery", "inspecting JSX nodes before mutation", "getting stable target ids"],
    inputSchema: {
      action: z.enum(["find", "inspect"]).describe("Required. find lists matching nodes; inspect returns details for one selector/id."),
      file: fileSchema,
      selector: selectorSchema.optional().describe("Required for action=find; accepted for action=inspect."),
      target: targetSchema.optional().describe("Selector or returned id for action=inspect."),
      id: targetSchema.optional().describe("Returned node id for action=inspect."),
      all: z.boolean().optional().describe("For action=find, return all matches when supported."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: runJsxSelectTool,
  },
  {
    name: "jsx_node",
    title: "JSX Node",
    description: "JSX node mutation facade. Required action. append/prepend require element; wrap requires with/wrapper; rename requires to/name; insert_comment requires text.",
    category: "jsx",
    aliases: ["append", "prepend", "wrap", "unwrap", "remove", "rename", "insert_comment"],
    bestFor: ["structural JSX node edits", "wrapping/removing/renaming JSX", "comment insertion"],
    inputSchema: {
      action: z.enum(["append", "prepend", "wrap", "unwrap", "remove", "rename", "insert_comment"]).describe("Required node operation."),
      file: fileSchema,
      selector: selectorSchema.optional(),
      target: targetSchema.optional(),
      id: targetSchema.optional(),
      element: elementSchema.optional().describe("Required for action=append or action=prepend."),
      with: elementSchema.optional().describe("Required for action=wrap; wrapper shorthand/object."),
      wrapper: elementSchema.optional().describe("Alias for with when action=wrap."),
      to: z.string().optional().describe("Required for action=rename unless name is supplied."),
      name: z.string().optional().describe("Alias for to when action=rename."),
      text: z.string().optional().describe("Required for action=insert_comment."),
      position: z.string().optional().describe("Optional insert_comment position: inside-start, inside-end, before, or after."),
      ...writeFlagSchema,
    },
    handler: runJsxNodeTool,
  },
  {
    name: "jsx_attr",
    title: "JSX Attr",
    description: "JSX prop/class mutation facade. Required action. prop_set/remove use name/value/expr; class_add/remove use classes; class_replace uses from/to.",
    category: "jsx",
    aliases: ["prop_set", "prop_remove", "class_add", "class_remove", "class_replace"],
    bestFor: ["JSX prop edits", "static className token edits", "attribute-level changes"],
    inputSchema: {
      action: z.enum(["prop_set", "prop_remove", "class_add", "class_remove", "class_replace"]).describe("Required attr/class operation."),
      file: fileSchema,
      selector: selectorSchema.optional(),
      target: targetSchema.optional(),
      id: targetSchema.optional(),
      name: z.string().optional().describe("Required for prop_set and prop_remove."),
      value: valueSchema.optional().describe("Optional prop_set value; defaults to true when expr is omitted."),
      expr: z.string().optional().describe("Optional prop_set expression value."),
      classes: z.union([z.string(), z.array(z.string())]).optional().describe("Required for class_add and class_remove."),
      from: z.string().optional().describe("Required for class_replace."),
      to: z.string().optional().describe("Required for class_replace."),
      ...writeFlagSchema,
    },
    handler: runJsxAttrTool,
  },
  {
    name: "jsx_content",
    title: "JSX Content",
    description: "JSX text/expression mutation facade. Required action. text_set needs value or expr; text_replace needs match/with fields; expr_replace/wrap need code.",
    category: "jsx",
    aliases: ["text_set", "text_replace", "expr_replace", "expr_wrap", "expr_unwrap", "expr_to_ternary", "expr_to_short_circuit"],
    bestFor: ["text child replacement", "expression container edits", "ternary/short-circuit conversions"],
    inputSchema: {
      action: z.enum(["text_set", "text_replace", "expr_replace", "expr_wrap", "expr_unwrap", "expr_to_ternary", "expr_to_short_circuit"]).describe("Required content/expression operation."),
      file: fileSchema,
      selector: selectorSchema.optional(),
      target: targetSchema.optional(),
      id: targetSchema.optional(),
      value: z.string().optional().describe("text_set value or expr_to_ternary alternate alias."),
      expr: z.string().optional().describe("text_set expression value."),
      match: z.unknown().optional().describe("text_replace match spec."),
      matchText: z.string().optional(),
      matchExpr: z.string().optional(),
      matchAny: z.string().optional(),
      with: z.unknown().optional().describe("text_replace replacement spec."),
      withText: z.string().optional(),
      withExpr: z.string().optional(),
      code: z.string().optional().describe("Required for expr_replace and expr_wrap."),
      alternate: z.string().optional().describe("Optional expr_to_ternary alternate."),
      ...writeFlagSchema,
    },
    handler: runJsxContentTool,
  },
  {
    name: "imports",
    title: "Imports",
    description: "Import declaration facade. Required action: add, remove, rename, or move. rename requires name and to; move requires to.",
    category: "jsx",
    aliases: ["imports_add", "imports_remove", "imports_rename", "imports_move"],
    bestFor: ["adding imports", "removing imports", "renaming or moving import specifiers"],
    inputSchema: {
      action: z.enum(["add", "remove", "rename", "move"]).describe("Required import operation."),
      ...importsSchema(),
    },
    handler: runImportsTool,
  },
  {
    name: "extract_component",
    title: "Extract Component",
    description: "JSX component extraction facade. mode=plan writes a reviewable plan and requires planOut; mode=direct runs the extraction through workspace-flow dry-run/write policy.",
    category: "refactor",
    aliases: ["extract", "extract_plan", "component_extract"],
    bestFor: ["component extraction", "reviewable extract plans", "small direct extract dry-runs"],
    inputSchema: {
      mode: z.enum(["plan", "direct"]).describe("Required. plan writes a reviewable plan; direct runs extraction with dry-run/write policy."),
      from: fileSchema.describe("Source JSX/TSX file containing the subtree to extract."),
      selector: selectorSchema.describe("CSS-like selector for the JSX subtree to extract."),
      to: z.string().min(1).describe("Destination component file."),
      name: z.string().min(1).describe("New component name."),
      planOut: z.string().optional().describe("Required when mode=plan."),
      export: z.enum(["named", "default"]).optional(),
      exportKind: z.enum(["named", "default"]).optional(),
      slots: z.unknown().optional(),
      slot: z.unknown().optional(),
      depth: z.number().int().optional(),
      autoSlot: z.boolean().optional(),
      helpers: z.string().optional(),
      helpersPolicy: z.string().optional(),
      helper: z.unknown().optional(),
      helperOverrides: z.unknown().optional(),
      overwrite: z.boolean().optional(),
      typecheck: z.boolean().optional(),
      maxProps: z.number().int().optional(),
      acceptLargeProps: z.boolean().optional(),
      ...writeFlagSchema,
    },
    handler: runExtractComponentTool,
  },
  singleStepTool({
    name: "find",
    title: "Find JSX Node",
    action: "find",
    description: "Find structural nodes by selector and return ids for later tedit mutations.",
    readOnly: true,
    inputSchema: { file: fileSchema, selector: selectorSchema, all: z.boolean().optional() },
    buildStep: (input) => ({ action: "find", file: requiredString(input.file, "find requires file."), selector: requiredString(input.selector, "find requires selector."), all: booleanValue(input.all) }),
  }),
  singleStepTool({
    name: "inspect",
    title: "Inspect JSX Node",
    action: "inspect",
    description: "Inspect a structural node by selector or id after native Read or find.",
    readOnly: true,
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional() },
    buildStep: (input) => ({ action: "inspect", file: requiredString(input.file, "inspect requires file."), target: targetFromInput(input, "inspect") }),
  }),
  singleStepTool({
    name: "append",
    title: "Append JSX Element",
    action: "append",
    description: "Append an element inside a selected JSX node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), element: elementSchema, ...writeFlagSchema },
    buildStep: (input) => ({ action: "append", file: requiredString(input.file, "append requires file."), target: targetFromInput(input, "append"), element: normalizeElementInput(input.element, "append requires element.") }),
  }),
  singleStepTool({
    name: "prepend",
    title: "Prepend JSX Element",
    action: "prepend",
    description: "Prepend an element inside a selected JSX node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), element: elementSchema, ...writeFlagSchema },
    buildStep: (input) => ({ action: "prepend", file: requiredString(input.file, "prepend requires file."), target: targetFromInput(input, "prepend"), element: normalizeElementInput(input.element, "prepend requires element.") }),
  }),
  singleStepTool({
    name: "wrap",
    title: "Wrap JSX Node",
    action: "wrap",
    description: "Wrap a selected JSX node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), with: elementSchema, ...writeFlagSchema },
    buildStep: (input) => ({ action: "wrap", file: requiredString(input.file, "wrap requires file."), target: targetFromInput(input, "wrap"), with: normalizeElementInput(input.with, "wrap requires with.") }),
  }),
  singleStepTool({
    name: "unwrap",
    title: "Unwrap JSX Node",
    action: "unwrap",
    description: "Remove a JSX wrapper while keeping children.",
    inputSchema: targetOnlySchema(),
    buildStep: (input) => ({ action: "unwrap", file: requiredString(input.file, "unwrap requires file."), target: targetFromInput(input, "unwrap") }),
  }),
  singleStepTool({
    name: "remove",
    title: "Remove JSX Node",
    action: "remove",
    description: "Remove a selected JSX node.",
    inputSchema: targetOnlySchema(),
    buildStep: (input) => ({ action: "remove", file: requiredString(input.file, "remove requires file."), target: targetFromInput(input, "remove") }),
  }),
  singleStepTool({
    name: "rename",
    title: "Rename JSX Element",
    action: "rename",
    description: "Rename a selected JSX element tag.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), to: z.string().optional(), name: z.string().optional(), ...writeFlagSchema },
    buildStep: (input) => ({ action: "rename", file: requiredString(input.file, "rename requires file."), target: targetFromInput(input, "rename"), name: requiredString(pick(input, "to", "name"), "rename requires to or name.") }),
  }),
  singleStepTool({
    name: "prop_set",
    title: "Set JSX Prop",
    action: "prop.set",
    description: "Set a JSX prop on a selected node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), name: z.string().min(1), value: valueSchema.optional(), expr: z.string().optional(), ...writeFlagSchema },
    buildStep: (input) => ({ action: "prop.set", file: requiredString(input.file, "prop_set requires file."), target: targetFromInput(input, "prop_set"), name: requiredString(input.name, "prop_set requires name."), value: propValue(input) }),
  }),
  singleStepTool({
    name: "prop_remove",
    title: "Remove JSX Prop",
    action: "prop.remove",
    description: "Remove a JSX prop from a selected node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), name: z.string().min(1), ...writeFlagSchema },
    buildStep: (input) => ({ action: "prop.remove", file: requiredString(input.file, "prop_remove requires file."), target: targetFromInput(input, "prop_remove"), name: requiredString(input.name, "prop_remove requires name.") }),
  }),
  singleStepTool({
    name: "class_add",
    title: "Add JSX Class",
    action: "class.add",
    description: "Add one or more static className tokens to a selected JSX node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), classes: z.union([z.string(), z.array(z.string())]), ...writeFlagSchema },
    buildStep: (input) => ({ action: "class.add", file: requiredString(input.file, "class_add requires file."), target: targetFromInput(input, "class_add"), classes: classNamesInput(input, "class_add") }),
  }),
  singleStepTool({
    name: "class_remove",
    title: "Remove JSX Class",
    action: "class.remove",
    description: "Remove one or more static className tokens from a selected JSX node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), classes: z.union([z.string(), z.array(z.string())]), ...writeFlagSchema },
    buildStep: (input) => ({ action: "class.remove", file: requiredString(input.file, "class_remove requires file."), target: targetFromInput(input, "class_remove"), classes: classNamesInput(input, "class_remove") }),
  }),
  singleStepTool({
    name: "class_replace",
    title: "Replace JSX Class",
    action: "class.replace",
    description: "Replace a static className token on a selected JSX node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), from: z.string().min(1), to: z.string().min(1), ...writeFlagSchema },
    buildStep: (input) => ({ action: "class.replace", file: requiredString(input.file, "class_replace requires file."), target: targetFromInput(input, "class_replace"), from: requiredString(input.from, "class_replace requires from."), to: requiredString(input.to, "class_replace requires to.") }),
  }),
  singleStepTool({
    name: "text_set",
    title: "Set JSX Text",
    action: "text.set",
    description: "Replace all children of a selected node with text or an expression.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), value: z.string().optional(), expr: z.string().optional(), ...writeFlagSchema },
    buildStep: (input) => ({ action: "text.set", file: requiredString(input.file, "text_set requires file."), target: targetFromInput(input, "text_set"), ...textSetValue(input) }),
  }),
  singleStepTool({
    name: "text_replace",
    title: "Replace JSX Text",
    action: "text.replace",
    description: "Replace matching direct JSX text/expression children.",
    inputSchema: {
      file: fileSchema,
      selector: selectorSchema.optional(),
      target: targetSchema.optional(),
      id: targetSchema.optional(),
      match: z.unknown().optional(),
      matchText: z.string().optional(),
      matchExpr: z.string().optional(),
      matchAny: z.string().optional(),
      with: z.unknown().optional(),
      withText: z.string().optional(),
      withExpr: z.string().optional(),
      ...writeFlagSchema,
    },
    buildStep: (input) => ({ action: "text.replace", file: requiredString(input.file, "text_replace requires file."), target: targetFromInput(input, "text_replace"), match: textMatch(input) as WorkspaceFlowStep["match"], with: textReplacement(input) as WorkspaceFlowStep["with"] }),
  }),
  singleStepTool({
    name: "insert_comment",
    title: "Insert JSX Comment",
    action: "insertComment",
    description: "Insert a JSX comment around or inside a selected node.",
    inputSchema: { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), text: z.string().min(1), position: z.string().optional(), ...writeFlagSchema },
    buildStep: (input) => ({ action: "insertComment", file: requiredString(input.file, "insert_comment requires file."), target: targetFromInput(input, "insert_comment"), text: requiredString(input.text, "insert_comment requires text."), ...(input.position === undefined ? {} : { position: String(input.position) as WorkspaceFlowStep["position"] }) }),
  }),
  singleStepTool({
    name: "imports_add",
    title: "Add Import",
    action: "imports.add",
    description: "Add or merge an import declaration.",
    inputSchema: importsSchema(),
    buildStep: (input) => ({ action: "imports.add", file: requiredString(input.file, "imports_add requires file."), ...importFields(input) }),
  }),
  singleStepTool({
    name: "imports_remove",
    title: "Remove Import",
    action: "imports.remove",
    description: "Remove import specifiers or declarations.",
    inputSchema: importsSchema(),
    buildStep: (input) => ({ action: "imports.remove", file: requiredString(input.file, "imports_remove requires file."), ...importFields(input) }),
  }),
  singleStepTool({
    name: "imports_rename",
    title: "Rename Import",
    action: "imports.rename",
    description: "Rename an imported binding.",
    inputSchema: importsSchema({ requireName: true, requireTo: true }),
    buildStep: (input) => ({ action: "imports.rename", file: requiredString(input.file, "imports_rename requires file."), ...importFields(input) }),
  }),
  singleStepTool({
    name: "imports_move",
    title: "Move Import",
    action: "imports.move",
    description: "Move an import to a different source module.",
    inputSchema: importsSchema({ requireTo: true }),
    buildStep: (input) => ({ action: "imports.move", file: requiredString(input.file, "imports_move requires file."), ...importFields(input) }),
  }),
  singleStepTool({
    name: "expr_replace",
    title: "Replace JSX Expression",
    action: "expr.replace",
    description: "Replace a selected JSX expression container.",
    inputSchema: exprSchema({ code: true }),
    buildStep: (input) => ({ action: "expr.replace", file: requiredString(input.file, "expr_replace requires file."), target: targetFromInput(input, "expr_replace"), code: requiredString(input.code, "expr_replace requires code.") }),
  }),
  singleStepTool({
    name: "expr_wrap",
    title: "Wrap JSX Expression",
    action: "expr.wrap",
    description: "Wrap a selected JSX expression with code containing $expr.",
    inputSchema: exprSchema({ code: true }),
    buildStep: (input) => ({ action: "expr.wrap", file: requiredString(input.file, "expr_wrap requires file."), target: targetFromInput(input, "expr_wrap"), code: requiredString(input.code, "expr_wrap requires code.") }),
  }),
  singleStepTool({
    name: "expr_unwrap",
    title: "Unwrap JSX Expression",
    action: "expr.unwrap",
    description: "Unwrap a selected JSX expression.",
    inputSchema: exprSchema(),
    buildStep: (input) => ({ action: "expr.unwrap", file: requiredString(input.file, "expr_unwrap requires file."), target: targetFromInput(input, "expr_unwrap") }),
  }),
  singleStepTool({
    name: "expr_to_ternary",
    title: "Convert Expression To Ternary",
    action: "expr.toTernary",
    description: "Convert a selected short-circuit expression to a ternary.",
    inputSchema: { ...exprSchema(), alternate: z.string().optional(), value: z.string().optional() },
    buildStep: (input) => ({ action: "expr.toTernary", file: requiredString(input.file, "expr_to_ternary requires file."), target: targetFromInput(input, "expr_to_ternary"), ...(pick(input, "alternate", "value") === undefined ? {} : { value: String(pick(input, "alternate", "value")) }) }),
  }),
  singleStepTool({
    name: "expr_to_short_circuit",
    title: "Convert Expression To Short Circuit",
    action: "expr.toShortCircuit",
    description: "Convert a selected ternary expression to a short-circuit expression.",
    inputSchema: exprSchema(),
    buildStep: (input) => ({ action: "expr.toShortCircuit", file: requiredString(input.file, "expr_to_short_circuit requires file."), target: targetFromInput(input, "expr_to_short_circuit") }),
  }),
  {
    name: "extract",
    title: "Extract JSX Component",
    description: "Directly extract a JSX subtree into a new component file. Required: from, selector, to, name. Dry-run by default; pass write:true to persist. For large/risky extracts use extract_plan then apply_plan; for extract plus follow-up edits use chain_workspace.",
    category: "refactor",
    exposure: "advanced",
    aliases: ["extract_component", "component_extract"],
    bestFor: ["small confident JSX component extraction", "single-step component extraction", "dry-run extraction preview"],
    inputSchema: {
      from: fileSchema.describe("Source JSX/TSX file containing the component subtree to extract."),
      selector: selectorSchema.describe("CSS-like selector for the JSX subtree to extract, e.g. Card, DialogFooter > Button, main > section:has(> h2)."),
      to: z.string().min(1).describe("Destination component file to create."),
      name: z.string().min(1).describe("New component name to generate and import at the call site."),
      export: z.enum(["named", "default"]).optional().describe("Generated component export style. Defaults to named."),
      exportKind: z.enum(["named", "default"]).optional().describe("Alias for export. Defaults to named."),
      slots: z.unknown().optional().describe("Slot selectors such as ['CardBody.children'] or ['CardHeader.children=header'] to leave selected children at the call site."),
      slot: z.unknown().optional().describe("Single slot or repeated slot input; same semantics as slots."),
      depth: z.number().int().optional().describe("Ask tedit to suggest slot boundaries at this depth. Requires autoSlot to accept suggestions automatically."),
      autoSlot: z.boolean().optional().describe("Accept depth-generated slot suggestions intentionally."),
      helpers: z.string().optional().describe("Default helper policy: ask, move, share, or as-prop."),
      helpersPolicy: z.string().optional().describe("Alias for helpers: ask, move, share, or as-prop."),
      helper: z.unknown().optional().describe("Per-helper override such as helperName=as-prop, helperName=move, helperName=share, or helperName=leave."),
      helperOverrides: z.unknown().optional().describe("Per-helper overrides; same semantics as helper."),
      overwrite: z.boolean().optional().describe("Allow overwriting the destination file if it already exists."),
      typecheck: z.boolean().optional().describe("Use the local TypeScript checker for stronger prop type inference when available."),
      maxProps: z.number().int().optional().describe("Run-specific maximum generated prop count before tedit refuses the extraction."),
      acceptLargeProps: z.boolean().optional().describe("Explicitly accept an extraction whose generated prop count exceeds the configured threshold."),
      ...writeFlagSchema,
    },
    handler: runExtractTool,
  },
];

export type TeditMcpProfile = "agent" | "all";

const AGENT_MCP_TOOL_NAMES = new Set([
  "actions",
  "select",
  "edit",
  "multiedit",
  "patch",
  "delete_file",
  "rename_file",
  "ts_select",
  "ts_edit",
  "ts_move",
  "file_write",
  "inspect_range",
  "search_text",
  "verify_file",
  "refactor",
]);

export function teditMcpProfileFromEnv(env: NodeJS.ProcessEnv = process.env): TeditMcpProfile {
  return env.TEDIT_MCP_PROFILE === "all" || env.TEDIT_MCP_EXPOSE_ADVANCED === "true" ? "all" : "agent";
}

export function toolsForMcpProfile(profile: TeditMcpProfile = teditMcpProfileFromEnv()): readonly TeditMcpTool[] {
  return profile === "all" ? TEDIT_MCP_ALL_TOOLS : TEDIT_MCP_ALL_TOOLS.filter((tool) => toolExposure(tool) === "default");
}

export const TEDIT_MCP_TOOLS: readonly TeditMcpTool[] = toolsForMcpProfile();
export const TEDIT_MCP_TOOL_NAMES = TEDIT_MCP_ALL_TOOLS.map((tool) => tool.name);

export function runMcpTool(name: string, args: unknown): unknown {
  const tool = TEDIT_MCP_ALL_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) fail("UNKNOWN_MCP_TOOL", `Unknown tedit MCP tool: ${name}`, { tools: TEDIT_MCP_TOOL_NAMES });
  return tool.handler(args);
}

function runCreateFileTool(args: unknown): unknown {
  const input = recordInput(args, "create_file");
  return runWholeFileTool(input, "create_file", "create", requiredString(input.source, "create_file requires source."));
}

function runWriteFileTool(args: unknown): unknown {
  const input = recordInput(args, "write_file");
  return runWholeFileTool(input, "write_file", "write", requiredString(input.source, "write_file requires source."));
}

function runScaffoldFileTool(args: unknown): unknown {
  const input = recordInput(args, "scaffold_file");
  const spec = scaffoldSpecFromInput(input);
  return runWholeFileTool(input, "scaffold_file", "scaffold", buildScaffoldSource(spec), { spec });
}

function runNewFileTool(args: unknown): unknown {
  const input = recordInput(args, "new_file");
  const template = requiredString(input.template, "new_file requires template.");
  const spec = loadTemplateSpec(template, templateParamsFromInput(input.params), optionalString(input.cwd) ?? process.cwd());
  return runWholeFileTool(input, "new_file", "new", buildScaffoldSource(spec), { template, spec });
}

function runFileWriteTool(args: unknown): unknown {
  const input = recordInput(args, "file_write");
  const mode = requiredString(input.mode, "file_write requires mode: write, scaffold, or template.");
  if (mode === "write") {
    return runWholeFileTool(input, "file_write", "write", requiredString(input.source, "file_write mode=write requires source."));
  }
  if (mode === "scaffold") {
    const spec = scaffoldSpecFromInput(input, "file_write mode=scaffold");
    return runWholeFileTool(input, "file_write", "scaffold", buildScaffoldSource(spec), { spec });
  }
  if (mode === "template") {
    const template = requiredString(input.template, "file_write mode=template requires template.");
    const spec = loadTemplateSpec(template, templateParamsFromInput(input.params), optionalString(input.cwd) ?? process.cwd());
    return runWholeFileTool(input, "file_write", "new", buildScaffoldSource(spec), { template, spec });
  }
  fail("INVALID_MCP_INPUT", "file_write mode must be write, scaffold, or template.");
}

function runWholeFileTool(input: JsonRecord, label: string, kind: string, source: string, extraResult: Record<string, unknown> = {}): unknown {
  const filePath = requiredString(input.file, label + " requires file.");
  const existed = existsSync(filePath);
  const restorePoints = captureRestorePoints([filePath]);
  if (existed && !booleanValue(input.overwrite)) {
    fail("FILE_EXISTS", "Refusing to overwrite existing file: " + filePath + ". Pass overwrite=true to bypass.");
  }

  const parseVerification = verifyParseForFile(filePath, source);
  const previous = existed ? readFileSync(filePath, "utf8") : "";
  const changed = previous !== source;
  const diff = unifiedDiff(previous, source, filePath);
  const warnings = qualityWarnings(filePath, previous, source);
  const policy = resolveWritePolicy(filePath, writeFlagsFromInput(input));
  const shouldWrite = policy.write;
  let backup: BackupResult = {};

  if (shouldWrite && changed) {
    backup = maybeWriteBackup(filePath, previous, policy, changed, source);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
  }

  return withVerifiedAgentFields({
    success: true,
    file: filePath,
    existed,
    changed,
    written: shouldWrite && changed,
    ...parseVerificationFields(parseVerification),
    result: { kind, ...extraResult },
    warnings,
    write_policy: writePolicyReport(policy, backup),
    ...(diff ? { diff } : {}),
  }, input, restorePoints);
}

function runEditTool(args: unknown): unknown {
  const input = recordInput(args, "edit");
  const filePath = requiredString(input.file, "edit requires file.");
  const restorePoints = captureRestorePoints([filePath]);
  const source = readFileSync(filePath, "utf8");
  const expectCountValue = pick(input, "expectCount", "expect-count", "expect_count");
  const expectCount = optionalInteger(expectCountValue, "expectCount");
  const plan = planBaseEdit({
    filePath,
    source,
    strategy: resolveEditStrategy(input),
    mutation: resolveEditMutation(input),
    replaceAll: booleanValue(pick(input, "replaceAll", "replace-all", "replace_all")),
    ...(expectCountValue === undefined ? {} : { expectCount }),
  });
  const policy = resolveWritePolicy(filePath, writeFlagsFromInput(input));
  const shouldWrite = policy.write;
  const warnings = qualityWarnings(filePath, source, plan.nextSource);
  let backup: BackupResult = {};

  if (shouldWrite && plan.changed) {
    backup = maybeWriteBackup(filePath, source, policy, plan.changed, plan.nextSource);
    writeFileSync(filePath, plan.nextSource);
  }

  return withVerifiedAgentFields({
    success: true,
    file: filePath,
    action: plan.action,
    strategy: plan.strategy,
    changed: plan.changed,
    written: shouldWrite && plan.changed,
    ...parseVerificationFields(plan.parseVerification),
    matches: plan.matches,
    guardrails: plan.guardrails,
    warnings,
    write_policy: writePolicyReport(policy, backup),
    ...(plan.diff ? { diff: plan.diff } : {}),
  }, input, restorePoints);
}

function runMultieditTool(args: unknown): unknown {
  const input = recordInput(args, "multiedit");
  const restorePoints = captureRestorePoints(multieditFilesFromInput(input));
  if (input.input !== undefined && input.edits !== undefined) {
    fail("INVALID_MCP_INPUT", "multiedit accepts only one of input or edits.");
  }
  if (input.input !== undefined) return withVerifiedAgentFields(runMultieditInput(requiredString(input.input, "multiedit input must be a string."), writeFlagsFromInput(input)), input, restorePoints);
  const edits = input.edits;
  if (!Array.isArray(edits)) fail("INVALID_MCP_INPUT", "multiedit requires edits array or input string.");
  return withVerifiedAgentFields(runMultiedit(edits, writeFlagsFromInput(input)), input, restorePoints);
}

function runPatchTool(args: unknown): unknown {
  const input = recordInput(args, "patch");
  const patch = requiredString(input.patch, "patch requires patch.");
  const restorePoints = captureRestorePoints(patchFilesForRestore(patch));
  return withVerifiedAgentFields(runPatchInput(patch, writeFlagsFromInput(input)), input, restorePoints);
}

function runDeleteFileTool(args: unknown): unknown {
  const input = recordInput(args, "delete_file");
  const filePath = requiredPatchPath(input.file, "delete_file requires file.");
  const restorePoints = captureRestorePoints([filePath]);
  return withVerifiedAgentFields(runPatchInput(`*** Begin Patch\n*** Delete File: ${filePath}\n*** End Patch\n`, writeFlagsFromInput(input)), input, restorePoints);
}

function runRenameFileTool(args: unknown): unknown {
  const input = recordInput(args, "rename_file");
  const filePath = requiredPatchPath(input.file, "rename_file requires file.");
  const to = requiredPatchPath(input.to, "rename_file requires to.");
  const restorePoints = captureRestorePoints([filePath, to]);
  return withVerifiedAgentFields(runPatchInput(`*** Begin Patch\n*** Update File: ${filePath}\n*** Move to: ${to}\n*** End Patch\n`, writeFlagsFromInput(input)), input, restorePoints);
}

function runActionsTool(args: unknown): unknown {
  const input = optionalRecordInput(args, "actions");
  const filePath = optionalString(input.file);
  const adapter = filePath ? getOptionalAdapterForFile(filePath) : null;
  const languageRules = adapter ? [adapter.rule] : [];
  const registeredTools = toolsForMcpProfile(teditMcpProfileFromEnv());
  const registeredToolNames = new Set(registeredTools.map((tool) => tool.name));
  const allTools = TEDIT_MCP_ALL_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    readOnly: tool.annotations?.readOnlyHint === true,
    exposure: toolExposure(tool),
    registered: registeredToolNames.has(tool.name),
    ...(tool.category ? { category: tool.category } : {}),
    ...(tool.action ? { action: tool.action } : {}),
    ...(tool.aliases && tool.aliases.length > 0 ? { aliases: tool.aliases } : {}),
    ...(tool.bestFor && tool.bestFor.length > 0 ? { best_for: tool.bestFor } : {}),
  }));
  const tools = allTools.filter((tool) => tool.registered);
  const advancedTools = allTools.filter((tool) => tool.exposure === "advanced");
  const actions = [...new Set([
    ...tools.map((tool) => tool.name),
    ...BASE_ACTIONS,
    ...languageRules.flatMap((rule) => rule.actions),
  ])];
  return withAgentFields({
    success: true,
    ...(filePath ? { file: filePath } : {}),
    tools,
    advanced_tools: advancedTools,
    profiles: {
      current: teditMcpProfileFromEnv(),
      agent: toolsForMcpProfile("agent").map((tool) => tool.name),
      all: TEDIT_MCP_ALL_TOOLS.map((tool) => tool.name),
    },
    rules: [
      { name: "base", extensions: ["*"], actions: BASE_ACTIONS },
      ...languageRules,
    ],
    actions,
    guidance: mcpDiscoveryGuidance(filePath, languageRules.map((rule) => rule.name)),
  }, input);
}

function runTemplatesTool(args: unknown): unknown {
  const input = optionalRecordInput(args, "templates");
  const cwd = optionalString(input.cwd) ?? process.cwd();
  const templates = listTemplates(cwd);
  return withAgentFields({
    success: true,
    kind: "templates",
    cwd,
    templates,
    count: templates.length,
  }, input);
}

function runInspectRangeTool(args: unknown): unknown {
  const input = recordInput(args, "inspect_range");
  return withAgentFields(inspectRange(requiredString(input.file, "inspect_range requires file."), {
    lines: requiredString(input.lines, "inspect_range requires lines."),
    context: input.context === undefined ? 0 : optionalNonnegativeInteger(input.context, "context"),
  }), input);
}

function runSearchTextTool(args: unknown): unknown {
  const input = recordInput(args, "search_text");
  const paths = input.paths === undefined
    ? (input.path === undefined ? undefined : [requiredString(input.path, "search_text path must be a string.")])
    : stringArray(input.paths, "paths");
  const maxResults = pick(input, "maxResults", "max_results", "max-results");
  return withAgentFields(searchText({
    query: requiredString(input.query, "search_text requires query."),
    paths,
    regex: booleanValue(input.regex),
    glob: optionalString(input.glob),
    context: optionalNonnegativeInteger(input.context, "context"),
    multieditSpec: booleanValue(pick(input, "multieditSpec", "multiedit_spec", "multiedit-spec")),
    replace: optionalString(input.replace),
    ...(maxResults === undefined ? {} : { maxResults: optionalInteger(maxResults, "maxResults") }),
    caseSensitive: booleanValue(pick(input, "caseSensitive", "case_sensitive", "case-sensitive")),
    includeHidden: booleanValue(pick(input, "includeHidden", "include_hidden", "include-hidden")),
  }), input);
}

function runHistoryTraceTool(args: unknown): unknown {
  const input = recordInput(args, "history_trace");
  return withAgentFields(historyTrace(requiredString(input.file, "history_trace requires file."), {
    lines: optionalString(input.lines),
    contains: optionalString(input.contains),
    regex: optionalString(input.regex),
    limit: optionalInteger(input.limit, "limit"),
  }), input);
}

function runScanStringsTool(args: unknown): unknown {
  const input = recordInput(args, "scan_strings");
  const minLength = pick(input, "minLength", "min_length", "min-length");
  return withAgentFields(runScanStrings(requiredString(input.file, "scan_strings requires file."), {
    contains: optionalString(input.contains),
    includeExcluded: booleanValue(pick(input, "includeExcluded", "include_excluded", "include-excluded")),
    ...(minLength === undefined ? {} : { minLength: optionalInteger(minLength, "minLength") }),
  }), input);
}

function runSelectTool(args: unknown): unknown {
  const input = recordInput(args, "select");
  return withAgentFields(runUniversalSelect(input), input);
}

function runUniversalSelect(input: JsonRecord): JsonRecord {
  const file = requiredString(input.file, "select requires file.");
  const selector = optionalString(pick(input, "selector", "name"));
  const contains = optionalString(input.contains);
  const query = selector ?? contains;
  const kind = optionalString(input.kind) ?? "auto";
  const maxResults = optionalInteger(input.maxResults, "maxResults") ?? 25;
  const context = optionalInteger(input.context, "context") ?? 2;
  const ext = extname(file).toLowerCase();
  const routes = selectRoutes(ext, kind, query);
  const routeErrors: JsonRecord[] = [];
  const matches: JsonRecord[] = [];

  if (routes.includes("ts")) {
    try {
      matches.push(...selectTsMatches(file, selector, kind));
    } catch (error) {
      routeErrors.push(selectRouteError("ts", error));
    }
  }

  if (routes.includes("jsx") && query) {
    try {
      matches.push(...selectJsxMatches(file, query));
    } catch (error) {
      routeErrors.push(selectRouteError("jsx", error));
    }
  }

  if (routes.includes("python")) {
    try {
      matches.push(...selectPythonMatches(file, selector, kind, maxResults));
    } catch (error) {
      routeErrors.push(selectRouteError("python", error));
    }
  }

  if ((routes.includes("text") || matches.length === 0 && kind === "auto") && query) {
    try {
      matches.push(...selectTextMatches(file, query, context, maxResults));
    } catch (error) {
      routeErrors.push(selectRouteError("text", error));
    }
  }

  const limited = matches.slice(0, maxResults);
  return {
    success: true,
    kind: "select",
    file,
    language: selectLanguage(ext),
    route: routes.join("+"),
    ...(selector ? { selector } : {}),
    ...(contains ? { contains } : {}),
    requestedKind: kind,
    matches: limited,
    count: matches.length,
    truncated: matches.length > limited.length,
    summary: `${limited.length}${matches.length > limited.length ? "+" : ""} selection ${limited.length === 1 ? "match" : "matches"}`,
    suggestions: selectSuggestions(limited),
    ...(routeErrors.length > 0 && limited.length === 0 ? { routeErrors } : {}),
  };
}

function selectRoutes(ext: string, kind: string, query: string | undefined): string[] {
  const tsExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
  const jsxExts = new Set([".tsx", ".jsx"]);
  const pythonExts = new Set([".py", ".pyw"]);
  if (kind === "text") return ["text"];
  if (kind === "jsx") return jsxExts.has(ext) ? ["jsx"] : ["text"];
  if (["function", "class", "method", "var", "import"].includes(kind)) return pythonExts.has(ext) ? ["python"] : tsExts.has(ext) ? ["ts"] : ["text"];
  if (["prop"].includes(kind)) return tsExts.has(ext) ? ["ts"] : ["text"];
  const routes: string[] = [];
  if (tsExts.has(ext)) routes.push("ts");
  if (jsxExts.has(ext) && query) routes.push("jsx");
  if (pythonExts.has(ext)) routes.push("python");
  if (routes.length === 0 && query) routes.push("text");
  return routes.length > 0 ? routes : ["text"];
}

function selectLanguage(ext: string): string {
  if (ext.startsWith(".")) return ext.slice(1) || "text";
  return "text";
}

function selectTsMatches(file: string, selector: string | undefined, kind: string): JsonRecord[] {
  const tsSelector = tsSelectorForSelect(selector, kind);
  const result = runTsSelect(file, tsSelector) as JsonRecord;
  const rawMatches = Array.isArray(result.matches) ? result.matches as JsonRecord[] : [];
  const filtered = tsSelector || !selector ? rawMatches : rawMatches.filter((match) => match.name === selector || match.selector === selector);
  return filtered.map((match) => ({
    id: `ts:${String(match.id ?? match.selector ?? match.name)}`,
    route: "ts",
    kind: `ts.${String(match.kind ?? "declaration")}`,
    name: match.name,
    selector: match.selector,
    range: match.range,
    lineRange: match.lineRange,
    preview: match.preview,
    context: match.context,
    canReplaceBody: match.canReplaceBody,
    editHint: { tool: "ts_edit", file, selector: match.selector },
    moveHint: { tool: "ts_move", file, target: match.selector },
  }));
}

function tsSelectorForSelect(selector: string | undefined, kind: string): string | undefined {
  if (!selector) return undefined;
  if (/^(fn|function|class|method|prop|var):/.test(selector)) return selector;
  if (kind === "function") return `fn:${selector}`;
  if (kind === "class") return `class:${selector}`;
  if (kind === "method") return `method:${selector}`;
  if (kind === "prop") return `prop:${selector}`;
  if (kind === "var") return `var:${selector}`;
  return undefined;
}

function selectJsxMatches(file: string, selector: string): JsonRecord[] {
  const result = runWorkspaceFlow([{ action: "find", file, selector, all: true }]);
  const data = result.results[0]?.data;
  const rawMatches = Array.isArray(data) ? data as JsonRecord[] : typeof data === "string" ? [{ id: data }] : [];
  return rawMatches.map((match) => ({
    id: `jsx:${String(match.id ?? selector)}`,
    route: "jsx",
    kind: "jsx.element",
    name: match.name,
    selector,
    range: match.loc,
    lineRange: lineRangeFromLoc(match.loc),
    preview: match.preview,
    editHint: { tool: "edit", file, find: match.preview ?? selector },
    inspectHint: { tool: "jsx_select", file, action: "inspect", id: match.id },
  }));
}

function selectTextMatches(file: string, query: string, context: number, maxResults: number): JsonRecord[] {
  const result = searchText({ query, paths: [file], context, maxResults });
  const rawMatches = Array.isArray(result.results) ? result.results as JsonRecord[] : [];
  return rawMatches.map((match) => ({
    id: `text:${String(match.id ?? match.lineRange ?? match.preview)}`,
    route: "text",
    kind: "text.match",
    selector: query,
    range: match.range,
    lineRange: (match.range as JsonRecord | undefined)?.lineRange,
    preview: match.preview,
    editHint: match.suggested,
  }));
}

type PythonSelectMatch = {
  id: string;
  kind: "python.function" | "python.method" | "python.class" | "python.import" | "python.var" | "python.main";
  name: string;
  owner?: string;
  line: number;
  endLine: number;
  preview: string;
};

function selectPythonMatches(file: string, selector: string | undefined, kind: string, maxResults: number): JsonRecord[] {
  const source = readFileSync(file, "utf8");
  const matches = collectPythonMatches(source);
  const filtered = matches.filter((match) => pythonMatchFits(match, selector, kind)).slice(0, maxResults);
  return filtered.map((match) => {
    const lineRange = match.line === match.endLine ? String(match.line) : `${match.line}:${match.endLine}`;
    return {
      id: `python:${match.id}`,
      route: "python",
      kind: match.kind,
      name: match.name,
      ...(match.owner ? { owner: match.owner } : {}),
      selector: pythonSelectorForMatch(match),
      lineRange,
      preview: match.preview,
      editHint: { tool: "edit", file, findLines: lineRange },
    };
  });
}

function collectPythonMatches(source: string): PythonSelectMatch[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const matches: PythonSelectMatch[] = [];
  const classStack: Array<{ name: string; indent: number; endLine: number }> = [];

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = leadingSpaces(line);
    while (classStack.length > 0 && lineNumber > classStack[classStack.length - 1].endLine) classStack.pop();
    const decoratorStart = pythonDecoratorStart(lines, index);

    const classMatch = line.match(/^(\s*)class\s+([A-Za-z_]\w*)\b/);
    if (classMatch) {
      const endLine = pythonBlockEnd(lines, index, indent);
      const name = classMatch[2];
      matches.push({ id: `class_${matches.length + 1}`, kind: "python.class", name, line: decoratorStart, endLine, preview: trimmed });
      classStack.push({ name, indent, endLine });
      continue;
    }

    const functionMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (functionMatch) {
      const owner = currentPythonClassOwner(classStack, indent);
      matches.push({
        id: `function_${matches.length + 1}`,
        kind: owner ? "python.method" : "python.function",
        name: functionMatch[2],
        ...(owner ? { owner } : {}),
        line: decoratorStart,
        endLine: pythonBlockEnd(lines, index, indent),
        preview: trimmed,
      });
      continue;
    }

    if (line.match(/^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:/)) {
      matches.push({ id: `main_${matches.length + 1}`, kind: "python.main", name: "__main__", line: lineNumber, endLine: pythonBlockEnd(lines, index, indent), preview: trimmed });
      continue;
    }

    const importMatch = line.match(/^\s*(?:import\s+(.+)|from\s+([A-Za-z_][\w.]*)\s+import\s+(.+))/);
    if (importMatch) {
      const name = (importMatch[2] ?? importMatch[1] ?? "").split(/[,\s]/)[0];
      matches.push({ id: `import_${matches.length + 1}`, kind: "python.import", name, line: lineNumber, endLine: lineNumber, preview: trimmed });
      continue;
    }

    if (indent === 0) {
      const assignmentMatch = line.match(/^([A-Za-z_]\w*)\s*(?::[^=]+)?=/);
      if (assignmentMatch) {
        matches.push({ id: `var_${matches.length + 1}`, kind: "python.var", name: assignmentMatch[1], line: lineNumber, endLine: pythonStatementEnd(lines, index), preview: trimmed });
      }
    }
  }

  return matches;
}

function pythonMatchFits(match: PythonSelectMatch, selector: string | undefined, requestedKind: string): boolean {
  if (requestedKind !== "auto") {
    if (requestedKind === "function" && match.kind !== "python.function") return false;
    if (requestedKind === "class" && match.kind !== "python.class") return false;
    if (requestedKind === "method" && match.kind !== "python.method") return false;
    if (requestedKind === "var" && match.kind !== "python.var") return false;
    if (requestedKind === "import" && match.kind !== "python.import") return false;
  }
  if (!selector) return true;
  const parsed = selector.match(/^(fn|function|class|method|var|import):(.+)$/);
  const expectedName = (parsed ? parsed[2] : selector).trim();
  const expectedKind = parsed?.[1];
  if (expectedKind && !pythonKindMatchesSelector(match, expectedKind)) return false;
  if (expectedName.includes(".") && match.owner) return `${match.owner}.${match.name}` === expectedName;
  return match.name === expectedName || match.preview.includes(expectedName);
}

function pythonKindMatchesSelector(match: PythonSelectMatch, selectorKind: string): boolean {
  if (selectorKind === "fn" || selectorKind === "function") return match.kind === "python.function";
  if (selectorKind === "class") return match.kind === "python.class";
  if (selectorKind === "method") return match.kind === "python.method";
  if (selectorKind === "var") return match.kind === "python.var";
  if (selectorKind === "import") return match.kind === "python.import";
  return true;
}

function currentPythonClassOwner(classStack: Array<{ name: string; indent: number; endLine: number }>, indent: number): string | undefined {
  for (let index = classStack.length - 1; index >= 0; index--) {
    if (indent > classStack[index].indent) return classStack[index].name;
  }
  return undefined;
}

function pythonSelectorForMatch(match: PythonSelectMatch): string {
  if (match.kind === "python.function") return `function:${match.name}`;
  if (match.kind === "python.class") return `class:${match.name}`;
  if (match.kind === "python.method") return `method:${match.owner ? `${match.owner}.` : ""}${match.name}`;
  if (match.kind === "python.var") return `var:${match.name}`;
  if (match.kind === "python.import") return `import:${match.name}`;
  return match.name;
}

function pythonBlockEnd(lines: string[], startIndex: number, indent: number): number {
  let end = startIndex + 1;
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      end = index + 1;
      continue;
    }
    if (leadingSpaces(line) <= indent) break;
    end = index + 1;
  }
  return end;
}

function pythonStatementEnd(lines: string[], startIndex: number): number {
  let balance = 0;
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    balance += (line.match(/[\[({]/g) ?? []).length;
    balance -= (line.match(/[\])}]/g) ?? []).length;
    const continuation = line.trimEnd().endsWith("\\");
    if (balance <= 0 && !continuation) return index + 1;
  }
  return startIndex + 1;
}

function pythonDecoratorStart(lines: string[], index: number): number {
  let start = index;
  while (start > 0 && lines[start - 1].trimStart().startsWith("@")) start--;
  return start + 1;
}

function leadingSpaces(line: string): number {
  return line.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
}

function lineRangeFromLoc(loc: unknown): string | undefined {
  if (!loc || typeof loc !== "object" || Array.isArray(loc)) return undefined;
  const record = loc as JsonRecord;
  const start = record.start;
  const end = record.end;
  if (!start || typeof start !== "object" || !end || typeof end !== "object") return undefined;
  const startLine = (start as JsonRecord).line;
  const endLine = (end as JsonRecord).line;
  if (typeof startLine !== "number" || typeof endLine !== "number") return undefined;
  return startLine === endLine ? String(startLine) : `${startLine}:${endLine}`;
}

function selectSuggestions(matches: JsonRecord[]): string[] {
  const tools = [...new Set(matches.flatMap((match) => {
    const editHint = match.editHint as JsonRecord | undefined;
    const moveHint = match.moveHint as JsonRecord | undefined;
    return [editHint?.tool, moveHint?.tool].filter((tool): tool is string => typeof tool === "string");
  }))];
  return tools.map((tool) => `Use ${tool} with the returned hint for the selected match.`);
}

function selectRouteError(route: string, error: unknown): JsonRecord {
  const record = error && typeof error === "object" ? error as JsonRecord : {};
  return {
    route,
    code: typeof record.code === "string" ? record.code : "SELECT_ROUTE_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function runAstSelectTool(args: unknown): unknown {
  const input = recordInput(args, "ast_select");
  return withAgentFields(runAstSelect(requiredString(input.file, "ast_select requires file."), requiredString(input.selector, "ast_select requires selector.")), input);
}

function runAstEditTool(args: unknown): unknown {
  const input = recordInput(args, "ast_edit");
  return withAgentFields(runAstEditEngine(requiredString(input.file, "ast_edit requires file."), {
    selector: astEditSelectorFromInput(input),
    replace: requiredString(input.replace, "ast_edit requires replace."),
    ...writeFlagsFromInput(input),
  }), input);
}

function runTsSelectTool(args: unknown): unknown {
  const input = recordInput(args, "ts_select");
  return withAgentFields(runTsSelect(requiredString(input.file, "ts_select requires file."), optionalString(input.selector)), input);
}

function runTsEditTool(args: unknown): unknown {
  const input = recordInput(args, "ts_edit");
  const action = optionalString(input.action);
  if (action !== undefined && action !== "replace-body" && action !== "insert-before" && action !== "insert-after") {
    fail("INVALID_MCP_INPUT", "ts_edit action must be replace-body, insert-before, or insert-after.");
  }
  return withAgentFields(runTsEditEngine(requiredString(input.file, "ts_edit requires file."), {
    selector: requiredString(input.selector, "ts_edit requires selector."),
    ...(action === undefined ? {} : { action }),
    ...(input.body === undefined ? {} : { body: requiredString(input.body, "ts_edit body must be a string.") }),
    ...(input.insertBefore === undefined ? {} : { insertBefore: requiredString(input.insertBefore, "ts_edit insertBefore must be a string.") }),
    ...(input.insertAfter === undefined ? {} : { insertAfter: requiredString(input.insertAfter, "ts_edit insertAfter must be a string.") }),
    ...writeFlagsFromInput(input),
  }), input);
}

function runTsMoveTool(args: unknown): unknown {
  const input = recordInput(args, "ts_move");
  return withAgentFields(runTsMoveEngine(requiredString(input.file, "ts_move requires file."), {
    target: requiredString(input.target, "ts_move requires target."),
    before: optionalString(input.before),
    after: optionalString(input.after),
    take: stringArray(input.take, "take"),
    drop: stringArray(input.drop, "drop"),
    confirmTrivia: booleanValue(input.confirmTrivia),
    sourceHash: optionalString(input.sourceHash),
    includeTriviaContent: booleanValue(input.includeTriviaContent),
    ...writeFlagsFromInput(input),
  }), input);
}

function astEditSelectorFromInput(input: JsonRecord): string {
  const selector = optionalString(input.selector);
  const stringValue = optionalString(input.string);
  const contains = optionalString(input.contains);
  const jsxText = optionalString(pick(input, "jsxText", "jsx_text", "jsx-text"));
  const jsxAttr = optionalString(pick(input, "jsxAttr", "jsx_attr", "jsx-attr"));
  const objectKey = optionalString(pick(input, "objectKey", "object_key", "object-key"));
  const call = optionalString(input.call);
  const shortcutCount = [stringValue, contains, jsxText, jsxAttr, objectKey, call].filter((value) => value !== undefined).length;
  if (selector && shortcutCount > 0) fail("INVALID_MCP_INPUT", "ast_edit accepts either selector or one shortcut field.");
  if (shortcutCount > 1) fail("INVALID_MCP_INPUT", "ast_edit accepts only one shortcut field.");
  if (selector) return selector;
  if (stringValue !== undefined) return `StringLiteral[value=${astSelectorValue(stringValue)}]`;
  if (contains !== undefined) return `StringLiteral[value*=${astSelectorValue(contains)}]`;
  if (jsxText !== undefined) return `JSXText[value*=${astSelectorValue(jsxText)}]`;
  if (jsxAttr !== undefined) return `JSXAttribute[name=${astSelectorValue(jsxAttr)}]`;
  if (objectKey !== undefined) return `ObjectProperty[key.name=${astSelectorValue(objectKey)}]`;
  if (call !== undefined) return `${astCallSelector(call)} > StringLiteral`;
  fail("INVALID_MCP_INPUT", "ast_edit requires selector, string, contains, jsxText, jsxAttr, objectKey, or call.");
}

function astSelectorValue(value: string): string {
  if (!value.includes("\"")) return JSON.stringify(value);
  if (!value.includes("'")) return `'${value}'`;
  fail("INVALID_MCP_INPUT", "AST shortcut values cannot contain both single and double quotes yet; pass an explicit selector.");
}

function astCallSelector(value: string): string {
  const parts = value.split(".");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return `CallExpression[callee.object.name=${astSelectorValue(parts[0])}][callee.property.name=${astSelectorValue(parts[1])}]`;
  }
  return `CallExpression[callee.name=${astSelectorValue(value)}]`;
}

function toolExposure(tool: TeditMcpTool): "default" | "advanced" {
  return AGENT_MCP_TOOL_NAMES.has(tool.name) ? "default" : "advanced";
}

function mcpDiscoveryGuidance(filePath: string | undefined, ruleNames: string[]): JsonRecord {
  return {
    default_profile: "agent",
    read_path: [
      "Use the host/native Read tool for full file contents; tedit does not duplicate plain file reading yet.",
      "Use actions first when unsure; it returns the current profile, default tools, advanced tools, and examples.",
      "Use select as the common TS/JS/JSX/TSX target discovery facade before choosing edit, ts_edit, or move.",
      "Use inspect_range for sed-style line context plus parse status and edit-ready findLines suggestions.",
      "Use search_text for rg/grep-style raw text discovery when the next step is likely a tedit edit.",
      "Use verify_file when parser coverage or current-file validity matters before or after an edit.",
      "Pass verify for optional post-write project checks such as typecheck, lint, test, or build.",
      "Set TEDIT_MCP_PROFILE=all for JSX, TS declaration, AST, history, template, and refactor helpers.",
    ],
    no_read_file_tool: "A plain read_file MCP tool would currently be less useful than native Read. Add one only when it returns tedit-specific value such as parser status, stable selectors, slices, hashes, or retry-ready targets.",
    profile: {
      current: teditMcpProfileFromEnv(),
      default_surface: "Agent profile exposes actions, select, edit, multiedit, patch, delete_file, rename_file, ts_select, ts_edit, ts_move, file_write, inspect_range, search_text, and verify_file.",
      advanced_surface: "Set TEDIT_MCP_PROFILE=all to expose JSX, TS declaration, AST, history, template, extract, plan, and legacy fine-grained tools.",
      refresh_hint: "If actions lists a tool but the host does not expose it as callable, restart or refresh the MCP host; tool schema/name changes are captured only when the host reloads the server.",
    },
    tool_priorities: [
      "select for file-type-aware target discovery", 
      "search_text or inspect_range for text/range discovery",
      "edit for one localized change",
      "multiedit for repeated or cross-file changes",
      "delete_file or rename_file for one-file cleanup/moves",
      "verify for optional post-write project checks",
      "file_write for whole-file generation, scaffold mode, or template mode",
      "verify_file before or after edits when parser coverage matters",
      "patch only when the change is already a diff",
      "TEDIT_MCP_PROFILE=all for JSX/TS declaration/AST/history/refactor/template helpers",
    ],
    workflow_guide: [
      { when: "need file-type-aware target discovery", first_tool: "select", then: "edit, ts_edit, or ts_move from returned hints", reason: "one common facade routes TS/JS declarations, JSX elements, or text fallback" },
      { when: "need target context before editing", first_tool: "search_text", then: "inspect_range or edit", reason: "turn raw text matches into line ranges and edit-ready suggestions" },
      { when: "one localized replacement/insertion/deletion", first_tool: "edit", then: "rerun with write=true after dry-run if needed", reason: "exact/fuzzy/regex/line strategies plus parser guardrails" },
      { when: "same change across several places or files", first_tool: "search_text", then: "multiedit", reason: "search_text can emit a grouped multiedit spec; multiedit applies atomically" },
      { when: "already have a generated diff", first_tool: "patch", then: "verify_file for important touched files", reason: "patch accepts unified diff and Codex apply-patch envelopes" },
      { when: "delete or rename one file", first_tool: "delete_file or rename_file", then: "patch for multi-file transactions", reason: "single-file cleanup no longer requires hand-authored patch text" },
      { when: "project-specific validation is needed after write", first_tool: "edit/multiedit/patch with verify", then: "inspect verify stdout/stderr; optionally rollbackOnFail", reason: "repo checks vary, so verification is opt-in per mutation" },
      { when: "create or overwrite a whole file", first_tool: "file_write", then: "verify_file", reason: "mode=write/scaffold/template keeps generation behind write policy and parse verification" },
      { when: "large plain-TS named function or class edit", first_tool: "ts_select", then: "ts_edit or ts_move", reason: "named declaration selectors avoid brittle old_string ranges and keep braces/trivia mechanical" },
      { when: "hardcoded JS/TS/JSX strings", first_tool: "scan_strings", then: "ast_select or ast_edit", reason: "AST scanning covers code strings that structural find does not" },
      { when: "structural JSX/markup mutation", first_tool: "actions with file", then: "TEDIT_MCP_PROFILE=all structural tools or CLI chain", reason: "agent profile stays small; advanced profile exposes fine-grained structural actions" },
      { when: "need change history before risky edit", first_tool: "history_trace", then: "inspect_range or edit", reason: "history_trace avoids hand-assembling blame/log commands" },
    ],
    failure_recovery: [
      { code: "MATCH_NONE", suggestion: "Use returned candidates, search_text, or inspect_range; retry with findLines/fuzzy/regex only after inspecting context." },
      { code: "MATCH_NOT_UNIQUE", suggestion: "Use returned candidate line ranges or add expectCount when replaceAll is intended." },
      { code: "PARSE_BROKEN_AFTER_EDIT", suggestion: "Do not force write; inspect the proposed replacement and keep syntax balanced before retrying." },
      { code: "AST_MATCH_NONE", suggestion: "Use scan_strings candidates or switch selector type, for example JSXText instead of StringLiteral." },
      { code: "PATCH_HUNK_FAILED", suggestion: "Inspect current file context and regenerate the hunk against the current source." },
    ],
    edit_loop: [
      { intent: "select target across TS/JS/JSX/TSX", tool: "select", reason: "file-type-aware facade returning normalized matches and follow-up edit hints" },
      { intent: "one localized edit", tool: "edit", reason: "dry-run defaults, exact/fuzzy/line/regex strategies, parse verification, retry hints" },
      { intent: "several coordinated text edits", tool: "multiedit", reason: "atomic application across files and same-file sequential edits" },
      { intent: "already generated diff", tool: "patch", reason: "atomic unified diff/apply-patch input with verification" },
      { intent: "delete one file", tool: "delete_file", reason: "dry-run/write delete without authoring a patch envelope" },
      { intent: "rename one file", tool: "rename_file", reason: "dry-run/write move without authoring a patch envelope" },
      { intent: "post-write typecheck/lint/test", tool: "verify option", reason: "optional command hook with timeoutMs and rollbackOnFail" },
      { intent: "line range context before editing", tool: "inspect_range", reason: "sed-style context plus parser status and edit findLines suggestion" },
      { intent: "raw text search before editing", tool: "search_text", reason: "grep-style candidates with inspect/edit/multiedit follow-ups" },
      { intent: "who changed this or when", tool: "history_trace", reason: "git blame/log history without hand-assembling commands" },
      { intent: "must-be-new full file", tool: "create_file", reason: "no-overwrite creation is a safety boundary" },
      { intent: "whole-file generation or scaffold/template", tool: "file_write", required: ["mode"], reason: "write/scaffold/template facade with parser guardrails" },
      { intent: "available project templates", tool: "templates", reason: "lists built-in and .tedit/templates before file_write mode=template" },
      { intent: "structural JSX/markup mutation", tool: "jsx_select, then jsx_node/jsx_attr/jsx_content/imports", reason: "selector/id based edits avoid brittle text spans" },
      { intent: "hardcoded text audit", tool: "scan_strings", reason: "AST scan covers JSX text/attrs plus JS/TS string literals; find remains structural" },
      { intent: "code AST discovery or one safe string replacement", tool: "ast_select, then ast_edit", reason: "AST shortcuts target common string/object/JSX text replacements" },
      { intent: "large TS declaration body edit", tool: "ts_select, then ts_edit", reason: "selector resolves the named declaration and tedit owns the outer braces" },
      { intent: "reorder TS declarations", tool: "ts_move", reason: "dry-run-first source-range move with carried trivia hints and take/drop overrides" },
    ],
    refactor_loop: [
      { intent: "small confident JSX component extraction", tool: "extract_component", required: ["mode=direct", "from", "selector", "to", "name"], reason: "direct dry-run/write extraction with prop inference and parser guardrails" },
      { intent: "large or risky JSX component extraction", tool: "extract_component then apply_plan", required: ["mode=plan", "from", "selector", "to", "name", "planOut"], reason: "reviewable plan file before applying file creation, call-site replacement, and helper movement" },
      { intent: "extract and then mutate the created component in one transaction", tool: "chain_workspace", reason: "workspace-flow can run extract plus follow-up per-file structural steps atomically" },
      { intent: "React state cluster diagnosis", tool: "analyze_state", reason: "read-only state structure insight; not a code review substitute" },
      { intent: "React state cluster cleanup, hook extraction, or component extraction", tool: "refactor", reason: "default-profile facade over existing refactor-state, extract, and apply-plan workflows" },
    ],
    examples: {
      select: { file: "src/Page.tsx", selector: "LoginButtons" },
      edit: { file: "src/Page.tsx", find: "oldLabel", replace: "newLabel", dryRun: true },
      multiedit: { edits: [{ file: "src/Page.tsx", find: "삭제", replace: "Delete", replaceAll: true, expectCount: 2 }], dryRun: true },
      patch: { patch: "--- src/Page.tsx\n+++ src/Page.tsx\n@@ ...", dryRun: true },
      delete_file: { file: "src/generated/LoginButtons.tsx", dryRun: true },
      rename_file: { file: "src/old.ts", to: "src/new.ts", dryRun: true },
      edit_with_verify: { file: "src/Page.tsx", find: "oldLabel", replace: "newLabel", write: true, verify: { cmd: ["npx", "tsc", "-p", "apps/web/tsconfig.json", "--noEmit"], timeoutMs: 30000, rollbackOnFail: false } },
      file_write: { mode: "write", file: "src/generated.json", source: "{\"ok\":true}\n", write: true },
      extract_component: { mode: "direct", from: "src/Page.tsx", selector: "Card", to: "src/components/PageCard.tsx", name: "PageCard", write: true },
      extract_component_plan: { mode: "plan", from: "src/Page.tsx", selector: "Card", to: "src/components/PageCard.tsx", name: "PageCard", planOut: ".tedit/plans/extract-card.json" },
      apply_plan: { plan: ".tedit/plans/extract-card.json", write: true },
      jsx_attr: { action: "prop_set", file: "src/Page.tsx", selector: "Card", name: "data-extracted", value: true, write: true },
      inspect_range: { file: "src/Page.tsx", lines: "120:140", context: 3 },
      search_text: { query: "삭제", paths: ["src"], glob: "**/*.tsx", context: 2, multieditSpec: true, replace: "Delete" },
      history_trace: { file: "src/Page.tsx", lines: "120:140", limit: 5 },
      templates: { cwd: "." },
      scan_strings: { file: "src/Page.tsx", contains: "삭제" },
      ast_select: { file: "src/Page.tsx", selector: "ObjectProperty[key.name=\"label\"] > StringLiteral" },
      ast_edit: { file: "src/Page.tsx", call: "toast.error", replace: "Failed", write: true },
      ts_select: { file: "src/server.ts", selector: "fn:apiGateMetadata" },
      ts_edit: { file: "src/server.ts", selector: "fn:apiGateMetadata", body: "\n  return buildMetadata();\n", write: true },
      ts_move: { file: "src/server.ts", target: "fn:apiGateMetadata", before: "fn:startServer", dryRun: true },
      chain_workspace: {
        steps: [
          { action: "extract", from: "src/Page.tsx", selector: "Card", to: "src/components/PageCard.tsx", name: "PageCard" },
          { action: "chain", file: "src/components/PageCard.tsx", steps: [{ action: "prop.set", target: "Card", name: "data-extracted", value: true }] },
        ],
        write: true,
      },
    },
    cli_fallbacks: {
      edit: "node dist/cli.js edit src/Page.tsx --find '<LoginButtons variant=\"inline\" />' --replace '<button>로그인</button>' --write --json",
      multiedit: "node dist/cli.js multiedit --from-stdin --write < edits.json",
      patch_delete: "printf '*** Begin Patch\\n*** Delete File: src/generated/LoginButtons.tsx\\n*** End Patch\\n' | node dist/cli.js patch --stdin --write --json",
      patch_rename: "printf '*** Begin Patch\\n*** Update File: src/old.ts\\n*** Move to: src/new.ts\\n*** End Patch\\n' | node dist/cli.js patch --stdin --write --json",
    },
    ...(filePath ? { file: filePath, file_rules: ruleNames } : {}),
  };
}

function runAnalyzeStateTool(args: unknown): unknown {
  const input = recordInput(args, "analyze_state");
  return withAgentFields(analyzeState(requiredString(input.file, "analyze_state requires file.")), input);
}

function runVerifyFileTool(args: unknown): unknown {
  const input = recordInput(args, "verify_file");
  const filePaths = verifyFilePathsFromInput(input);
  if (filePaths.length > 1) {
    const files = filePaths.map(verifyFileEntry);
    return withAgentFields({
      success: true,
      kind: "verify-files",
      files,
      count: files.length,
      verifiedCount: files.filter((file) => file.parse_verified === true).length,
      skippedCount: files.filter((file) => file.parse_skipped === true).length,
      warningCount: files.reduce((count, file) => count + file.warnings.length, 0),
    }, input);
  }

  const filePath = filePaths[0];
  const source = readFileSync(filePath, "utf8");
  const verification = verifyParseForFile(filePath, source);
  return withAgentFields({
    success: true,
    file: filePath,
    ...parseVerificationFields(verification),
    warnings: qualityWarnings(filePath, source, source),
  }, input);
}

function verifyFilePathsFromInput(input: JsonRecord): string[] {
  const filePaths = [...stringArray(input.file, "verify_file file"), ...stringArray(input.files, "verify_file files")];
  const unique = [...new Set(filePaths)];
  if (unique.length === 0) fail("INVALID_MCP_INPUT", "verify_file requires file or files.");
  return unique;
}

function verifyFileEntry(filePath: string): VerifyFileEntry {
  const source = readFileSync(filePath, "utf8");
  const verification = verifyParseForFile(filePath, source);
  return {
    file: filePath,
    ...parseVerificationFields(verification),
    warnings: qualityWarnings(filePath, source, source),
  };
}

function runRefactorTool(args: unknown): unknown {
  const input = recordInput(args, "refactor");
  const kind = requiredString(pick(input, "kind", "type", "action"), "refactor requires kind: state, extract, or apply-plan.");
  const normalized = kind.replace(/_/g, "-");

  if (normalized === "state" || normalized === "refactor-state") return runRefactorStateTool(input);
  if (normalized === "extract" || normalized === "extract-component") {
    const mode = optionalString(input.mode);
    if (mode === "plan" || (mode === undefined && pick(input, "planOut", "plan_out", "plan-out") !== undefined)) return runExtractPlanTool(input);
    if (mode === undefined || mode === "apply" || mode === "direct") return runExtractTool(input);
    fail("INVALID_MCP_INPUT", "refactor kind=extract mode must be direct or plan.");
  }
  if (normalized === "apply-plan") return runApplyPlanTool(input);

  fail("INVALID_MCP_INPUT", "refactor kind must be state, extract, or apply-plan.");
}

function runRefactorStateTool(args: unknown): unknown {
  const input = recordInput(args, "refactor_state");
  const mode = optionalString(input.mode);
  if (mode === "plan" || (mode === undefined && pick(input, "planOut", "plan_out", "plan-out") !== undefined)) {
    return runRefactorStatePlanTool(input);
  }
  if (mode !== undefined && mode !== "apply") fail("INVALID_MCP_INPUT", "refactor_state mode must be apply or plan.");
  return runRefactorState(requiredString(input.file, "refactor_state requires file."), {
    cluster: optionalString(input.cluster),
    to: optionalString(input.to),
    name: optionalString(input.name),
    externalDeps: externalDepsFromInput(input, "refactor_state"),
    ...writeFlagsFromInput(input),
  });
}

function runRefactorStatePlanTool(args: unknown): unknown {
  const input = recordInput(args, "refactor_state_plan");
  const filePath = requiredString(input.file, "refactor_state_plan requires file.");
  const planOut = requiredString(pick(input, "planOut", "plan_out", "plan-out"), "refactor_state_plan requires planOut.");
  const plan = buildRefactorStatePlan(filePath, {
    cluster: optionalString(input.cluster),
    to: optionalString(input.to),
    name: optionalString(input.name),
    externalDeps: externalDepsFromInput(input, "refactor_state_plan"),
  });
  writePlanFile(planOut, plan, booleanValue(input.overwrite));
  return { success: true, plan: planOut, ...plan };
}

function runExtractPlanTool(args: unknown): unknown {
  const input = recordInput(args, "extract_plan");
  const planOut = requiredString(input.planOut, "extract_plan requires planOut.");
  const options = extractOptionsFromInput(input);
  const plan = buildExtractComponentPlan(options);
  writePlanFile(planOut, plan, booleanValue(input.overwrite));
  return { success: true, plan: planOut, ...plan };
}

function runApplyPlanTool(args: unknown): unknown {
  const input = recordInput(args, "apply_plan");
  const planPath = requiredString(pick(input, "plan", "file", "path"), "apply_plan requires plan, file, or path.");
  return withAgentFields(applyRefactorPlan(planPath, {
    ...writeFlagsFromInput(input),
    overwrite: booleanValue(input.overwrite),
    only: stringArray(input.only, "only"),
    skip: stringArray(input.skip, "skip"),
  }), input);
}

function runWorkspaceTool(args: unknown): unknown {
  const input = recordInput(args, "chain_workspace");
  const steps = input.steps ?? input.flow;
  if (!Array.isArray(steps)) fail("INVALID_MCP_INPUT", "chain_workspace requires steps or flow array.");
  return withAgentFields(runWorkspaceFlow(steps as WorkspaceFlowStep[], {
    params: recordOrUndefined(input.params, "chain_workspace params"),
    ...writeFlagsFromInput(input),
  }), input);
}

function runJsxSelectTool(args: unknown): unknown {
  const input = recordInput(args, "jsx_select");
  return runWorkspaceFlow([jsxSelectStep(input)], writeFlagsFromInput(input));
}

function runJsxNodeTool(args: unknown): unknown {
  const input = recordInput(args, "jsx_node");
  return withAgentFields(runWorkspaceFlow([jsxNodeStep(input)], writeFlagsFromInput(input)), input);
}

function runJsxAttrTool(args: unknown): unknown {
  const input = recordInput(args, "jsx_attr");
  return withAgentFields(runWorkspaceFlow([jsxAttrStep(input)], writeFlagsFromInput(input)), input);
}

function runJsxContentTool(args: unknown): unknown {
  const input = recordInput(args, "jsx_content");
  return withAgentFields(runWorkspaceFlow([jsxContentStep(input)], writeFlagsFromInput(input)), input);
}

function runImportsTool(args: unknown): unknown {
  const input = recordInput(args, "imports");
  const action = requiredString(input.action, "imports requires action: add, remove, rename, or move.");
  if (!["add", "remove", "rename", "move"].includes(action)) fail("INVALID_MCP_INPUT", "imports action must be add, remove, rename, or move.");
  if (action === "rename" && (input.name === undefined || input.to === undefined)) fail("INVALID_MCP_INPUT", "imports action=rename requires name and to.");
  if (action === "move" && input.to === undefined) fail("INVALID_MCP_INPUT", "imports action=move requires to.");
  return withAgentFields(runWorkspaceFlow([{ action: `imports.${action}`, file: requiredString(input.file, "imports requires file."), ...importFields(input) }], writeFlagsFromInput(input)), input);
}

function runExtractComponentTool(args: unknown): unknown {
  const input = recordInput(args, "extract_component");
  const mode = requiredString(input.mode, "extract_component requires mode: plan or direct.");
  if (mode === "plan") return runExtractPlanTool(input);
  if (mode === "direct") return runExtractTool(input);
  fail("INVALID_MCP_INPUT", "extract_component mode must be plan or direct.");
}

function jsxSelectStep(input: JsonRecord): WorkspaceFlowStep {
  const action = requiredString(input.action, "jsx_select requires action: find or inspect.");
  if (action === "find") {
    return { action: "find", file: requiredString(input.file, "jsx_select action=find requires file."), selector: requiredString(input.selector, "jsx_select action=find requires selector."), all: booleanValue(input.all) };
  }
  if (action === "inspect") {
    return { action: "inspect", file: requiredString(input.file, "jsx_select action=inspect requires file."), target: targetFromInput(input, "jsx_select action=inspect") };
  }
  fail("INVALID_MCP_INPUT", "jsx_select action must be find or inspect.");
}

function jsxNodeStep(input: JsonRecord): WorkspaceFlowStep {
  const action = requiredString(input.action, "jsx_node requires action.");
  const file = requiredString(input.file, "jsx_node requires file.");
  if (action === "append") return { action: "append", file, target: targetFromInput(input, "jsx_node action=append"), element: normalizeElementInput(input.element, "jsx_node action=append requires element.") };
  if (action === "prepend") return { action: "prepend", file, target: targetFromInput(input, "jsx_node action=prepend"), element: normalizeElementInput(input.element, "jsx_node action=prepend requires element.") };
  if (action === "wrap") return { action: "wrap", file, target: targetFromInput(input, "jsx_node action=wrap"), with: normalizeElementInput(pick(input, "with", "wrapper"), "jsx_node action=wrap requires with or wrapper.") };
  if (action === "unwrap") return { action: "unwrap", file, target: targetFromInput(input, "jsx_node action=unwrap") };
  if (action === "remove") return { action: "remove", file, target: targetFromInput(input, "jsx_node action=remove") };
  if (action === "rename") return { action: "rename", file, target: targetFromInput(input, "jsx_node action=rename"), name: requiredString(pick(input, "to", "name"), "jsx_node action=rename requires to or name.") };
  if (action === "insert_comment") {
    return { action: "insertComment", file, target: targetFromInput(input, "jsx_node action=insert_comment"), text: requiredString(input.text, "jsx_node action=insert_comment requires text."), ...(input.position === undefined ? {} : { position: String(input.position) as WorkspaceFlowStep["position"] }) };
  }
  fail("INVALID_MCP_INPUT", "jsx_node action must be append, prepend, wrap, unwrap, remove, rename, or insert_comment.");
}

function jsxAttrStep(input: JsonRecord): WorkspaceFlowStep {
  const action = requiredString(input.action, "jsx_attr requires action.");
  const file = requiredString(input.file, "jsx_attr requires file.");
  if (action === "prop_set") return { action: "prop.set", file, target: targetFromInput(input, "jsx_attr action=prop_set"), name: requiredString(input.name, "jsx_attr action=prop_set requires name."), value: propValue(input) };
  if (action === "prop_remove") return { action: "prop.remove", file, target: targetFromInput(input, "jsx_attr action=prop_remove"), name: requiredString(input.name, "jsx_attr action=prop_remove requires name.") };
  if (action === "class_add") return { action: "class.add", file, target: targetFromInput(input, "jsx_attr action=class_add"), classes: classNamesInput(input, "jsx_attr action=class_add") };
  if (action === "class_remove") return { action: "class.remove", file, target: targetFromInput(input, "jsx_attr action=class_remove"), classes: classNamesInput(input, "jsx_attr action=class_remove") };
  if (action === "class_replace") return { action: "class.replace", file, target: targetFromInput(input, "jsx_attr action=class_replace"), from: requiredString(input.from, "jsx_attr action=class_replace requires from."), to: requiredString(input.to, "jsx_attr action=class_replace requires to.") };
  fail("INVALID_MCP_INPUT", "jsx_attr action must be prop_set, prop_remove, class_add, class_remove, or class_replace.");
}

function jsxContentStep(input: JsonRecord): WorkspaceFlowStep {
  const action = requiredString(input.action, "jsx_content requires action.");
  const file = requiredString(input.file, "jsx_content requires file.");
  if (action === "text_set") return { action: "text.set", file, target: targetFromInput(input, "jsx_content action=text_set"), ...textSetValue(input) };
  if (action === "text_replace") return { action: "text.replace", file, target: targetFromInput(input, "jsx_content action=text_replace"), match: textMatch(input) as WorkspaceFlowStep["match"], with: textReplacement(input) as WorkspaceFlowStep["with"] };
  if (action === "expr_replace") return { action: "expr.replace", file, target: targetFromInput(input, "jsx_content action=expr_replace"), code: requiredString(input.code, "jsx_content action=expr_replace requires code.") };
  if (action === "expr_wrap") return { action: "expr.wrap", file, target: targetFromInput(input, "jsx_content action=expr_wrap"), code: requiredString(input.code, "jsx_content action=expr_wrap requires code.") };
  if (action === "expr_unwrap") return { action: "expr.unwrap", file, target: targetFromInput(input, "jsx_content action=expr_unwrap") };
  if (action === "expr_to_ternary") return { action: "expr.toTernary", file, target: targetFromInput(input, "jsx_content action=expr_to_ternary"), ...(pick(input, "alternate", "value") === undefined ? {} : { value: String(pick(input, "alternate", "value")) }) };
  if (action === "expr_to_short_circuit") return { action: "expr.toShortCircuit", file, target: targetFromInput(input, "jsx_content action=expr_to_short_circuit") };
  fail("INVALID_MCP_INPUT", "jsx_content action must be text_set, text_replace, expr_replace, expr_wrap, expr_unwrap, expr_to_ternary, or expr_to_short_circuit.");
}

function extractOptionsFromInput(input: JsonRecord): ExtractOptions {
  const exportKind = pick(input, "exportKind", "export") ?? "named";
  const helpersPolicy = pick(input, "helpersPolicy", "helpers") ?? "ask";
  if (exportKind !== "named" && exportKind !== "default") fail("INVALID_MCP_INPUT", "extract export/exportKind must be named or default.");
  if (helpersPolicy !== "ask" && helpersPolicy !== "move" && helpersPolicy !== "share" && helpersPolicy !== "as-prop") {
    fail("INVALID_MCP_INPUT", "extract helpers/helpersPolicy must be ask, move, share, or as-prop.");
  }
  return {
    from: requiredString(input.from, "extract requires from."),
    selector: requiredString(input.selector, "extract requires selector."),
    to: requiredString(input.to, "extract requires to."),
    name: requiredString(input.name, "extract requires name."),
    exportKind: exportKind as "named" | "default",
    slots: stringArray(input.slots ?? input.slot, "slots"),
    ...(input.depth === undefined ? {} : { depth: optionalInteger(input.depth, "depth") }),
    autoSlot: booleanValue(input.autoSlot),
    typecheck: booleanValue(input.typecheck),
    helpersPolicy: helpersPolicy as HelperPolicy,
    helperOverrides: stringArray(input.helperOverrides ?? input.helper, "helperOverrides"),
    overwrite: booleanValue(input.overwrite),
    acceptLargeProps: booleanValue(input.acceptLargeProps),
    ...(input.maxProps === undefined ? {} : { maxProps: optionalInteger(input.maxProps, "maxProps") }),
  };
}

function runExtractTool(args: unknown): unknown {
  const input = recordInput(args, "extract");
  const step: WorkspaceFlowStep = {
    action: "extract",
    from: requiredString(input.from, "extract requires from."),
    selector: requiredString(input.selector, "extract requires selector."),
    to: requiredString(input.to, "extract requires to."),
    name: requiredString(input.name, "extract requires name."),
    ...(input.export === undefined ? {} : { export: input.export as "named" | "default" }),
    ...(input.exportKind === undefined ? {} : { exportKind: input.exportKind as "named" | "default" }),
    ...(input.slots === undefined ? {} : { slots: input.slots }),
    ...(input.slot === undefined ? {} : { slot: input.slot }),
    ...(input.depth === undefined ? {} : { depth: input.depth }),
    ...(input.autoSlot === undefined ? {} : { autoSlot: input.autoSlot }),
    ...(input.helpers === undefined ? {} : { helpers: input.helpers as WorkspaceFlowStep["helpers"] }),
    ...(input.helpersPolicy === undefined ? {} : { helpersPolicy: input.helpersPolicy as WorkspaceFlowStep["helpersPolicy"] }),
    ...(input.helper === undefined ? {} : { helper: input.helper }),
    ...(input.helperOverrides === undefined ? {} : { helperOverrides: input.helperOverrides }),
    ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
    ...(input.typecheck === undefined ? {} : { typecheck: input.typecheck }),
    ...(input.maxProps === undefined ? {} : { maxProps: input.maxProps }),
    ...(input.acceptLargeProps === undefined ? {} : { acceptLargeProps: input.acceptLargeProps }),
  };
  return withAgentFields(runWorkspaceFlow([step], writeFlagsFromInput(input)), input);
}

function singleStepTool(config: SingleStepConfig): TeditMcpTool {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    category: config.category ?? "jsx",
    exposure: config.exposure ?? "advanced",
    action: config.action,
    aliases: config.aliases ?? (config.action === config.name ? [] : [config.action]),
    bestFor: config.bestFor,
    annotations: config.readOnly ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true } : undefined,
    handler: (args) => {
      const input = recordInput(args, config.name);
      const result = runWorkspaceFlow([config.buildStep(input)], writeFlagsFromInput(input));
      return config.readOnly ? result : withAgentFields(result, input);
    },
  };
}

function scaffoldSpecFromInput(input: JsonRecord, label = "scaffold_file"): ScaffoldSpec {
  if (input.spec !== undefined) {
    const spec = recordOrUndefined(input.spec, label + " spec");
    if (!spec) fail("INVALID_MCP_INPUT", label + " spec must be an object.");
    return spec as ScaffoldSpec;
  }
  if (input.source !== undefined) return { source: requiredString(input.source, label + " source must be a string.") };
  fail("INVALID_MCP_INPUT", label + " requires spec or source.");
}

function templateParamsFromInput(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return parseParams(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, String(child)]));
  }
  fail("INVALID_MCP_INPUT", "new_file params must be an object or key=value string array.");
}

function withAgentFields<T>(result: T, input: JsonRecord = {}): T {
  return formatAgentResult(result, outputOptionsFromRecord(input)) as T;
}

function withVerifiedAgentFields<T extends Record<string, unknown>>(result: T, input: JsonRecord, restorePoints: RestorePoint[]): T {
  return withAgentFields(applyPostVerify(result, verifySpecFromInput(input), restorePoints), input);
}

function multieditFilesFromInput(input: JsonRecord): string[] {
  const rawEdits = input.input !== undefined
    ? parseMultieditInput(requiredString(input.input, "multiedit input must be a string."))
    : input.edits;
  if (!Array.isArray(rawEdits)) return [];
  return rawEdits.flatMap((edit) => {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) return [];
    const file = (edit as JsonRecord).file;
    return typeof file === "string" ? [file] : [];
  });
}

function patchFilesForRestore(input: string): string[] {
  return parsePatchInput(input).flatMap((patch) => {
    const files = [patch.oldPath, patch.newPath, patch.file]
      .filter((file): file is string => Boolean(file) && file !== "/dev/null");
    return [...new Set(files)];
  });
}

function resolveEditStrategy(input: JsonRecord): BaseFindStrategy {
  const find = pick(input, "find");
  const findExact = pick(input, "findExact", "find-exact", "find_exact");
  const findFuzzy = pick(input, "findFuzzy", "find-fuzzy", "find_fuzzy");
  const findAnchorAfter = pick(input, "findAnchorAfter", "find-anchor-after", "find_anchor_after");
  const findRegex = pick(input, "findRegex", "find-regex", "find_regex");
  const findLines = pick(input, "findLines", "find-lines", "find_lines");
  const explicitCount = [findExact, findFuzzy, findAnchorAfter, findRegex, findLines].filter((value) => value !== undefined).length;

  if (explicitCount > 1) fail("INVALID_MCP_INPUT", "edit accepts only one find strategy.");
  if (find !== undefined && explicitCount > 0 && findAnchorAfter === undefined) {
    fail("INVALID_MCP_INPUT", "edit find is exact unless paired with findAnchorAfter.");
  }

  if (findAnchorAfter !== undefined) {
    const contains = pick(input, "contains", "find");
    if (contains === undefined) fail("INVALID_MCP_INPUT", "edit findAnchorAfter requires contains or find.");
    return {
      kind: "anchor",
      after: requiredString(findAnchorAfter, "edit findAnchorAfter must be a string."),
      contains: requiredString(contains, "edit contains/find must be a string."),
    };
  }
  if (findExact !== undefined) {
    return {
      kind: "exact",
      pattern: requiredString(findExact, "edit findExact must be a string."),
      autoFuzzy: !booleanValue(pick(input, "noFuzzyFallback", "no-fuzzy-fallback", "no_fuzzy_fallback")),
    };
  }
  if (findFuzzy !== undefined) return { kind: "fuzzy", pattern: requiredString(findFuzzy, "edit findFuzzy must be a string."), ignoreWhitespace: true };
  if (findRegex !== undefined) {
    return {
      kind: "regex",
      pattern: requiredString(findRegex, "edit findRegex must be a string."),
      ...(input.flags === undefined ? {} : { flags: String(input.flags) }),
    };
  }
  if (findLines !== undefined) return { kind: "lines", ...parseLineRange(requiredString(findLines, "edit findLines must be a string.")) };
  if (find !== undefined) {
    return {
      kind: "exact",
      pattern: requiredString(find, "edit find must be a string."),
      autoFuzzy: !booleanValue(pick(input, "noFuzzyFallback", "no-fuzzy-fallback", "no_fuzzy_fallback")),
    };
  }

  fail("INVALID_MCP_INPUT", "edit requires find, findExact, findFuzzy, findAnchorAfter, findRegex, or findLines.");
}

function resolveEditMutation(input: JsonRecord): BaseEditMutation {
  const replace = pick(input, "replace");
  const insertBefore = pick(input, "insertBefore", "insert-before", "insert_before");
  const insertAfter = pick(input, "insertAfter", "insert-after", "insert_after");
  const shouldDelete = booleanValue(input.delete);
  const count = [replace !== undefined, insertBefore !== undefined, insertAfter !== undefined, shouldDelete].filter(Boolean).length;

  if (count !== 1) fail("INVALID_MCP_INPUT", "edit requires exactly one of replace, insertBefore, insertAfter, or delete.");
  if (replace !== undefined) return { kind: "replace", text: String(replace) };
  if (insertBefore !== undefined) return { kind: "insert-before", text: String(insertBefore) };
  if (insertAfter !== undefined) return { kind: "insert-after", text: String(insertAfter) };
  return { kind: "delete" };
}

function targetOnlySchema(): z.ZodRawShape {
  return { file: fileSchema, selector: selectorSchema.optional(), target: targetSchema.optional(), id: targetSchema.optional(), ...writeFlagSchema };
}

function importsSchema(options: { requireName?: boolean; requireTo?: boolean } = {}): z.ZodRawShape {
  return {
    file: fileSchema,
    from: z.string().min(1),
    to: options.requireTo ? z.string().min(1) : z.string().optional(),
    named: z.union([z.string(), z.array(z.string())]).optional(),
    default: z.string().optional(),
    namespace: z.string().optional(),
    name: options.requireName ? z.string().min(1) : z.string().optional(),
    value: z.string().optional(),
    ...writeFlagSchema,
  };
}

function exprSchema(options: { code?: boolean } = {}): z.ZodRawShape {
  return {
    file: fileSchema,
    selector: selectorSchema.optional(),
    target: targetSchema.optional(),
    id: targetSchema.optional(),
    code: options.code ? z.string().min(1) : z.string().optional(),
    ...writeFlagSchema,
  };
}

function targetFromInput(input: JsonRecord, label: string): string {
  return requiredString(pick(input, "target", "id", "selector"), `${label} requires target, id, or selector.`);
}

function normalizeElementInput(value: unknown, message: string): WorkspaceFlowStep["element"] {
  const raw = requiredValue(value, message);
  if (typeof raw === "string") return parseElementShorthand(raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as WorkspaceFlowStep["element"];
  fail("INVALID_MCP_INPUT", "Element input must be a shorthand string or object spec.");
}
function classNamesInput(input: JsonRecord, label: string): string | string[] {
  const value = input.classes;
  if (Array.isArray(value)) return value.map((item) => String(item));
  return requiredString(value, label + " requires classes.");
}

function propValue(input: JsonRecord): unknown {
  if (input.expr !== undefined && input.value !== undefined) fail("INVALID_MCP_INPUT", "prop_set accepts only one of value or expr.");
  if (input.expr !== undefined) return { type: "expr", code: requiredString(input.expr, "prop_set expr must be a string.") };
  if (input.value !== undefined) return input.value;
  return true;
}

function textSetValue(input: JsonRecord): { value?: string; expr?: string } {
  const hasValue = input.value !== undefined;
  const hasExpr = input.expr !== undefined;
  if (hasValue === hasExpr) fail("INVALID_MCP_INPUT", "text_set requires exactly one of value or expr.");
  if (hasExpr) return { expr: requiredString(input.expr, "text_set expr must be a string.") };
  return { value: requiredString(input.value, "text_set value must be a string.") };
}

function textMatch(input: JsonRecord): unknown {
  if (input.match !== undefined) return input.match;
  const matchText = input.matchText;
  const matchExpr = input.matchExpr;
  const matchAny = input.matchAny;
  const count = [matchText, matchExpr, matchAny].filter((value) => value !== undefined).length;
  if (count !== 1) fail("INVALID_MCP_INPUT", "text_replace requires match or exactly one of matchText, matchExpr, matchAny.");
  if (matchText !== undefined) return { kind: "text", value: requiredString(matchText, "matchText must be a string.") };
  if (matchExpr !== undefined) return { kind: "expr", code: requiredString(matchExpr, "matchExpr must be a string.") };
  return { kind: "any", value: requiredString(matchAny, "matchAny must be a string.") };
}

function textReplacement(input: JsonRecord): unknown {
  if (input.with !== undefined) return input.with;
  const withText = input.withText;
  const withExpr = input.withExpr;
  const count = [withText, withExpr].filter((value) => value !== undefined).length;
  if (count !== 1) fail("INVALID_MCP_INPUT", "text_replace requires with or exactly one of withText, withExpr.");
  if (withText !== undefined) return { kind: "text", value: requiredString(withText, "withText must be a string.") };
  return { kind: "expr", code: requiredString(withExpr, "withExpr must be a string.") };
}

function importFields(input: JsonRecord): Pick<WorkspaceFlowStep, "from" | "to" | "named" | "default" | "namespace" | "name" | "value"> {
  return {
    from: requiredString(input.from, "imports tools require from."),
    ...(input.to === undefined ? {} : { to: requiredString(input.to, "to must be a string.") }),
    ...(input.named === undefined ? {} : { named: input.named as string | string[] }),
    ...(input.default === undefined ? {} : { default: requiredString(input.default, "default must be a string.") }),
    ...(input.namespace === undefined ? {} : { namespace: requiredString(input.namespace, "namespace must be a string.") }),
    ...(input.name === undefined ? {} : { name: requiredString(input.name, "name must be a string.") }),
    ...(input.value === undefined ? {} : { value: requiredString(input.value, "value must be a string.") }),
  };
}

function writeFlagsFromInput(input: JsonRecord): WorkspaceFlowOptions {
  const write = booleanValue(input.write);
  const dryRun = booleanValue(pick(input, "dryRun", "dry-run", "dry_run"));
  if (write && dryRun) fail("INVALID_MCP_INPUT", "Use only one of write or dryRun.");
  return {
    write,
    dryRun,
    backup: booleanValue(input.backup),
    noBackup: booleanValue(pick(input, "noBackup", "no-backup", "no_backup")),
  };
}

function recordInput(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_MCP_INPUT", `${label} arguments must be an object.`);
  }
  return value as JsonRecord;
}

function optionalRecordInput(value: unknown, label: string): JsonRecord {
  if (value === undefined || value === null) return {};
  return recordInput(value, label);
}

function recordOrUndefined(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_MCP_INPUT", `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function pick(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function requiredValue(value: unknown, message: string): unknown {
  if (value === undefined) fail("INVALID_MCP_INPUT", message);
  return value;
}

function requiredPatchPath(value: unknown, message: string): string {
  const path = requiredString(value, message);
  if (path.includes("\n") || path.includes("\r")) fail("INVALID_MCP_INPUT", "Patch-backed file paths cannot contain newlines.");
  return path;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) fail("INVALID_MCP_INPUT", message);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  fail("INVALID_MCP_INPUT", `${label} must be a string or string array.`);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, "Expected a string.");
}

function externalDepsFromInput(input: JsonRecord, label: string): "fail" | "params" {
  const value = pick(input, "externalDeps", "external_deps", "external-deps") ?? "fail";
  if (value === "fail" || value === "params") return value;
  fail("INVALID_MCP_INPUT", label + " externalDeps must be fail or params.");
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) fail("INVALID_MCP_INPUT", `${label} must be an integer.`);
  return numberValue;
}

function optionalNonnegativeInteger(value: unknown, label: string): number | undefined {
  const numberValue = optionalInteger(value, label);
  if (numberValue !== undefined && numberValue < 0) fail("INVALID_MCP_INPUT", `${label} must be a nonnegative integer.`);
  return numberValue;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}
