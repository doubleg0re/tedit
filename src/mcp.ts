#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toErrorResult } from "./errors.js";
import { TEDIT_MCP_TOOLS } from "./mcp-tools.js";
import { packageVersion } from "./version.js";

const server = new McpServer({ name: "tedit", version: packageVersion() });

for (const tool of TEDIT_MCP_TOOLS) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    },
    async (args) => {
      try {
        return toMcpResult(tool.handler(args));
      } catch (error) {
        return toMcpError(error);
      }
    },
  );
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function toMcpResult(result: unknown): CallToolResult {
  const structuredContent = toStructuredContent(result);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent,
  };
}

function toMcpError(error: unknown): CallToolResult {
  const result = toErrorResult(error);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: true,
  };
}

function toStructuredContent(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  return { result };
}

main().catch((error) => {
  process.stderr.write(`tedit MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
