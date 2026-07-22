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
    return { ok: false, result: formatAgentResult(withActionsHint(raw), options) };
  }
}

// 문법/계약 오사용은 대개 가이드 미확인 신호 — actions 재확인을 최상단 힌트로 밖는다.
function withActionsHint(result: Record<string, unknown>): Record<string, unknown> {
  const code = typeof result.code === "string" ? result.code : "";
  if (!code.startsWith("INVALID_")) return result;
  const existing = Array.isArray(result.suggestions) ? result.suggestions : [];
  const hint = "Input contract mismatch: call the actions tool first - it returns the current op/target contract and examples for every tool.";
  if (existing.includes(hint)) return result;
  return { ...result, suggestions: [hint, ...existing] };
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
