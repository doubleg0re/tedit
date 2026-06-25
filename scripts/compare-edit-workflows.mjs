import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const runs = positiveInteger(process.env.TEDIT_COMPARE_RUNS, 3);
const keepWorkspaces = process.env.TEDIT_COMPARE_KEEP_WORKSPACES === "true";

const scenarios = [
  {
    name: "known-single-edit",
    size: "small",
    setup: setupKnownSingleEdit,
    runTedit: runTeditKnownSingleEdit,
    runPlain: runPlainKnownSingleEdit,
  },
  {
    name: "bulk-text-replace-medium",
    size: "medium",
    setup: (workspace) => setupBulkTextReplace(workspace, { files: 4, matchesPerFile: 3 }),
    runTedit: (workspace, recorder) => runTeditBulkTextReplace(workspace, recorder, { files: 4 }),
    runPlain: (workspace, recorder) => runPlainBulkTextReplace(workspace, recorder),
  },
  {
    name: "bulk-text-replace-large",
    size: "large",
    setup: (workspace) => setupBulkTextReplace(workspace, { files: 24, matchesPerFile: 3 }),
    runTedit: (workspace, recorder) => runTeditBulkTextReplace(workspace, recorder, { files: 24 }),
    runPlain: (workspace, recorder) => runPlainBulkTextReplace(workspace, recorder),
  },
  {
    name: "invalid-markdown-guardrail",
    size: "safety",
    setup: setupInvalidMarkdownGuardrail,
    runTedit: runTeditInvalidMarkdownGuardrail,
    runPlain: runPlainInvalidMarkdownGuardrail,
  },
];

const results = scenarios.map(runScenario);
const summary = {
  ok: true,
  runs,
  tokenEstimateMethod: "ceil((recorded input bytes + recorded output bytes + read_detail bytes) / 4); proxy only, not model usage",
  timingMethod: "local wall-clock time around each command/tool-like operation; not model latency",
  scenarios: results,
};

console.log(JSON.stringify(summary, null, 2));

function runScenario(scenario) {
  const teditRuns = [];
  const plainRuns = [];

  for (let index = 0; index < runs; index++) {
    teditRuns.push(runLane(scenario, "tedit", index));
    plainRuns.push(runLane(scenario, "plain", index));
  }

  const tedit = summarizeLane(teditRuns);
  const plain = summarizeLane(plainRuns);
  return {
    name: scenario.name,
    size: scenario.size,
    tedit,
    plain,
    delta: {
      timeMs: round(tedit.medianMs - plain.medianMs),
      estimatedTokens: tedit.medianEstimatedTokens - plain.medianEstimatedTokens,
      operations: tedit.medianOperations - plain.medianOperations,
      timeRatio: ratio(tedit.medianMs, plain.medianMs),
      tokenRatio: ratio(tedit.medianEstimatedTokens, plain.medianEstimatedTokens),
    },
    note: scenario.size === "safety"
      ? "plain lane includes a manual verify-and-revert step to match tedit's guarded final state"
      : undefined,
  };
}

function runLane(scenario, lane, index) {
  const workspace = mkdtempSync(join(tmpdir(), `tedit-compare-${scenario.name}-${lane}-${index}-`));
  const recorder = createRecorder(workspace, lane);
  try {
    scenario.setup(workspace);
    if (lane === "tedit") scenario.runTedit(workspace, recorder);
    else scenario.runPlain(workspace, recorder);
    return recorder.finish(workspace);
  } finally {
    if (!keepWorkspaces) rmSync(workspace, { recursive: true, force: true });
  }
}

function runTeditKnownSingleEdit(workspace, recorder) {
  const result = recorder.tedit([
    "edit",
    "src/config.ts",
    "--find",
    "timeout: 3000",
    "--replace",
    "timeout: 5000",
    "--write",
    "--no-backup",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.changedCount, 1);
  assert.match(readFileSync(join(workspace, "src/config.ts"), "utf8"), /timeout: 5000/);
}

function runPlainKnownSingleEdit(workspace, recorder) {
  const file = join(workspace, "src/config.ts");
  recorder.plain("exact-replace-write", {
    file: "src/config.ts",
    find: "timeout: 3000",
    replace: "timeout: 5000",
  }, () => {
    const source = readFileSync(file, "utf8");
    assert.equal(source.includes("timeout: 3000"), true);
    writeFileSync(file, source.replace("timeout: 3000", "timeout: 5000"));
    return { changed: true, written: true, files: 1 };
  });
  assert.match(readFileSync(file, "utf8"), /timeout: 5000/);
}

function detailValue(value, recorder) {
  if (!value || value.$detail !== true || typeof value.path !== "string") return value;
  return recorder?.detail(value) ?? JSON.parse(readFileSync(value.path, "utf8")).value;
}

function runTeditBulkTextReplace(workspace, recorder, expected) {
  const search = recorder.tedit([
    "search-text",
    "삭제",
    "src",
    "--glob",
    "src/*.{tsx,ts}",
    "--multiedit-spec",
    "--replace",
    "Delete",
  ]);
  assert.equal(search.ok, true);
  const multiedit = detailValue(search.multiedit, recorder);
  assert.equal(multiedit.edits.length, expected.files);

  const write = recorder.tedit([
    "multiedit",
    "--from-stdin",
    "--write",
    "--no-backup",
  ], { input: JSON.stringify(multiedit) });
  assert.equal(write.ok, true);
  assert.equal(write.writtenCount, expected.files);
  assertBulkTextReplaced(workspace);
}

function runPlainBulkTextReplace(workspace, recorder) {
  const src = join(workspace, "src");
  const files = readdirSync(src)
    .filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"))
    .sort()
    .map((file) => join(src, file));
  const matches = recorder.plain("search-text", {
    query: "삭제",
    paths: ["src"],
    glob: "src/*.{tsx,ts}",
  }, () => {
    const matched = [];
    const results = [];
    const edits = [];
    let count = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      const fileMatches = [];
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const columns = literalColumns(lines[lineIndex], "삭제");
        for (const column of columns) {
          fileMatches.push({
            file: relativeSrcPath(file),
            line: lineIndex + 1,
            column,
            text: lines[lineIndex],
          });
        }
      }
      if (fileMatches.length > 0) matched.push(file);
      if (fileMatches.length > 0) {
        edits.push({ file: relativeSrcPath(file), find: "삭제", replace: "Delete", replaceAll: true });
      }
      results.push(...fileMatches);
      count += fileMatches.length;
    }
    return { count, files: matched.length, results, multiedit: { edits } };
  });
  assert.equal(matches.files, files.length);

  recorder.plain("replace-all-write", {
    find: "삭제",
    replace: "Delete",
    files: files.length,
  }, () => {
    let replacements = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const next = source.replaceAll("삭제", "Delete");
      replacements += countLiteral(source, "삭제");
      writeFileSync(file, next);
    }
    return { changed: true, written: true, files: files.length, replacements };
  });
  assertBulkTextReplaced(workspace);
}

function runTeditInvalidMarkdownGuardrail(workspace, recorder) {
  const result = recorder.tedit([
    "edit",
    "notes.md",
    "--find",
    "\n```\n",
    "--replace",
    "\n",
    "--write",
    "--no-backup",
  ], { expectStatus: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.equal(readFileSync(join(workspace, "notes.md"), "utf8"), markdownGuardrailSource());
}

function runPlainInvalidMarkdownGuardrail(workspace, recorder) {
  const file = join(workspace, "notes.md");
  const original = readFileSync(file, "utf8");
  recorder.plain("replace-write", {
    file: "notes.md",
    find: "\\n```\\n",
    replace: "\\n",
  }, () => {
    const source = readFileSync(file, "utf8");
    assert.equal(source.includes("\n```\n"), true);
    writeFileSync(file, source.replace("\n```\n", "\n"));
    return { changed: true, written: true, files: 1 };
  });
  recorder.plain("markdown-fence-verify-revert", {
    file: "notes.md",
    guardrail: "balanced fenced code blocks",
  }, () => {
    const next = readFileSync(file, "utf8");
    const ok = hasBalancedFences(next);
    if (!ok) writeFileSync(file, original);
    return { ok, reverted: !ok, files: 1 };
  });
  assert.equal(readFileSync(file, "utf8"), original);
}

function setupKnownSingleEdit(workspace) {
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src/config.ts"), [
    "export const config = {",
    "  timeout: 3000,",
    "  retries: 2,",
    "};",
    "",
  ].join("\n"));
}

function setupBulkTextReplace(workspace, options) {
  mkdirSync(join(workspace, "src"), { recursive: true });
  for (let index = 0; index < options.files; index++) {
    const lines = [
      `export function Row${index}() {`,
      "  const label = \"삭제\";",
      "  const title = \"삭제\";",
      "  return <button aria-label=\"삭제\">{label + title}</button>;",
      "}",
      "",
    ];
    assert.equal(countLiteral(lines.join("\n"), "삭제"), options.matchesPerFile);
    writeFileSync(join(workspace, "src", `Row${index}.tsx`), lines.join("\n"));
  }
}

function setupInvalidMarkdownGuardrail(workspace) {
  writeFileSync(join(workspace, "notes.md"), markdownGuardrailSource());
}

function markdownGuardrailSource() {
  return "# Notes\n\n```ts\nconst ok = true;\n```\n";
}

function assertBulkTextReplaced(workspace) {
  const src = join(workspace, "src");
  for (const file of readdirSync(src)) {
    const source = readFileSync(join(src, file), "utf8");
    assert.equal(source.includes("삭제"), false, file);
    assert.equal(source.includes("Delete"), true, file);
  }
}

function createRecorder(workspace, lane) {
  const steps = [];
  const detailReads = [];
  return {
    tedit(args, options = {}) {
      const payload = { command: "tedit", args, stdin: options.input ?? "" };
      const inputBytes = byteLength(JSON.stringify(payload));
      const started = performance.now();
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: workspace,
        encoding: "utf8",
        input: options.input,
        env: compactEnv(),
      });
      const elapsedMs = performance.now() - started;
      const raw = result.stdout || result.stderr;
      const outputBytes = byteLength(raw);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      steps.push({
        lane,
        name: args[0],
        status: result.status,
        inputBytes,
        outputBytes,
        elapsedMs,
        detailDescriptors: countDetailDescriptors(parsed),
        readNextOffered: countReadNextOffers(parsed),
      });
      const expectedStatus = options.expectStatus ?? 0;
      assert.equal(result.status, expectedStatus, `${args.join(" ")}\n${raw}`);
      return parsed ?? JSON.parse(raw);
    },
    detail(descriptor) {
      if (!descriptor || descriptor.$detail !== true || typeof descriptor.path !== "string") return descriptor;
      const payload = { command: "read_detail", id: descriptor.id ?? "", path: descriptor.path };
      const inputBytes = byteLength(JSON.stringify(payload));
      const started = performance.now();
      const raw = readFileSync(descriptor.path, "utf8");
      const elapsedMs = performance.now() - started;
      const outputBytes = byteLength(raw);
      detailReads.push({
        lane,
        name: "read_detail",
        status: 0,
        inputBytes,
        outputBytes,
        elapsedMs,
        readNextRead: typeof descriptor.offset === "number",
      });
      return JSON.parse(raw).value;
    },
    plain(name, payload, fn) {
      const inputBytes = byteLength(JSON.stringify({ operation: name, ...payload }));
      const started = performance.now();
      const result = fn();
      const elapsedMs = performance.now() - started;
      const outputBytes = byteLength(JSON.stringify(result ?? {}));
      steps.push({
        lane,
        name,
        status: result?.ok === false ? 1 : 0,
        inputBytes,
        outputBytes,
        elapsedMs,
      });
      return result;
    },
    finish(workspacePath) {
      const inputBytes = sum(steps.map((step) => step.inputBytes));
      const outputBytes = sum(steps.map((step) => step.outputBytes));
      const detailInputBytes = sum(detailReads.map((step) => step.inputBytes));
      const detailOutputBytes = sum(detailReads.map((step) => step.outputBytes));
      const elapsedMs = sum(steps.map((step) => step.elapsedMs)) + sum(detailReads.map((step) => step.elapsedMs));
      return {
        workspace: keepWorkspaces ? workspacePath : undefined,
        operations: steps.length + detailReads.length,
        inputBytes,
        outputBytes,
        detailReadInputBytes: detailInputBytes,
        detailReadOutputBytes: detailOutputBytes,
        detailReadBytes: detailInputBytes + detailOutputBytes,
        elapsedMs,
        estimatedTokens: estimateTokens(inputBytes + outputBytes + detailInputBytes + detailOutputBytes),
        detailDescriptors: sum(steps.map((step) => step.detailDescriptors ?? 0)),
        detailReads: detailReads.length,
        readNextOffered: sum(steps.map((step) => step.readNextOffered ?? 0)),
        readNextReads: detailReads.filter((step) => step.readNextRead).length,
        failedSteps: steps.filter((step) => step.status !== 0).length,
        stepNames: [...steps.map((step) => step.name), ...detailReads.map((step) => step.name)],
      };
    },
  };
}

function summarizeLane(items) {
  return {
    runs: items.length,
    medianOperations: median(items.map((item) => item.operations)),
    medianMs: round(median(items.map((item) => item.elapsedMs))),
    medianInputBytes: Math.round(median(items.map((item) => item.inputBytes))),
    medianOutputBytes: Math.round(median(items.map((item) => item.outputBytes))),
    medianDetailReadBytes: Math.round(median(items.map((item) => item.detailReadBytes))),
    medianEstimatedTokens: Math.round(median(items.map((item) => item.estimatedTokens))),
    medianDetailDescriptors: Math.round(median(items.map((item) => item.detailDescriptors))),
    medianDetailReads: Math.round(median(items.map((item) => item.detailReads))),
    medianReadNextOffered: Math.round(median(items.map((item) => item.readNextOffered))),
    medianReadNextReads: Math.round(median(items.map((item) => item.readNextReads))),
    failedSteps: Math.round(median(items.map((item) => item.failedSteps))),
    stepNames: items[0]?.stepNames ?? [],
  };
}

function countDetailDescriptors(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return sum(value.map(countDetailDescriptors));
  if (value.$detail === true) return 1;
  return sum(Object.values(value).map(countDetailDescriptors));
}

function countReadNextOffers(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return sum(value.map(countReadNextOffers));
  const own = value.readNext && typeof value.readNext === "object" ? 1 : 0;
  return own + sum(Object.values(value).map(countReadNextOffers));
}

function compactEnv() {
  const env = { ...process.env, FORCE_COLOR: "0" };
  delete env.TEDIT_OUTPUT;
  return env;
}

function hasBalancedFences(source) {
  return (source.match(/^```/gm) ?? []).length % 2 === 0;
}

function countLiteral(source, needle) {
  if (needle === "") return 0;
  return source.split(needle).length - 1;
}

function literalColumns(source, needle) {
  const columns = [];
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index === -1) return columns;
    columns.push(index + 1);
    offset = index + needle.length;
  }
}

function relativeSrcPath(file) {
  return "src/" + file.split("/src/").at(-1);
}

function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function ratio(left, right) {
  if (right === 0) return null;
  return round(left / right);
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("TEDIT_COMPARE_RUNS must be a positive integer.");
  return parsed;
}
