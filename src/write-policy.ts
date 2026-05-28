import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, relative } from "node:path";
import { fail } from "./errors.js";
import { loadQualityConfig } from "./quality.js";

export type WritePolicyMode =
  | "explicit-write"
  | "explicit-dry-run"
  | "env-write"
  | "env-dry-run"
  | "auto-write"
  | "auto-dry-run";

export type WritePolicyFlags = {
  write?: boolean;
  dryRun?: boolean;
  backup?: boolean;
  noBackup?: boolean;
};

export type GitFileStatus = {
  insideWorkTree: boolean;
  root?: string;
  tracked: boolean;
  ignored: boolean;
  dirty: boolean;
  error?: string;
};

export type WritePolicy = {
  file: string;
  write: boolean;
  mode: WritePolicyMode;
  explicit: boolean;
  git: GitFileStatus;
  gitCanRestore: boolean;
  notes: string[];
  backupRequested: boolean;
  noBackup: boolean;
};

export type BackupResult = {
  path?: string;
};

export function resolveWritePolicy(filePath: string, flags: WritePolicyFlags = {}): WritePolicy {
  if (flags.write && flags.dryRun) {
    throw new Error("Use only one of --write or --dry-run.");
  }
  if (flags.backup && flags.noBackup) {
    throw new Error("Use only one of --backup or --no-backup.");
  }

  const file = canonicalPath(filePath);
  const git = inspectGitFile(file);
  const backupRequested = Boolean(flags.backup);
  const noBackup = Boolean(flags.noBackup);

  if (flags.dryRun) {
    return buildPolicy(file, false, "explicit-dry-run", true, git, [], backupRequested, noBackup);
  }
  if (flags.write) {
    return buildPolicy(file, true, "explicit-write", true, git, [], backupRequested, noBackup);
  }

  const configuredDefault = process.env.TEDIT_DEFAULT_WRITE ?? loadQualityConfig(file).defaultWrite;
  if (configuredDefault === "true") return buildPolicy(file, true, "env-write", false, git, [], backupRequested, noBackup);
  if (configuredDefault === "false") return buildPolicy(file, false, "env-dry-run", false, git, [], backupRequested, noBackup);
  if (configuredDefault !== undefined && configuredDefault !== "auto" && configuredDefault !== "") {
    fail("INVALID_WRITE_POLICY", "TEDIT_DEFAULT_WRITE must be true, false, or auto.");
  }

  if (!git.insideWorkTree) {
    return buildPolicy(file, false, "auto-dry-run", false, git, [
      `tedit: no git repository found above ${file}. Defaulting to --dry-run because rollback is not guaranteed. Pass --write to override.`,
    ], backupRequested, noBackup);
  }
  if (git.ignored) {
    return buildPolicy(file, false, "auto-dry-run", false, git, [
      `tedit: ${file} is ignored by git. Defaulting to --dry-run because rollback is not guaranteed. Pass --write to override.`,
    ], backupRequested, noBackup);
  }

  const notes: string[] = [];
  if (!git.tracked) notes.push("tedit: writing to untracked file (no git history to restore from).");
  if (git.dirty) notes.push("tedit: target file has uncommitted changes; recovery requires diff inspection.");
  return buildPolicy(file, true, "auto-write", false, git, notes, backupRequested, noBackup);
}

export function maybeWriteBackup(filePath: string, previous: string, policy: WritePolicy, changed: boolean): BackupResult {
  if (!policy.write || !changed || !existsSync(filePath) || policy.noBackup) return {};

  const env = process.env.TEDIT_BACKUP ?? "auto";
  if (!["auto", "always", "never", ""].includes(env)) {
    fail("INVALID_WRITE_POLICY", "TEDIT_BACKUP must be auto, always, or never.");
  }
  const shouldBackup = policy.backupRequested || env === "always" || ((env === "auto" || env === "") && !policy.gitCanRestore);
  if (!shouldBackup || env === "never") return {};

  const path = `${filePath}.tedit.bak`;
  try {
    writeFileSync(path, previous);
  } catch (error) {
    fail("BACKUP_WRITE_FAILED", `Failed to write backup at ${path}.`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { path };
}

export function writePolicyReport(policy: WritePolicy, backup?: BackupResult): Record<string, unknown> {
  return {
    mode: policy.mode,
    write: policy.write,
    git: policy.git,
    notes: policy.notes,
    ...(backup?.path ? { backup: backup.path } : {}),
  };
}

export function formatWritePolicyNotes(policy: WritePolicy, backup?: BackupResult): string {
  const lines = [...policy.notes];
  if (backup?.path) lines.push(`tedit: backup written -> ${backup.path}`);
  return lines.join("\n");
}

function buildPolicy(
  file: string,
  write: boolean,
  mode: WritePolicyMode,
  explicit: boolean,
  git: GitFileStatus,
  notes: string[],
  backupRequested: boolean,
  noBackup: boolean,
): WritePolicy {
  return {
    file,
    write,
    mode,
    explicit,
    git,
    gitCanRestore: git.insideWorkTree && git.tracked && !git.ignored,
    notes,
    backupRequested,
    noBackup,
  };
}

function inspectGitFile(filePath: string): GitFileStatus {
  const cwd = dirname(filePath);
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) {
    return { insideWorkTree: false, tracked: false, ignored: false, dirty: false, error: root.error };
  }

  const workTreeRoot = root.stdout.trim();
  const relativePath = relative(workTreeRoot, filePath);
  const ignored = git(workTreeRoot, ["check-ignore", "-q", "--", relativePath]).ok;
  const tracked = git(workTreeRoot, ["ls-files", "--error-unmatch", "--", relativePath]).ok;
  const dirty = tracked && git(workTreeRoot, ["status", "--porcelain", "--", relativePath]).stdout.trim().length > 0;
  return {
    insideWorkTree: true,
    root: workTreeRoot,
    tracked,
    ignored,
    dirty,
  };
}

function canonicalPath(filePath: string): string {
  const absolute = resolve(filePath);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return existsSync(parent) ? join(realpathSync(parent), basename(absolute)) : absolute;
}

function git(cwd: string, args: string[]): { ok: true; stdout: string } | { ok: false; stdout: string; error: string } {
  try {
    return { ok: true, stdout: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
