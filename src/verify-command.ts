import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fail } from "./errors.js";

export type VerifyCommandSpec = {
  command?: string;
  cmd?: string | string[];
  args?: string[];
  timeoutMs?: number;
  cwd?: string;
  rollbackOnFail?: boolean;
};

export type RestorePoint = {
  file: string;
  existed: boolean;
  source: string;
};

type NormalizedVerifyCommand = {
  display: string;
  command: string;
  args: string[];
  shell: boolean;
  timeoutMs: number;
  cwd?: string;
  rollbackOnFail: boolean;
};

export function verifySpecFromInput(input: Record<string, unknown>): VerifyCommandSpec | undefined {
  const raw = input.verify ?? input.verifyCommand ?? input.verify_command;
  if (raw === undefined || raw === null || raw === false) return undefined;
  const topLevelRollback = input.rollbackOnVerifyFail ?? input.rollback_on_verify_fail;
  if (typeof raw === "string") return { command: raw, rollbackOnFail: topLevelRollback === true };
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) return { cmd: raw, rollbackOnFail: topLevelRollback === true };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return normalizeVerifyRecord(raw as Record<string, unknown>);
  fail("INVALID_VERIFY_COMMAND", "verify must be a command string, argv string array, or object.");
}

export function captureRestorePoints(files: string[]): RestorePoint[] {
  const unique = [...new Set(files.filter((file) => typeof file === "string" && file.length > 0))];
  return unique.map((file) => ({ file, existed: existsSync(file), source: existsSync(file) ? readFileSync(file, "utf8") : "" }));
}

export function applyPostVerify<T extends Record<string, unknown>>(result: T, spec: VerifyCommandSpec | undefined, restorePoints: RestorePoint[]): T {
  if (!spec) return result;
  const command = normalizeVerifyCommand(spec);
  const files = Array.isArray(result.files) ? result.files as Array<Record<string, unknown>> : [];
  const wrote = result.written === true || files.some((file) => file && typeof file === "object" && file.written === true);
  if (!wrote) {
    return {
      ...result,
      verify: {
        passed: false,
        skipped: true,
        reason: "no_files_written",
        command: command.display,
      },
      next: ["rerun with write=true before verify command"],
    };
  }

  const startedAt = Date.now();
  const completed = spawnSync(command.command, command.args, {
    cwd: command.cwd,
    shell: command.shell,
    encoding: "utf8",
    timeout: command.timeoutMs,
    maxBuffer: 1_000_000,
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = completed.error && completed.error.name === "ETIMEDOUT";
  const passed = !completed.error && completed.status === 0;
  const rollback = !passed && command.rollbackOnFail ? restoreFiles(restorePoints) : undefined;

  return {
    ...result,
    verify: {
      passed,
      command: command.display,
      exitCode: typeof completed.status === "number" ? completed.status : null,
      signal: completed.signal ?? null,
      timedOut: Boolean(timedOut),
      durationMs,
      timeoutMs: command.timeoutMs,
      stdout: truncateOutput(completed.stdout),
      stderr: truncateOutput(completed.stderr || (completed.error ? completed.error.message : "")),
      ...diagnosticsField(completed.stdout, completed.stderr),
      ...(rollback ? { rollback } : {}),
    },
    ...(passed ? {} : { verification_failed: true, next: command.rollbackOnFail ? ["verification failed; changes rolled back"] : ["verification failed; inspect stdout/stderr, then fix or rerun with rollbackOnFail=true"] }),
  };
}

function normalizeVerifyRecord(record: Record<string, unknown>): VerifyCommandSpec {
  const cmd = record.cmd ?? record.command;
  const args = record.args;
  const timeoutMs = record.timeoutMs ?? record.timeout_ms ?? record.timeout;
  const rollbackOnFail = record.rollbackOnFail ?? record.rollback_on_fail ?? record.rollbackOnVerifyFail ?? record.rollback_on_verify_fail;
  const cwd = record.cwd;
  if (cmd !== undefined && typeof cmd !== "string" && !(Array.isArray(cmd) && cmd.every((item) => typeof item === "string"))) {
    fail("INVALID_VERIFY_COMMAND", "verify.cmd must be a string or string array.");
  }
  if (args !== undefined && !(Array.isArray(args) && args.every((item) => typeof item === "string"))) {
    fail("INVALID_VERIFY_COMMAND", "verify.args must be a string array.");
  }
  if (timeoutMs !== undefined && (!Number.isInteger(Number(timeoutMs)) || Number(timeoutMs) <= 0)) {
    fail("INVALID_VERIFY_COMMAND", "verify.timeoutMs must be a positive integer.");
  }
  if (cwd !== undefined && typeof cwd !== "string") fail("INVALID_VERIFY_COMMAND", "verify.cwd must be a string.");
  return {
    ...(typeof cmd === "string" ? { command: cmd } : cmd !== undefined ? { cmd: cmd as string[] } : {}),
    ...(args === undefined ? {} : { args: args as string[] }),
    ...(timeoutMs === undefined ? {} : { timeoutMs: Number(timeoutMs) }),
    ...(cwd === undefined ? {} : { cwd }),
    rollbackOnFail: rollbackOnFail === true,
  };
}

function normalizeVerifyCommand(spec: VerifyCommandSpec): NormalizedVerifyCommand {
  const timeoutMs = spec.timeoutMs ?? 30_000;
  if (Array.isArray(spec.cmd)) {
    if (spec.cmd.length === 0) fail("INVALID_VERIFY_COMMAND", "verify.cmd array must not be empty.");
    return {
      display: spec.cmd.map(shellDisplayArg).join(" "),
      command: spec.cmd[0],
      args: spec.cmd.slice(1),
      shell: false,
      timeoutMs,
      cwd: spec.cwd,
      rollbackOnFail: spec.rollbackOnFail === true,
    };
  }
  if (typeof spec.cmd === "string") {
    return {
      display: [spec.cmd, ...(spec.args ?? [])].map(shellDisplayArg).join(" "),
      command: spec.cmd,
      args: spec.args ?? [],
      shell: false,
      timeoutMs,
      cwd: spec.cwd,
      rollbackOnFail: spec.rollbackOnFail === true,
    };
  }
  if (typeof spec.command === "string" && spec.command.length > 0) {
    return {
      display: spec.command,
      command: spec.command,
      args: [],
      shell: true,
      timeoutMs,
      cwd: spec.cwd,
      rollbackOnFail: spec.rollbackOnFail === true,
    };
  }
  fail("INVALID_VERIFY_COMMAND", "verify requires command or cmd.");
}

function restoreFiles(points: RestorePoint[]): Record<string, unknown> {
  const restored: Array<Record<string, unknown>> = [];
  for (const point of points) {
    if (point.existed) {
      mkdirSync(dirname(point.file), { recursive: true });
      writeFileSync(point.file, point.source);
      restored.push({ file: point.file, restored: true, existed: true });
    } else {
      rmSync(point.file, { force: true, recursive: false });
      restored.push({ file: point.file, restored: true, existed: false });
    }
  }
  return { attempted: true, files: restored };
}

function diagnosticsField(stdout: unknown, stderr: unknown): Record<string, unknown> {
  const diagnostics = parseTscDiagnostics([stdout, stderr].filter((value) => typeof value === "string").join("\n"));
  return diagnostics.length > 0 ? { diagnostics } : {};
}

function parseTscDiagnostics(output: string): Array<Record<string, unknown>> {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^(.*)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/.exec(line.trim());
    if (!match) return [];
    return [{ file: match[1], line: Number(match[2]), column: Number(match[3]), code: match[4], message: match[5], source: "tsc" }];
  });
}

function truncateOutput(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const max = 20_000;
  return text.length <= max ? text : text.slice(0, max) + "\n... output truncated ...";
}

function shellDisplayArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
