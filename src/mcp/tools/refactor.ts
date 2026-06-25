import { z } from "zod/v4";
import type { TeditMcpTool } from "../../mcp-tools.js";

// ponytail: explicit any avoids runtime imports from the source module; tighten when dependency typing matters.
export function makeREFACTOR_TOOLS(deps: any): readonly TeditMcpTool[] {
  const { fileSchema, runAnalyzeStateTool, runRefactorTool, selectorSchema, writeFlagSchema } = deps;
  return [
    {
      name: "refactor",
      title: "Refactor",
      description: "Facade for refactor workflows: React state/extract, saved plans, and TS module split helpers for moving symbols or registry entries.",
      category: "refactor",
      aliases: ["refactor_state", "extract_component", "apply_plan", "symbol_graph", "move_symbols", "extract_array_entries", "module_split_plan"],
      bestFor: ["agent default access to CLI refactors", "React state refactors", "JSX component extraction", "TS module splitting", "reviewable refactor plans"],
      inputSchema: {
        kind: z.enum(["state", "refactor-state", "extract", "extract-component", "apply-plan", "symbol-graph", "symbol_graph", "move-symbols", "move_symbols", "extract-array-entries", "extract_array_entries", "module-split-plan", "module_split_plan"]).describe("Which refactor workflow to run."),
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
        symbols: z.array(z.string()).optional().describe("Top-level TS symbols for kind=move_symbols."),
        array: z.string().optional().describe("Top-level array registry name for kind=extract_array_entries."),
        exportName: z.string().optional().describe("Exported array name created by kind=extract_array_entries."),
        where: z.record(z.string(), z.unknown()).optional().describe("Literal object-property match for kind=extract_array_entries."),
        entries: z.array(z.string()).optional().describe("Entry names for kind=extract_array_entries."),
        operations: z.array(z.record(z.string(), z.unknown())).optional().describe("Operations for kind=module_split_plan."),
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
    }
  ] satisfies readonly TeditMcpTool[];
}


// ponytail: explicit any mirrors the generated registry factories; split deps when handlers move here.
export function makeREFACTOR_PLAN_TOOLS(deps: any): readonly TeditMcpTool[] {
  const { fileSchema, runApplyPlanTool, runExtractPlanTool, runRefactorStatePlanTool, runRefactorStateTool, selectorSchema, writeFlagSchema } = deps;
  return [
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
    }
  ] satisfies readonly TeditMcpTool[];
}
