import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "./errors.js";

type JsonRecord = Record<string, unknown>;

type DryRunFileState = {
  path: string;
  existed: boolean;
  hash: string | null;
};

type DryRunArtifact = {
  id: string;
  tool: string;
  args: JsonRecord;
  files: DryRunFileState[];
  createdAt: string;
};

const DRY_RUN_DIR = ".tedit/cache/dry-runs";
const APPLYABLE_TOOLS = new Set([
  "edit",
  "multiedit",
  "patch",
  "mutate",
  "flow",
  "delete_file",
  "rename_file",
  "file_write",
  "write_file",
  "create_file",
  "scaffold_file",
  "new_file",
  "ts_edit",
  "ts_move",
  "jsx_node",
  "jsx_attr",
  "jsx_content",
  "imports",
  "extract_component",
  "extract",
  "refactor",
  "refactor_state",
  "apply_plan",
]);

export function attachDryRunApplySuggestion(tool: string, args: unknown, result: unknown): unknown {
  if (!APPLYABLE_TOOLS.has(tool) || !isRecord(args) || !isRecord(result) || !isDryRunMutation(result)) return result;
  try {
    const id = writeDryRunArtifact(tool, args, result);
    const action = { tool: "apply_dry_run", arguments: { id } };
    const suggestions = Array.isArray(result.suggestions) ? result.suggestions.filter((item): item is string => typeof item === "string") : [];
    result.suggestions = [...new Set([...suggestions, "Review the diff. To apply this exact dry-run without resending arguments, call apply_dry_run with suggestedActions[0].arguments."])].slice(0, 3);
    const actions = Array.isArray(result.suggestedActions) ? result.suggestedActions.filter(isRecord) : [];
    result.suggestedActions = [action, ...actions];
  } catch {
    // ponytail: apply hints are UX sugar; never fail a successful edit because cache writing failed.
  }
  return result;
}

export function loadDryRunApply(id: string): { tool: string; args: JsonRecord } {
  const artifact = JSON.parse(readFileSync(dryRunPath(id), "utf8")) as DryRunArtifact;
  if (!artifact || typeof artifact !== "object" || !APPLYABLE_TOOLS.has(artifact.tool) || !isRecord(artifact.args) || !Array.isArray(artifact.files)) {
    fail("INVALID_DRY_RUN_ARTIFACT", "apply_dry_run artifact is invalid.");
  }
  for (const file of artifact.files) {
    if (!isFileState(file)) fail("INVALID_DRY_RUN_ARTIFACT", "apply_dry_run artifact contains an invalid file state.");
    const current = fileState(file.path);
    if (current.existed !== file.existed || current.hash !== file.hash) {
      fail("DRY_RUN_SOURCE_CHANGED", `Source changed since dry-run: ${file.path}.`, { expected: file, actual: current, suggestion: "Rerun the dry-run and apply the new id." });
    }
  }
  const args: JsonRecord = { ...artifact.args, write: true };
  delete args.dryRun;
  delete args.dry_run;
  delete args["dry-run"];
  return { tool: artifact.tool, args };
}

function writeDryRunArtifact(tool: string, args: JsonRecord, result: JsonRecord): string {
  const files = resultFiles(result).map(fileState);
  if (files.length === 0) throw new Error("No files to apply.");
  const id = `dryrun_${randomUUID()}`;
  mkdirSync(resolve(process.cwd(), DRY_RUN_DIR), { recursive: true });
  writeFileSync(dryRunPath(id), JSON.stringify({ id, tool, args, files, createdAt: new Date().toISOString() }, null, 2));
  return id;
}

function dryRunPath(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) fail("INVALID_MCP_INPUT", "apply_dry_run id contains unsupported characters.");
  return resolve(process.cwd(), DRY_RUN_DIR, `${id}.json`);
}

function isDryRunMutation(result: JsonRecord): boolean {
  if (result.ok !== true) return false;
  if (Number(result.changedCount) > 0 && Number(result.writtenCount) === 0) return true;
  const files = resultFileRecords(result);
  return files.some((file) => file.changed === true) && files.every((file) => file.written !== true);
}

function resultFiles(result: JsonRecord): string[] {
  const files = new Set<string>();
  if (typeof result.path === "string") files.add(result.path);
  if (typeof result.file === "string") files.add(result.file);
  for (const file of resultFileRecords(result)) {
    if (typeof file.path === "string") files.add(file.path);
    if (typeof file.file === "string") files.add(file.file);
  }
  return [...files];
}

function resultFileRecords(result: JsonRecord): JsonRecord[] {
  return Array.isArray(result.files) ? result.files.filter(isRecord) : [];
}

function fileState(path: string): DryRunFileState {
  if (!existsSync(path)) return { path, existed: false, hash: null };
  return { path, existed: true, hash: sha256(readFileSync(path)) };
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFileState(value: unknown): value is DryRunFileState {
  return isRecord(value) && typeof value.path === "string" && typeof value.existed === "boolean" && (typeof value.hash === "string" || value.hash === null);
}
