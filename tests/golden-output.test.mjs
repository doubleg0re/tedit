import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;

test("golden: verify-file compact and detailed output contracts", () => {
  const workspace = createWorkspace();

  const detailed = runJson(["verify-file", "config.json", "--json"], workspace);
  assert.deepEqual(detailed, {
    success: true,
    file: "config.json",
    parse_verified: true,
    parser: "json",
    warnings: [],
  });

  const compact = runCompactJson(["verify-file", "config.json"], workspace);
  assert.deepEqual(compact, {
    ok: true,
    kind: "verify-file",
    summary: "parse verified with json",
    path: "config.json",
    parse_verified: true,
    parser: "json",
  });

  const detailedMany = runJson(["verify-file", "config.json", "src/Page.tsx", "--json"], workspace);
  assert.deepEqual(detailedMany, {
    success: true,
    kind: "verify-files",
    files: [
      {
        file: "config.json",
        parse_verified: true,
        parser: "json",
        warnings: [],
      },
      {
        file: "src/Page.tsx",
        parse_verified: true,
        parser: "jsx",
        warnings: [],
      },
    ],
    count: 2,
    verifiedCount: 2,
    skippedCount: 0,
    warningCount: 0,
  });

  const compactMany = runCompactJson(["verify-file", "config.json", "src/Page.tsx"], workspace);
  assert.deepEqual(compactMany, {
    ok: true,
    kind: "verify-files",
    summary: "2 files checked; 2 parse verified",
    count: 2,
    verifiedCount: 2,
    skippedCount: 0,
    warningCount: 0,
    files: [
      {
        path: "config.json",
        parse_verified: true,
        parser: "json",
      },
      {
        path: "src/Page.tsx",
        parse_verified: true,
        parser: "jsx",
      },
    ],
  });
});

test("golden: inspect-range compact output contract", () => {
  const workspace = createWorkspace();
  const compact = runCompactJson(["inspect-range", "src/Page.tsx", "--lines", "2:3", "--context", "1"], workspace);

  assert.deepEqual(compact, {
    ok: true,
    kind: "inspect-range",
    summary: "4 lines",
    file: "src/Page.tsx",
    requested: { start: 2, end: 3 },
    expanded: { start: 1, end: 4 },
    byteRange: { start: 0, end: 99, line: 1, column: 1, endLine: 4, endColumn: 1, lineRange: "1:4" },
    lines: [
      { number: 1, text: "export function Page() {" },
      { number: 2, text: "  const label = \"삭제\";" },
      { number: 3, text: "  return <button aria-label=\"삭제\">{label}</button>;" },
      { number: 4, text: "}" },
    ],
    parse_verified: true,
    parser: "jsx",
    suggested: {
      tool: "edit",
      file: "src/Page.tsx",
      findLines: "2:3",
      replaceHint: "findLines replaces whole lines; include the trailing newline unless replacing the final line.",
    },
    suggestions: [{
      tool: "edit",
      arguments: {
        file: "src/Page.tsx",
        findLines: "2:3",
        replace: "<replacement including trailing newline>",
      },
    }],
    path: "src/Page.tsx",
  });
});

test("golden: search-text detailed output contract", () => {
  const workspace = createWorkspace();
  const detailed = runJson(["search-text", "삭제", "src/Page.tsx", "--context", "1", "--multiedit-spec", "--replace", "Delete", "--json"], workspace);

  assert.deepEqual(detailed, {
    success: true,
    kind: "search-text",
    query: "삭제",
    regex: false,
    paths: ["src/Page.tsx"],
    context: 1,
    multiedit: {
      edits: [{
        file: "<tmp>/src/Page.tsx",
        findExact: "삭제",
        replace: "Delete",
        replaceAll: true,
        expectCount: 2,
      }],
      count: 1,
      replace: "Delete",
      truncated: false,
    },
    results: [
      {
        id: "text_1",
        file: "<tmp>/src/Page.tsx",
        path: "src/Page.tsx",
        match: "삭제",
        range: { start: 42, end: 44, line: 2, column: 18, endLine: 2, endColumn: 19, lineRange: "2" },
        preview: "  const label = \"삭제\";",
        suggested: {
          tool: "edit",
          file: "<tmp>/src/Page.tsx",
          findLines: "2",
          replaceHint: "findLines replaces whole lines; include the trailing newline unless replacing the final line.",
        },
        suggestions: [
          {
            tool: "inspect_range",
            cliCommand: "inspect-range",
            arguments: { file: "<tmp>/src/Page.tsx", lines: "2", context: 1 },
          },
          {
            tool: "edit",
            arguments: { file: "<tmp>/src/Page.tsx", findLines: "2", replace: "<replacement including trailing newline>" },
          },
        ],
        context: {
          expanded: { start: 1, end: 3 },
          lines: [
            { number: 1, text: "export function Page() {" },
            { number: 2, text: "  const label = \"삭제\";" },
            { number: 3, text: "  return <button aria-label=\"삭제\">{label}</button>;" },
          ],
        },
      },
      {
        id: "text_2",
        file: "<tmp>/src/Page.tsx",
        path: "src/Page.tsx",
        match: "삭제",
        range: { start: 76, end: 78, line: 3, column: 30, endLine: 3, endColumn: 31, lineRange: "3" },
        preview: "  return <button aria-label=\"삭제\">{label}</button>;",
        suggested: {
          tool: "edit",
          file: "<tmp>/src/Page.tsx",
          findLines: "3",
          replaceHint: "findLines replaces whole lines; include the trailing newline unless replacing the final line.",
        },
        suggestions: [
          {
            tool: "inspect_range",
            cliCommand: "inspect-range",
            arguments: { file: "<tmp>/src/Page.tsx", lines: "3", context: 1 },
          },
          {
            tool: "edit",
            arguments: { file: "<tmp>/src/Page.tsx", findLines: "3", replace: "<replacement including trailing newline>" },
          },
        ],
        context: {
          expanded: { start: 2, end: 4 },
          lines: [
            { number: 2, text: "  const label = \"삭제\";" },
            { number: 3, text: "  return <button aria-label=\"삭제\">{label}</button>;" },
            { number: 4, text: "}" },
          ],
        },
      },
    ],
    count: 2,
    truncated: false,
  });
});

test("golden: edit compact mutation output contract", () => {
  const workspace = createWorkspace();
  const compact = runCompactJson([
    "edit", "src/Page.tsx", "--find", "삭제", "--replace", "Delete", "--replace-all", "--dry-run",
  ], workspace);

  assert.deepEqual(compact, {
    ok: true,
    kind: "mutation",
    summary: "1 file would change; parse verified with jsx",
    changedCount: 1,
    writtenCount: 0,
    files: [{
      path: "src/Page.tsx",
      change: "modified",
      persisted: false,
      parse_verified: true,
      parser: "jsx",
      diffAvailable: true,
      hunks: 1,
      bytesDelta: 8,
      diff: {
        mode: "inline",
        bytes: 245,
        hunks: 1,
        bytesDelta: 8,
        preview: "--- src/Page.tsx\n+++ src/Page.tsx\n@@ -1,4 +1,4 @@\n export function Page() {\n-  const label = \"삭제\";\n-  return <button aria-label=\"삭제\">{label}</button>;\n+  const label = \"Delete\";\n+  return <button aria-label=\"Delete\">{label}</button>;\n }\n",
      },
    }],
    path: "src/Page.tsx",
    parse_verified: true,
    parser: "jsx",
    next: ["rerun with write=true to apply"],
  });
});

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "tedit-golden-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "Page.tsx"), [
    "export function Page() {",
    "  const label = \"삭제\";",
    "  return <button aria-label=\"삭제\">{label}</button>;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(root, "config.json"), "{\"enabled\":true}\n");
  return { root, realRoot: realpathSync(root) };
}

function runJson(args, workspace) {
  return normalize(JSON.parse(execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace.root,
    encoding: "utf8",
    env: detailedEnv(),
  })), workspace);
}

function runCompactJson(args, workspace) {
  return normalize(JSON.parse(execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace.root,
    encoding: "utf8",
    env: compactEnv(),
  })), workspace);
}

function normalize(value, workspace) {
  if (typeof value === "string") {
    return value.split(workspace.realRoot).join("<tmp>").split(workspace.root).join("<tmp>");
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, workspace));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, workspace)]));
  }
  return value;
}

function detailedEnv() {
  return { ...process.env, FORCE_COLOR: "0", TEDIT_OUTPUT: "detailed" };
}

function compactEnv() {
  const env = { ...process.env, FORCE_COLOR: "0" };
  delete env.TEDIT_OUTPUT;
  return env;
}
