import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;

test("ast edit shortcuts cover call args jsx attrs jsx text and templates", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-ast-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, [
    "const toast = { error(message: string) { return message; } };",
    "const item = { label: \"삭제\" };",
    "const status = `준비`;",
    "alert(\"오류\");",
    "toast.error(\"실패\");",
    "export function Page() {",
    "  return <button placeholder=\"검색\">저장</button>;",
    "}",
    "",
  ].join("\n"));

  const scan = runJson(["scan-strings", file, "--json"]);
  assert.ok(scan.strings.some((item) => item.value === "오류" && item.parent === "alert"));
  assert.ok(scan.strings.some((item) => item.value === "실패" && item.parent === "toast.error"));
  assert.ok(scan.strings.some((item) => item.value === "검색" && item.attr === "placeholder"));
  assert.ok(scan.strings.some((item) => item.value === "저장" && item.suggested.selector.includes("JSXText")));

  runJson(["ast-edit", file, "--object-key", "label", "--replace", "Delete", "--write", "--json"]);
  runJson(["ast-edit", file, "--call", "alert", "--replace", "Error", "--write", "--json"]);
  runJson(["ast-edit", file, "--call", "toast.error", "--replace", "Failed", "--write", "--json"]);
  runJson(["ast-edit", file, "--jsx-attr", "placeholder", "--replace", "Search", "--write", "--json"]);
  runJson(["ast-edit", file, "--jsx-text", "저장", "--replace", "Save", "--write", "--json"]);
  runJson(["ast-edit", file, "TemplateLiteral", "--replace", "Ready", "--write", "--json"]);

  assert.equal(readFileSync(file, "utf8"), [
    "const toast = { error(message: string) { return message; } };",
    "const item = { label: \"Delete\" };",
    "const status = `Ready`;",
    "alert(\"Error\");",
    "toast.error(\"Failed\");",
    "export function Page() {",
    "  return <button placeholder=\"Search\">Save</button>;",
    "}",
    "",
  ].join("\n"));
});

test("ast edit failures return bounded retry guidance", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-ast-fail-"));
  const duplicateFile = join(dir, "duplicate.ts");
  writeFileSync(duplicateFile, "const a = \"dup\";\nconst b = \"dup\";\n");

  const duplicate = runFail(["ast-edit", duplicateFile, "--contains", "dup", "--replace", "one", "--write", "--json"]);
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.body.code, "AST_MATCH_NOT_UNIQUE");
  assert.equal(duplicate.body.details.matches.length, 2);
  assert.ok(duplicate.body.next.length <= 3);
  assert.match(duplicate.body.next[0], /Narrow/);

  const jsxFile = join(dir, "jsx.tsx");
  writeFileSync(jsxFile, "export function Page() { return <button>저장</button>; }\n");
  const none = runFail(["ast-edit", jsxFile, 'StringLiteral[value*="저장"]', "--replace", "Save", "--write", "--json"]);
  assert.equal(none.status, 1);
  assert.equal(none.body.code, "AST_MATCH_NONE");
  assert.equal(none.body.details.candidates[0].kind, "jsx_text");
  assert.match(none.body.next[0], /JSXText/);
});

function runJson(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", TEDIT_OUTPUT: "detailed" },
  });
  if (result.status !== 0) {
    assert.fail(`${args.join(" ")}\nstatus=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function runFail(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", TEDIT_OUTPUT: "detailed" },
  });
  assert.notEqual(result.status, 0, args.join(" "));
  return {
    status: result.status,
    body: JSON.parse(result.stderr || result.stdout),
  };
}
