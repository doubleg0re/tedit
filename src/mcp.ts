#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TEDIT_MCP_TOOLS } from "./mcp-tools.js";
import { packageVersion } from "./version.js";

const server = new McpServer({ name: "tedit", version: packageVersion() });
const runnerPath = fileURLToPath(new URL("./mcp-runner.js", import.meta.url));

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
      return runToolInCurrentDist(tool.name, args);
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
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function toMcpErrorResult(result: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: toStructuredContent(result),
    isError: true,
  };
}

function runToolInCurrentDist(name: string, args: unknown): Promise<CallToolResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on("error", (error) => {
      resolve(toMcpErrorResult(runnerFailureResult(error.message)));
    });
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        resolve(toMcpErrorResult(runnerFailureResult(err || `runner exited with code ${code}`)));
        return;
      }
      try {
        const response = JSON.parse(out) as { ok?: unknown; result?: unknown };
        if (response.ok === true) resolve(toMcpResult(response.result));
        else resolve(toMcpErrorResult(response.result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolve(toMcpErrorResult(runnerFailureResult(`invalid runner output: ${message}${err ? "\n" + err : ""}`)));
      }
    });
    child.stdin.end(JSON.stringify({ name, args }));
  });
}

function runnerFailureResult(error: string): Record<string, unknown> {
  return {
    ok: false,
    kind: "error",
    code: "MCP_RUNNER_FAILED",
    error: "tedit MCP runner failed.",
    summary: "tedit MCP runner failed.",
    details: { error },
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
