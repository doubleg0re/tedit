import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modulePath } from "./path-helpers.mjs";

const cli = modulePath("../dist/cli.js", import.meta.url);
const workspace = mkdtempSync(join(tmpdir(), "tedit-dogfood-benchmark-"));
const metrics = {
  compactResponses: 0,
  maxCompactBytes: 0,
  detailDescriptors: 0,
  detailReads: 0,
  detailReadBytes: 0,
  readNextOffered: 0,
  readNextReads: 0,
  retryHints: 0,
  parseGuardrails: 0,
};

setupWorkspace(workspace);

const scenarios = [
  scenarioSearchToMultiedit,
  scenarioAstShortcuts,
  scenarioMarkupMarkdown,
  scenarioPatchAndFileWrite,
  scenarioRecoveryAndGuardrails,
];

const results = scenarios.map((scenario) => {
  scenario();
  return { name: scenario.name.replace(/^scenario/, ""), ok: true };
});

console.log(JSON.stringify({
  ok: true,
  workspace,
  scenarios: results.length,
  passed: results.filter((result) => result.ok).length,
  metrics,
  checks: results.map((result) => result.name),
}, null, 2));

function scenarioSearchToMultiedit() {
  const search = runCompactJson([
    "search-text",
    "삭제",
    "src",
    "--glob",
    "src/*.{tsx,ts}",
    "--multiedit-spec",
    "--replace",
    "Delete",
  ]);
  assert.equal(search.count, 3);
  const multiedit = detailValue(search.multiedit);
  assert.equal(multiedit.edits.length, 2);

  const dryRun = runCompactJson(["multiedit", "--from-stdin", "--dry-run"], {
    input: JSON.stringify(multiedit),
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.changedCount, 2);
  assert.equal(dryRun.writtenCount, 0);

  const write = runCompactJson(["multiedit", "--from-stdin", "--write", "--no-backup"], {
    input: JSON.stringify(multiedit),
  });
  assert.equal(write.writtenCount, 2);
  assert.equal(readFileSync(join(workspace, "src", "Page.tsx"), "utf8").includes("삭제"), false);
  assert.equal(readFileSync(join(workspace, "src", "labels.ts"), "utf8").includes("삭제"), false);
}

function scenarioAstShortcuts() {
  const file = join(workspace, "src", "Ast.tsx");
  const call = runCompactJson(["ast-edit", file, "--call", "toast.error", "--replace", "Failed", "--write", "--no-backup"]);
  assert.equal(call.ok, true);
  assert.equal(call.writtenCount, 1);

  const attr = runCompactJson(["ast-edit", file, "--jsx-attr", "placeholder", "--replace", "Search", "--write", "--no-backup"]);
  assert.equal(attr.ok, true);
  assert.equal(attr.writtenCount, 1);

  const text = runCompactJson(["ast-edit", file, "--jsx-text", "저장", "--replace", "Save", "--write", "--no-backup"]);
  assert.equal(text.ok, true);
  assert.match(readFileSync(file, "utf8"), /toast\.error\("Failed"\)/);
  assert.match(readFileSync(file, "utf8"), /placeholder="Search"/);
  assert.match(readFileSync(file, "utf8"), />Save</);
}

function scenarioMarkupMarkdown() {
  const html = join(workspace, "index.html");
  runCompactJson(["class", "add", html, "section.old", "panel", "--write", "--no-backup"]);
  runCompactJson(["prop", "set", html, "section.panel", "data-state", "ready", "--write", "--no-backup"]);
  runCompactJson(["text", "replace", html, "p", "--match-text", "Hello", "--with-text", "Hi", "--write", "--no-backup"]);
  const htmlVerify = runCompactJson(["verify-file", html]);
  assert.equal(htmlVerify.parse_verified, true);

  const markdown = join(workspace, "notes.md");
  runCompactJson(["rename", markdown, "heading[level=1]", "--to", "Notes", "--write", "--no-backup"]);
  runCompactJson(["text", "set", markdown, "code[lang=ts]", "--value", "const ready = true;", "--write", "--no-backup"]);
  const mdVerify = runCompactJson(["verify-file", markdown]);
  assert.equal(mdVerify.parse_verified, true);
  assert.match(readFileSync(markdown, "utf8"), /# Notes/);
}

function scenarioPatchAndFileWrite() {
  const patched = runCompactJson(["patch", "--stdin", "--write", "--no-backup"], {
    input: `--- config.json
+++ config.json
@@ -1,3 +1,3 @@
 {
-  "enabled": true
+  "enabled": false
 }
`,
  });
  assert.equal(patched.ok, true);
  assert.equal(patched.writtenCount, 1);

  const written = runCompactJson([
    "write",
    "generated.json",
    "--source",
    "{\"created\":true}\n",
    "--write",
    "--no-backup",
  ]);
  assert.equal(written.ok, true);
  assert.equal(written.parser, "json");
}

function scenarioRecoveryAndGuardrails() {
  const missing = runFailCompact(["edit", "src/Page.tsx", "--find", "does-not-exist", "--replace", "Nope"]);
  assert.equal(missing.body.code, "MATCH_NONE");
  assert.ok(missing.body.suggestions.length > 0);
  metrics.retryHints += missing.body.suggestions.length;

  const astMiss = runFailCompact(["ast-edit", "src/Ast.tsx", 'StringLiteral[value*="Save"]', "--replace", "Saved"]);
  assert.equal(astMiss.body.code, "AST_MATCH_NONE");
  assert.ok(astMiss.body.suggestions[0].includes("JSXText"));
  metrics.retryHints += astMiss.body.suggestions.length;

  const broken = join(workspace, "broken.md");
  const original = "# Broken\n\n```ts\nconst ok = true;\n```\n";
  writeFileSync(broken, original);
  const parseFailed = runFailCompact(["edit", broken, "--find", "\n```\n", "--replace", "\n", "--write"]);
  assert.equal(parseFailed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.equal(readFileSync(broken, "utf8"), original);
  metrics.parseGuardrails++;
}

function setupWorkspace(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "Page.tsx"), [
    "export function Page() {",
    "  const title = \"삭제\";",
    "  return <button aria-label=\"삭제\">{title}</button>;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "src", "labels.ts"), "export const fallback = \"삭제\";\n");
  writeFileSync(join(dir, "src", "Ast.tsx"), [
    "const toast = { error(message: string) { return message; } };",
    "toast.error(\"실패\");",
    "export function Ast() { return <input placeholder=\"검색\">저장</input>; }",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "index.html"), `<main><section class="old"><p>Hello</p></section></main>`);
  writeFileSync(join(dir, "notes.md"), "# Draft\n\n```ts\nconst ready = false;\n```\n");
  writeFileSync(join(dir, "config.json"), "{\n  \"enabled\": true\n}\n");
}

function runDetailedJson(args, options = {}) {
  return JSON.parse(run(args, { ...options, detailed: true }));
}

function runCompactJson(args, options = {}) {
  const raw = run(args, options);
  metrics.compactResponses++;
  metrics.maxCompactBytes = Math.max(metrics.maxCompactBytes, Buffer.byteLength(raw, "utf8"));
  const body = JSON.parse(raw);
  metrics.detailDescriptors += countDetailDescriptors(body);
  metrics.readNextOffered += countReadNextOffers(body);
  assert.equal(body.success, undefined);
  return body;
}

function runFailCompact(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    input: options.input,
    env: compactEnv(),
  });
  assert.notEqual(result.status, 0, args.join(" "));
  const raw = result.stderr || result.stdout;
  metrics.compactResponses++;
  metrics.maxCompactBytes = Math.max(metrics.maxCompactBytes, Buffer.byteLength(raw, "utf8"));
  const body = JSON.parse(raw);
  metrics.detailDescriptors += countDetailDescriptors(body);
  metrics.readNextOffered += countReadNextOffers(body);
  return {
    status: result.status,
    body,
  };
}

function detailValue(value) {
  if (!value || value.$detail !== true || typeof value.path !== "string") return value;
  const raw = readFileSync(value.path, "utf8");
  metrics.detailReads++;
  if (typeof value.offset === "number") metrics.readNextReads++;
  metrics.detailReadBytes += Buffer.byteLength(raw, "utf8");
  return JSON.parse(raw).value;
}

function countDetailDescriptors(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countDetailDescriptors(item), 0);
  if (value.$detail === true) return 1;
  return Object.values(value).reduce((total, item) => total + countDetailDescriptors(item), 0);
}

function countReadNextOffers(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countReadNextOffers(item), 0);
  const own = value.readNext && typeof value.readNext === "object" ? 1 : 0;
  return own + Object.values(value).reduce((total, item) => total + countReadNextOffers(item), 0);
}

function run(args, options = {}) {
  return execFileSync(process.execPath, [cli, ...args, ...(options.detailed ? ["--json"] : [])], {
    cwd: workspace,
    encoding: "utf8",
    input: options.input,
    env: options.detailed ? detailedEnv() : compactEnv(),
  });
}

function detailedEnv() {
  return { ...process.env, FORCE_COLOR: "0", TEDIT_OUTPUT: "detailed" };
}

function compactEnv() {
  const env = { ...process.env, FORCE_COLOR: "0" };
  delete env.TEDIT_OUTPUT;
  return env;
}
