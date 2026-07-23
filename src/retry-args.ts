import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureTeditCacheDir } from "./cache-dir.js";
import { fail } from "./errors.js";

type JsonRecord = Record<string, unknown>;

const RETRY_ARGS_DIR = ".tedit/cache/retry-args";

// 실패 콜의 args를 보존해 재시도에서 재전송 없이 참조할 수 있게 한다. 저장 실패가 원 에러를 가리면 안 된다.
export function storeRetryArgs(tool: string, args: JsonRecord): string | undefined {
  try {
    const id = `args_${randomUUID()}`;
    ensureTeditCacheDir(resolve(process.cwd(), RETRY_ARGS_DIR));
    writeFileSync(retryArgsPath(id), JSON.stringify({ id, tool, args, createdAt: new Date().toISOString() }, null, 2));
    return id;
  } catch {
    return undefined;
  }
}

export function loadRetryArgs(id: string, tool: string): JsonRecord {
  let artifact: { tool?: unknown; args?: unknown };
  try {
    artifact = JSON.parse(readFileSync(retryArgsPath(id), "utf8")) as { tool?: unknown; args?: unknown };
  } catch {
    fail("INVALID_RETRY_REF", `retryFrom id not found: ${id}. Resend the full arguments instead.`);
  }
  if (artifact.tool !== tool || !artifact.args || typeof artifact.args !== "object" || Array.isArray(artifact.args)) {
    fail("INVALID_RETRY_REF", `retryFrom id ${id} does not belong to tool ${tool}.`);
  }
  return artifact.args as JsonRecord;
}

function retryArgsPath(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) fail("INVALID_RETRY_REF", "retryFrom id contains unsupported characters.");
  return resolve(process.cwd(), RETRY_ARGS_DIR, `${id}.json`);
}
