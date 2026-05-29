#!/usr/bin/env node
import { runMcpTool } from "./mcp-tools.js";
import { toErrorResult } from "./errors.js";
import { formatAgentResult, outputOptionsFromRecord } from "./output.js";

type RunnerRequest = {
  name?: unknown;
  args?: unknown;
};

type RunnerResponse =
  | { ok: true; result: unknown }
  | { ok: false; result: unknown };

async function main(): Promise<void> {
  const input = await readStdin();
  const request = JSON.parse(input) as RunnerRequest;
  if (typeof request.name !== "string" || request.name.length === 0) {
    throw new Error("mcp-runner request requires a tool name.");
  }

  const response = runTool(request.name, request.args);
  process.stdout.write(JSON.stringify(response));
}

function runTool(name: string, args: unknown): RunnerResponse {
  try {
    return { ok: true, result: runMcpTool(name, args) };
  } catch (error) {
    const raw = toErrorResult(error);
    const options = args && typeof args === "object" && !Array.isArray(args)
      ? outputOptionsFromRecord(args as Record<string, unknown>)
      : {};
    return { ok: false, result: formatAgentResult(raw, options) };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error) => {
  process.stderr.write(`tedit MCP runner failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
