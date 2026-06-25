import { existsSync, readFileSync } from "node:fs";
import { parseVerificationFields, verifyParseForFile, type ParseVerificationFields } from "./base-edit.js";
import { fail, TeditError } from "./errors.js";
import { commitWorkspaceUpdates, type WorkspaceFileChange, type WorkspaceFlowOptions } from "./workspace-flow.js";

export type PatchResult = {
  success: true;
  patches: Array<{ file: string; hunks: number; added: boolean; deleted: boolean; renamed: boolean; old_file?: string }>;
  parse: Array<{ file: string } & ParseVerificationFields>;
  files: WorkspaceFileChange[];
};

export type ParsedPatchFile = {
  oldPath: string;
  newPath: string;
  file: string;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  hunks: PatchHunk[];
};

export type PatchHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
};

export type PatchLine =
  | { kind: "context"; text: string }
  | { kind: "delete"; text: string }
  | { kind: "add"; text: string };

export function runPatchInput(input: string, options: WorkspaceFlowOptions = {}): PatchResult {
  const patches = parsePatchInput(input);
  const updates = patches.flatMap((patch): WorkspaceFileChangeInput[] => {
    const { sourceFile, targetFile } = resolvePatchFiles(patch);

    if (!patch.added && (!sourceFile || !existsSync(sourceFile))) {
      fail("FILE_NOT_FOUND", `File not found: ${sourceFile ?? patch.oldPath}`);
    }
    if (patch.added && existsSync(targetFile) && readFileSync(targetFile, "utf8").length > 0) {
      fail("PATCH_FILE_EXISTS", `Patch adds ${targetFile}, but the file already exists.`);
    }
    if (patch.renamed && sourceFile !== targetFile && existsSync(targetFile)) {
      fail("PATCH_FILE_EXISTS", `Patch renames ${sourceFile} to ${targetFile}, but the destination already exists.`);
    }

    const source = patch.added ? "" : readFileSync(sourceFile ?? targetFile, "utf8");
    if (patch.deleted) {
      if (patch.hunks.length > 0) applyPatchToSource(source, patch);
      return [{ file: targetFile, deleted: true }];
    }

    const next = patch.hunks.length === 0 ? source : applyPatchToSource(source, patch);
    if (patch.renamed && sourceFile && sourceFile !== targetFile) {
      return [{ file: sourceFile, deleted: true }, { file: targetFile, source: next }];
    }
    return [{ file: targetFile, source: next }];
  });

  const parse = updates.flatMap((update) => {
    if (update.deleted) return [];
    try {
      const verification = verifyParseForFile(update.file, update.source);
      return [{
        file: update.file,
        ...parseVerificationFields(verification),
      }];
    } catch (error) {
      rethrowWithPatchContext(error, update.file);
    }
  });

  const files = commitWorkspaceUpdates(updates, options);
  return {
    success: true,
    patches: patches.map((patch) => {
      const { sourceFile, targetFile } = resolvePatchFiles(patch);
      return {
        file: targetFile,
        hunks: patch.hunks.length,
        added: patch.added,
        deleted: patch.deleted,
        renamed: patch.renamed,
        ...(patch.renamed ? { old_file: sourceFile } : {}),
      };
    }),
    parse,
    files,
  };
}

type WorkspaceFileChangeInput = Parameters<typeof commitWorkspaceUpdates>[0][number];

export function parsePatchInput(input: string): ParsedPatchFile[] {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("*** Begin Patch")) return parseApplyPatch(input);
  return parseUnifiedPatch(input);
}

export function parseUnifiedPatch(input: string): ParsedPatchFile[] {
  const lines = input.split(/\r?\n/);
  const files: ParsedPatchFile[] = [];
  let index = 0;
  let pendingRename: { oldPath?: string; newPath?: string } = {};

  const pushPendingRename = (): void => {
    if (!pendingRename.oldPath && !pendingRename.newPath) return;
    if (!pendingRename.oldPath || !pendingRename.newPath) {
      fail("INVALID_PATCH", "Incomplete rename metadata in unified patch.");
    }
    const oldPath = pendingRename.oldPath;
    const newPath = pendingRename.newPath;
    files.push({
      oldPath,
      newPath,
      file: normalizePatchPath(newPath),
      added: false,
      deleted: false,
      renamed: normalizePatchPath(oldPath) !== normalizePatchPath(newPath),
      hunks: [],
    });
    pendingRename = {};
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line) {
      index++;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      pushPendingRename();
      pendingRename = {};
      index++;
      continue;
    }
    if (line.startsWith("rename from ")) {
      pendingRename.oldPath = parsePatchPath(line.slice("rename from ".length));
      index++;
      continue;
    }
    if (line.startsWith("rename to ")) {
      pendingRename.newPath = parsePatchPath(line.slice("rename to ".length));
      index++;
      continue;
    }
    if (isUnifiedMetadataLine(line)) {
      index++;
      continue;
    }
    if (!line.startsWith("--- ")) {
      fail("INVALID_PATCH", `Expected file header at patch line ${index + 1}.`);
    }

    const oldPath = parsePatchPath(line.slice(4));
    index++;
    const nextHeader = lines[index];
    if (!nextHeader?.startsWith("+++ ")) {
      fail("INVALID_PATCH", `Expected +++ file header after patch line ${index}.`);
    }
    const newPath = parsePatchPath(nextHeader.slice(4));
    index++;

    const deleted = newPath === "/dev/null";
    const added = oldPath === "/dev/null";
    const renamed = !added && !deleted && normalizePatchPath(oldPath) !== normalizePatchPath(newPath);
    const file = normalizePatchPath(deleted ? oldPath : newPath);
    const hunks: PatchHunk[] = [];

    while (index < lines.length) {
      const current = lines[index];
      if (current.startsWith("--- ") || current.startsWith("diff --git ")) break;
      if (!current || isUnifiedMetadataLine(current) || current.startsWith("rename from ") || current.startsWith("rename to ")) {
        index++;
        continue;
      }
      if (!current.startsWith("@@ ")) {
        fail("INVALID_PATCH", `Expected hunk header at patch line ${index + 1}.`);
      }

      const hunk = parseHunkHeader(current, index + 1);
      index++;
      while (index < lines.length) {
        const hunkLine = lines[index];
        if (hunkLine.startsWith("@@ ") || hunkLine.startsWith("--- ") || hunkLine.startsWith("diff --git ")) break;
        if (hunkLine.startsWith("\\ No newline at end of file")) {
          index++;
          continue;
        }
        if (hunkLine.startsWith(" ")) hunk.lines.push({ kind: "context", text: hunkLine.slice(1) });
        else if (hunkLine.startsWith("-")) hunk.lines.push({ kind: "delete", text: hunkLine.slice(1) });
        else if (hunkLine.startsWith("+")) hunk.lines.push({ kind: "add", text: hunkLine.slice(1) });
        else if (hunkLine === "" && index === lines.length - 1) break;
        else fail("INVALID_PATCH", `Invalid hunk line at patch line ${index + 1}.`);
        index++;
      }
      hunks.push(hunk);
    }

    if (hunks.length === 0 && !deleted && !renamed) fail("INVALID_PATCH", `Patch for ${file} has no hunks.`);
    files.push({ oldPath, newPath, file, added, deleted, renamed, hunks });
    pendingRename = {};
  }

  pushPendingRename();
  if (files.length === 0) fail("INVALID_PATCH", "Patch contains no file changes.");
  return files;
}

export function parseApplyPatch(input: string): ParsedPatchFile[] {
  const lines = input.split(/\r?\n/);
  let index = firstNonEmptyLine(lines);
  if (lines[index] !== "*** Begin Patch") {
    fail("INVALID_PATCH", "apply-patch input must start with *** Begin Patch.");
  }
  index++;

  const files: ParsedPatchFile[] = [];
  while (index < lines.length) {
    const line = lines[index];
    if (!line) {
      index++;
      continue;
    }
    if (line === "*** End Patch") {
      index++;
      break;
    }
    if (line.startsWith("*** Add File: ")) {
      const file = line.slice("*** Add File: ".length).trim();
      index++;
      const addedLines: string[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const current = lines[index];
        if (!current.startsWith("+")) fail("INVALID_PATCH", `Add File lines for ${file} must start with + at patch line ${index + 1}.`);
        addedLines.push(current.slice(1));
        index++;
      }
      files.push({
        oldPath: "/dev/null",
        newPath: file,
        file,
        added: true,
        deleted: false,
        renamed: false,
        hunks: [{
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: addedLines.length,
          lines: addedLines.map((text) => ({ kind: "add", text })),
        }],
      });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const file = line.slice("*** Delete File: ".length).trim();
      files.push({ oldPath: file, newPath: "/dev/null", file, added: false, deleted: true, renamed: false, hunks: [] });
      index++;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const file = line.slice("*** Update File: ".length).trim();
      index++;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = lines[index].slice("*** Move to: ".length).trim();
        index++;
      }
      const hunks: string[][] = [[]];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const current = lines[index];
        if (current.startsWith("@@")) {
          if (hunks[hunks.length - 1].length > 0) hunks.push([]);
          index++;
          continue;
        }
        if (current === "\\ No newline at end of file") {
          index++;
          continue;
        }
        hunks[hunks.length - 1].push(current);
        index++;
      }
      files.push(buildApplyPatchUpdate(file, hunks, moveTo));
      continue;
    }
    fail("INVALID_PATCH", `Unknown apply-patch directive at patch line ${index + 1}: ${line}`);
  }

  if (index < lines.length && lines.slice(index).some((line) => line.length > 0)) {
    fail("INVALID_PATCH", "Unexpected content after *** End Patch.");
  }
  if (files.length === 0) fail("INVALID_PATCH", "Patch contains no file changes.");
  return files;
}

function buildApplyPatchUpdate(file: string, hunks: string[][], moveTo?: string): ParsedPatchFile {
  const patchHunks = hunks.flatMap((lines, hunkIndex): PatchHunk[] => {
    const hunkLines = lines
      .filter((line) => line !== "")
      .map((line, index): PatchLine => {
        if (line.startsWith(" ")) return { kind: "context", text: line.slice(1) };
        if (line.startsWith("-")) return { kind: "delete", text: line.slice(1) };
        if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
        fail("INVALID_PATCH", `Update File lines for ${file} must start with space, -, +, or @@ near hunk ${hunkIndex + 1} line ${index + 1}.`);
      });

    if (hunkLines.length === 0) return [];
    return [{
      oldStart: 0,
      oldCount: hunkLines.filter((line) => line.kind !== "add").length,
      newStart: 0,
      newCount: hunkLines.filter((line) => line.kind !== "delete").length,
      lines: hunkLines,
    }];
  });

  if (patchHunks.length === 0 && !moveTo) fail("INVALID_PATCH", `Patch for ${file} has no update lines.`);
  return {
    oldPath: file,
    newPath: moveTo ?? file,
    file: moveTo ?? file,
    added: false,
    deleted: false,
    renamed: Boolean(moveTo && normalizePatchPath(moveTo) !== normalizePatchPath(file)),
    hunks: patchHunks,
  };
}

function applyPatchToSource(source: string, patch: ParsedPatchFile): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(source);
  let offset = 0;

  patch.hunks.forEach((hunk, hunkIndex) => {
    const start = hunk.oldStart === 0 && !patch.added
      ? findContextualHunkStart(lines, hunk, patch, hunkIndex)
      : hunk.oldCount === 0 ? hunk.oldStart + offset : hunk.oldStart - 1 + offset;
    let cursor = Math.max(0, start);
    let removeCount = 0;
    const replacement: string[] = [];

    for (const line of hunk.lines) {
      if (line.kind === "add") {
        replacement.push(`${line.text}${eol}`);
        continue;
      }

      const sourceLine = lines[cursor + removeCount];
      if (sourceLine === undefined || stripEol(sourceLine) !== line.text) {
        fail("PATCH_HUNK_FAILED", `Patch hunk ${hunkIndex + 1} failed for ${patch.file}.`, {
          file: patch.file,
          hunk: hunkIndex,
          expected: line.text,
          actual: sourceLine === undefined ? null : stripEol(sourceLine),
          old_start: hunk.oldStart,
          suggestions: patchRecoveryNext(patch.file, hunk.oldStart),
        });
      }

      if (line.kind === "context") replacement.push(sourceLine);
      removeCount++;
    }

    lines.splice(cursor, removeCount, ...replacement);
    offset += replacement.length - removeCount;
  });

  return lines.join("");
}

function isUnifiedMetadataLine(line: string): boolean {
  return line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ");
}

function findContextualHunkStart(lines: string[], hunk: PatchHunk, patch: ParsedPatchFile, hunkIndex: number): number {
  const expected = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
  if (expected.length === 0) {
    fail("UNSUPPORTED_PATCH", `Patch hunk ${hunkIndex + 1} for ${patch.file} has no context or deleted lines.`);
  }

  const matches: number[] = [];
  for (let cursor = 0; cursor <= lines.length - expected.length; cursor++) {
    if (expected.every((text, offset) => stripEol(lines[cursor + offset] ?? "") === text)) {
      matches.push(cursor);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail("PATCH_HUNK_NOT_UNIQUE", `Patch hunk ${hunkIndex + 1} matched ${matches.length} locations for ${patch.file}.`, {
      file: patch.file,
      hunk: hunkIndex,
      matches,
      suggestions: [
        "Regenerate the patch with more surrounding context.",
        "For a small change, use tedit edit/multiedit with an exact current snippet.",
      ],
    });
  }
  fail("PATCH_HUNK_FAILED", `Patch hunk ${hunkIndex + 1} failed for ${patch.file}.`, {
    file: patch.file,
    hunk: hunkIndex,
    expected: expected[0],
    actual: null,
    suggestions: patchRecoveryNext(patch.file, hunk.oldStart),
  });
}

function patchRecoveryNext(file: string, line: number): string[] {
  const targetLine = Math.max(1, line);
  return [
    `Inspect current context: tedit inspect-range ${JSON.stringify(file)} --lines ${targetLine}:${targetLine} --context 3 --json.`,
    "Regenerate the patch against the current file contents.",
    "For a small change, use tedit edit/multiedit with an exact current snippet.",
  ];
}

function parseHunkHeader(line: string, lineNumber: number): PatchHunk {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) fail("INVALID_PATCH", `Invalid hunk header at patch line ${lineNumber}.`);
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
    lines: [],
  };
}

function firstNonEmptyLine(lines: string[]): number {
  const index = lines.findIndex((line) => line.length > 0);
  return index < 0 ? 0 : index;
}

function parsePatchPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "/dev/null") return trimmed;
  if (trimmed.startsWith("\"")) {
    const end = trimmed.lastIndexOf("\"");
    if (end > 0) return trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

function resolvePatchFiles(patch: ParsedPatchFile): { sourceFile?: string; targetFile: string } {
  const sourceFile = patch.added ? undefined : resolveExistingPatchPath(patch.oldPath);
  const targetFile = patch.deleted
    ? sourceFile ?? resolvePatchPath(patch.oldPath)
    : resolveTargetPatchPath(patch.newPath, patch.oldPath, sourceFile);
  return { sourceFile, targetFile };
}

function resolveExistingPatchPath(path: string): string {
  const normalized = normalizePatchPath(path);
  if (existsSync(normalized)) return normalized;
  const absolute = gitPrefixedAbsolutePath(path);
  if (absolute && existsSync(absolute)) return absolute;
  return normalized;
}

function resolveTargetPatchPath(path: string, oldPath: string, sourceFile?: string): string {
  const normalized = normalizePatchPath(path);
  if (existsSync(normalized)) return normalized;
  const absolute = gitPrefixedAbsolutePath(path);
  const oldAbsolute = gitPrefixedAbsolutePath(oldPath);
  if (absolute && sourceFile && oldAbsolute && sourceFile === oldAbsolute) return absolute;
  if (absolute && existsSync(absolute)) return absolute;
  return normalized;
}

function resolvePatchPath(path: string): string {
  const normalized = normalizePatchPath(path);
  const absolute = gitPrefixedAbsolutePath(path);
  if (absolute && existsSync(absolute)) return absolute;
  return normalized;
}

function normalizePatchPath(path: string): string {
  const windowsAbsolute = windowsGitPrefixedAbsolutePath(path);
  if (windowsAbsolute) return windowsAbsolute;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function gitPrefixedAbsolutePath(path: string): string | undefined {
  const windowsAbsolute = windowsGitPrefixedAbsolutePath(path);
  if (windowsAbsolute) return windowsAbsolute;
  if (!path.startsWith("a/") && !path.startsWith("b/")) return undefined;
  const stripped = path.slice(2);
  if (!stripped) return undefined;
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function windowsGitPrefixedAbsolutePath(path: string): string | undefined {
  return /^[ab][A-Za-z]:[\\/]/.test(path) ? path.slice(1) : undefined;
}

function splitLines(source: string): string[] {
  if (source.length === 0) return [];
  return source.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function stripEol(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function rethrowWithPatchContext(error: unknown, file: string): never {
  if (error instanceof TeditError) {
    fail(error.code, error.message, {
      file,
      ...(error.details === undefined ? {} : { cause: error.details }),
    });
  }
  throw error;
}
