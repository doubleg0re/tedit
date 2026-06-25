import { z } from "zod/v4";
import type { TeditMcpTool } from "../../mcp-tools.js";

// ponytail: explicit any avoids runtime imports from the source module; tighten when dependency typing matters.
export function makeWORKFLOW_TOOLS(deps: any) {
  const { runWorkspaceTool, writeFlagSchema } = deps;
  return [
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
    }
  ] satisfies readonly TeditMcpTool[];
}
