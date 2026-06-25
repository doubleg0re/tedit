import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { modulePath } from "../scripts/path-helpers.mjs";

const cli = modulePath("../dist/cli.js", import.meta.url);

test("stability: search-text glob variants cover common agent patterns", () => {
  const dir = fixtureWorkspace();

  const spacedBraces = JSON.parse(run(["search-text", "삭제", "src", "--glob", "src/{components, utils}/*.{tsx, ts}", "--json"], { cwd: dir }));
  assert.equal(spacedBraces.count, 3);
  assert.deepEqual(spacedBraces.results.map((result) => basename(result.file)).sort(), ["Button.tsx", "Button.tsx", "labels.ts"]);

  const basenameFallback = JSON.parse(run(["search-text", "삭제", "src", "--glob", "*.{tsx, ts}", "--json"], { cwd: dir }));
  assert.equal(basenameFallback.count, 3);

  const directoryBraces = JSON.parse(run(["search-text", "삭제", "src", "--glob", "src/{components,utils}/*.{js,jsx}", "--json"], { cwd: dir }));
  assert.equal(directoryBraces.count, 0);
});

test("stability: agent workflow keeps compact and detailed output contracts", () => {
  const dir = fixtureWorkspace();

  const detailedSearch = JSON.parse(run([
    "search-text", "삭제", "src", "--glob", "src/{components, utils}/*.{tsx, ts}", "--context", "1", "--multiedit-spec", "--replace", "Delete", "--json",
  ], { cwd: dir }));
  assert.equal(detailedSearch.success, true);
  assert.equal(detailedSearch.ok, undefined);
  assert.equal(detailedSearch.count, 3);
  assert.equal(detailedSearch.matchCount, 3);
  assert.equal(detailedSearch.fileCount, 2);
  assert.equal(detailedSearch.results[0].range.line, 2);
  assert.equal(detailedSearch.results[0].suggestions[0].tool, "inspect_range");
  assert.equal(detailedSearch.results[0].suggestions[0].cliCommand, "inspect-range");
  assert.equal(detailedSearch.multiedit.edits.length, 2);
  assert.equal(detailedSearch.multiedit.editCount, 2);
  assert.equal(detailedSearch.multiedit.fileCount, 2);
  assert.equal(detailedSearch.multiedit.matchCount, 3);

  const compactSearch = JSON.parse(runCompact(["search-text", "삭제", "src", "--glob", "src/{components, utils}/*.{tsx, ts}"], { cwd: dir }));
  assert.equal(compactSearch.ok, true);
  assert.equal(compactSearch.success, undefined);
  assert.equal(compactSearch.kind, "search-text");
  assert.equal(compactSearch.count, 3);
  assert.equal(compactSearch.matchCount, 3);
  assert.equal(compactSearch.fileCount, 2);
  assert.equal(compactSearch.resultsShown, 3);
  assert.equal(compactSearch.resultsTruncated, undefined);
  assert.equal(compactSearch.results[0].suggested, undefined);

  const dryRun = JSON.parse(runCompact(["multiedit", "--from-stdin", "--dry-run"], {
    cwd: dir,
    input: JSON.stringify(detailedSearch.multiedit),
  }));
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.kind, "mutation");
  assert.equal(dryRun.changedCount, 2);
  assert.equal(dryRun.writtenCount, 0);
  assert.ok(dryRun.files.every((file) => file.file === undefined));
  assert.ok(dryRun.files.every((file) => typeof file.path === "string"));

  const write = JSON.parse(run(["multiedit", "--from-stdin", "--write", "--no-backup", "--json"], {
    cwd: dir,
    input: JSON.stringify(detailedSearch.multiedit),
  }));
  assert.equal(write.success, true);
  assert.equal(write.files.filter((file) => file.changed).length, 2);
  assert.equal(write.files.filter((file) => file.written).length, 2);
  assert.equal(readFileSync(join(dir, "src", "components", "Button.tsx"), "utf8").includes("삭제"), false);
  assert.equal(readFileSync(join(dir, "src", "utils", "labels.ts"), "utf8").includes("삭제"), false);

  const tsVerify = JSON.parse(run(["verify-file", "src/utils/labels.ts", "--json"], { cwd: dir }));
  assert.equal(tsVerify.success, true);
  assert.equal(tsVerify.file.endsWith("src/utils/labels.ts"), true);
  assert.equal(tsVerify.parser, "typescript");

  const compactVerify = JSON.parse(runCompact(["verify-file", "src/utils/labels.ts"], { cwd: dir }));
  assert.equal(compactVerify.ok, true);
  assert.equal(compactVerify.success, undefined);
  assert.equal(compactVerify.path.endsWith("src/utils/labels.ts"), true);
  assert.equal(compactVerify.file, undefined);
  assert.equal(compactVerify.parser, "typescript");
});

test("stability: compact search clarifies truncated display and multiedit coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-stability-many-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let index = 0; index < 4; index++) {
    writeFileSync(join(dir, "src", `File${index}.ts`), Array.from({ length: 6 }, (_, line) => {
      return `export const label${index}_${line} = "삭제";`;
    }).join("\n") + "\n");
  }

  const search = JSON.parse(runCompact([
    "search-text", "삭제", "src", "--glob", "src/*.ts", "--multiedit-spec", "--replace", "Delete",
  ], { cwd: dir }));

  assert.equal(search.count, 24);
  assert.equal(search.matchCount, 24);
  assert.equal(search.fileCount, 4);
  assert.equal(search.resultsShown, 20);
  assert.equal(search.resultsTruncated, true);
  assert.match(search.summary, /24 text matches across 4 files; showing 20/);
  assert.equal(search.multiedit.editCount, 4);
  assert.equal(search.multiedit.fileCount, 4);
  assert.equal(search.multiedit.matchCount, 24);
});

test("stability: search-text full result piped to multiedit gives recovery hint", () => {
  const dir = fixtureWorkspace();
  const search = JSON.parse(run([
    "search-text", "삭제", "src", "--glob", "src/{components, utils}/*.{tsx, ts}", "--multiedit-spec", "--replace", "Delete", "--json",
  ], { cwd: dir }));

  const failed = runFail(["multiedit", "--from-stdin", "--dry-run", "--json"], {
    cwd: dir,
    input: JSON.stringify(search),
  });
  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "INVALID_MULTIEDIT");
  assert.equal(failed.body.details.detected, "search-text-result");
  assert.match(failed.body.suggestions[0], /\.multiedit/);
});

function fixtureWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "tedit-stability-"));
  mkdirSync(join(dir, "src", "components"), { recursive: true });
  mkdirSync(join(dir, "src", "utils"), { recursive: true });
  mkdirSync(join(dir, "src", "styles"), { recursive: true });
  writeFileSync(join(dir, "src", "components", "Button.tsx"), [
    "export function Button() {",
    "  const label = \"삭제\";",
    "  return <button aria-label=\"삭제\">{label}</button>;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "src", "utils", "labels.ts"), "export const fallback = \"삭제\";\n");
  writeFileSync(join(dir, "src", "styles", "button.css"), ".delete { content: \"삭제\"; }\n");
  return dir;
}

function run(args, options = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    input: options.input,
    env: detailedEnv(),
  });
}

function runCompact(args, options = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    input: options.input,
    env: compactEnv(),
  });
}

function runFail(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    input: options.input,
    env: detailedEnv(),
  });
  return {
    status: result.status,
    body: JSON.parse(result.stderr || result.stdout),
  };
}

function detailedEnv() {
  return { ...process.env, FORCE_COLOR: "0", TEDIT_OUTPUT: "detailed" };
}

function compactEnv() {
  const env = { ...process.env, FORCE_COLOR: "0" };
  delete env.TEDIT_OUTPUT;
  return env;
}
