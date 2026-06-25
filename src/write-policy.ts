import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  id?: string;
  manifest?: string;
  style?: "cache" | "sidecar";
};

export type BackupManifestEntry = {
  id: string;
  created_at: string;
  original: string;
  backup: string;
  reason: string;
  original_hash: string;
  replacement_hash?: string;
  command?: string;
  write_policy: Record<string, unknown>;
  restored_at?: string;
};

type BackupManifest = {
  version: 1;
  backups: BackupManifestEntry[];
};

export type BackupCommandOptions = {
  root?: string;
  write?: boolean;
  dryRun?: boolean;
  olderThan?: string;
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
      "tedit: no git repository found above " + file + ". Defaulting to --dry-run because rollback is not guaranteed. Pass --write to override.",
    ], backupRequested, noBackup);
  }
  if (git.ignored) {
    return buildPolicy(file, false, "auto-dry-run", false, git, [
      "tedit: " + file + " is ignored by git. Defaulting to --dry-run because rollback is not guaranteed. Pass --write to override.",
    ], backupRequested, noBackup);
  }

  const notes: string[] = [];
  if (!git.tracked) notes.push("tedit: writing to untracked file (no git history to restore from).");
  if (git.dirty) notes.push("tedit: target file has uncommitted changes; recovery requires diff inspection.");
  return buildPolicy(file, true, "auto-write", false, git, notes, backupRequested, noBackup);
}

export function maybeWriteBackup(filePath: string, previous: string, policy: WritePolicy, changed: boolean, replacement?: string): BackupResult {
  const file = policy.file || canonicalPath(filePath);
  if (!policy.write || !changed || !existsSync(file) || policy.noBackup) return {};

  const env = process.env.TEDIT_BACKUP ?? "auto";
  if (!["auto", "always", "never", ""].includes(env)) {
    fail("INVALID_WRITE_POLICY", "TEDIT_BACKUP must be auto, always, or never.");
  }
  const shouldBackup = policy.backupRequested || env === "always" || ((env === "auto" || env === "") && !policy.gitCanRestore);
  if (!shouldBackup || env === "never") return {};

  const reason = policy.backupRequested ? "requested" : env === "always" ? "always" : "no-git-restore";
  const style = process.env.TEDIT_BACKUP_STYLE ?? "cache";
  if (style === "sidecar") return writeSidecarBackup(file, previous);
  if (style !== "cache" && style !== "") {
    fail("INVALID_WRITE_POLICY", "TEDIT_BACKUP_STYLE must be cache or sidecar.");
  }

  return writeCachedBackup(file, previous, policy, reason, replacement);
}

export function writePolicyReport(policy: WritePolicy, backup?: BackupResult): Record<string, unknown> {
  return {
    mode: policy.mode,
    write: policy.write,
    git: policy.git,
    notes: policy.notes,
    ...(backup?.path ? { backup: agentPath(backup.path) } : {}),
    ...(backup?.id ? { backup_id: backup.id } : {}),
    ...(backup?.manifest ? { backup_manifest: agentPath(backup.manifest) } : {}),
  };
}

export function formatWritePolicyNotes(policy: WritePolicy, backup?: BackupResult): string {
  const lines = [...policy.notes];
  if (backup?.path) lines.push("tedit: backup written -> " + agentPath(backup.path));
  return lines.join("\n");
}

export function listBackups(root = process.cwd()): { success: true; root: string; manifest: string; backups: BackupManifestEntry[] } {
  const resolvedRoot = resolve(root);
  return {
    success: true,
    root: resolvedRoot,
    manifest: manifestPath(resolvedRoot),
    backups: readManifest(resolvedRoot).backups,
  };
}

export function restoreBackup(id: string, options: BackupCommandOptions = {}): Record<string, unknown> {
  if (options.write && options.dryRun) throw new Error("Use only one of --write or --dry-run.");
  const root = resolve(options.root ?? process.cwd());
  const manifest = readManifest(root);
  const entry = manifest.backups.find((candidate) => candidate.id === id);
  if (!entry) fail("BACKUP_NOT_FOUND", "Backup not found: " + id + ".", { root, manifest: manifestPath(root) });
  if (!existsSync(entry.backup)) fail("BACKUP_FILE_NOT_FOUND", "Backup file not found: " + entry.backup + ".", { id });

  const backupSource = readFileSync(entry.backup, "utf8");
  const current = existsSync(entry.original) ? readFileSync(entry.original, "utf8") : "";
  const changed = current !== backupSource;
  const shouldWrite = Boolean(options.write);
  if (shouldWrite && changed) {
    mkdirSync(dirname(entry.original), { recursive: true });
    writeFileSync(entry.original, backupSource);
    entry.restored_at = new Date().toISOString();
    writeManifest(root, manifest);
  }

  return {
    success: true,
    id,
    file: entry.original,
    backup: entry.backup,
    changed,
    restored: shouldWrite && changed,
    written: shouldWrite && changed,
    ...(shouldWrite ? {} : { next: ["rerun with --write to restore"] }),
  };
}

export function cleanBackups(options: BackupCommandOptions = {}): Record<string, unknown> {
  if (options.write && options.dryRun) throw new Error("Use only one of --write or --dry-run.");
  const root = resolve(options.root ?? process.cwd());
  const manifest = readManifest(root);
  const olderThan = options.olderThan ?? "0s";
  const olderThanMs = parseDuration(olderThan);
  const cutoff = Date.now() - olderThanMs;
  const selected = manifest.backups.filter((entry) => Date.parse(entry.created_at) <= cutoff);
  const shouldWrite = Boolean(options.write);

  if (shouldWrite) {
    for (const entry of selected) {
      rmSync(join(backupRoot(root), entry.id), { recursive: true, force: true });
    }
    const selectedIds = new Set(selected.map((entry) => entry.id));
    manifest.backups = manifest.backups.filter((entry) => !selectedIds.has(entry.id));
    writeManifest(root, manifest);
  }

  return {
    success: true,
    root,
    older_than: olderThan,
    write: shouldWrite,
    cleaned: selected,
    deleted: shouldWrite ? selected.length : 0,
    ...(shouldWrite ? {} : { next: ["rerun with --write to delete listed backups"] }),
  };
}

function writeCachedBackup(file: string, previous: string, policy: WritePolicy, reason: string, replacement?: string): BackupResult {
  const root = backupWorkspaceRoot(file, policy);
  const id = backupId();
  const backupPath = join(backupRoot(root), id, safeRelative(root, file) + ".bak");
  const manifest = readManifest(root);
  try {
    mkdirSync(dirname(backupPath), { recursive: true });
    writeFileSync(backupPath, previous);
    manifest.backups.push({
      id,
      created_at: new Date().toISOString(),
      original: file,
      backup: backupPath,
      reason,
      original_hash: sha256(previous),
      ...(replacement === undefined ? {} : { replacement_hash: sha256(replacement) }),
      command: process.argv.slice(1).join(" "),
      write_policy: {
        mode: policy.mode,
        git_can_restore: policy.gitCanRestore,
        git: policy.git,
      },
    });
    writeManifest(root, manifest);
  } catch (error) {
    fail("BACKUP_WRITE_FAILED", "Failed to write backup at " + backupPath + ".", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { path: backupPath, id, manifest: manifestPath(root), style: "cache" };
}

function writeSidecarBackup(file: string, previous: string): BackupResult {
  const path = file + ".tedit.bak";
  try {
    writeFileSync(path, previous);
  } catch (error) {
    fail("BACKUP_WRITE_FAILED", "Failed to write backup at " + path + ".", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { path, style: "sidecar" };
}

function readManifest(root: string): BackupManifest {
  const path = manifestPath(root);
  if (!existsSync(path)) return { version: 1, backups: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BackupManifest>;
  return { version: 1, backups: Array.isArray(parsed.backups) ? parsed.backups : [] };
}

function writeManifest(root: string, manifest: BackupManifest): void {
  const path = manifestPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, backups: manifest.backups }, null, 2) + "\n");
}

function backupWorkspaceRoot(file: string, policy: WritePolicy): string {
  if (policy.git.root) return policy.git.root;
  const cwd = process.cwd();
  const rel = relative(cwd, file);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return cwd;
  return dirname(file);
}

function backupRoot(root: string): string {
  return join(root, ".tedit-cache", "backups");
}

function manifestPath(root: string): string {
  return join(backupRoot(root), "manifest.json");
}

function safeRelative(root: string, file: string): string {
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return basename(file);
  return rel;
}

function agentPath(filePath: string): string {
  return filePath.split("\\").join("/");
}

function backupId(): string {
  return new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17) + "-" + randomUUID().slice(0, 8);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value);
  if (!match) fail("INVALID_DURATION", "Duration must look like 30s, 10m, 2h, or 7d.", { value });
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return amount * scale;
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
