import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const workspace = mkdtempSync(join(tmpdir(), "tedit-dogfood-agent-"));

setupWorkspace(workspace);

const search = runJson([
  "search-text",
  "삭제",
  "src",
  "--glob",
  "src/*.{tsx, ts}",
  "--context",
  "1",
  "--multiedit-spec",
  "--replace",
  "Delete",
  "--json",
]);
assert.equal(search.kind, "search-text");
assert.equal(search.count, 4);
assert.equal(search.multiedit.edits.length, 2);
assert.equal(search.results[0].next[0].cliCommand, "inspect-range");

const wrongMultieditInput = runFail(["multiedit", "--from-stdin", "--dry-run", "--json"], {
  input: JSON.stringify(search),
});
assert.equal(wrongMultieditInput.status, 1);
assert.equal(wrongMultieditInput.body.code, "INVALID_MULTIEDIT");
assert.equal(wrongMultieditInput.body.details.detected, "search-text-result");
assert.match(wrongMultieditInput.body.next[0], /\.multiedit/);

const dryRun = runCompactJson(["multiedit", "--from-stdin", "--dry-run"], {
  input: JSON.stringify(search.multiedit),
});
assert.equal(dryRun.ok, true);
assert.equal(dryRun.kind, "mutation");
assert.equal(dryRun.changedCount, 2);
assert.equal(dryRun.writtenCount, 0);
assert.equal(dryRun.files.length, 2);
assert.ok(dryRun.files.every((file) => file.persisted === false));

const write = runJson(["multiedit", "--from-stdin", "--write", "--no-backup", "--json"], {
  input: JSON.stringify(search.multiedit),
});
assert.equal(write.success, true);
assert.equal(write.files.filter((file) => file.changed).length, 2);
assert.equal(write.files.filter((file) => file.written).length, 2);
assert.equal(readFileSync(join(workspace, "src", "Page.tsx"), "utf8").includes("삭제"), false);
assert.equal(readFileSync(join(workspace, "src", "labels.ts"), "utf8").includes("삭제"), false);

const verified = runJson(["verify-file", "src/Page.tsx", "--json"]);
assert.equal(verified.success, true);
assert.equal(verified.parse_verified, true);

const unifiedPatch = runJson(["patch", "--stdin", "--write", "--no-backup", "--json"], {
  input: `--- notes.md
+++ notes.md
@@ -1,3 +1,3 @@
 # Notes
 
-status: draft
+status: final
`,
});
assert.equal(unifiedPatch.success, true);
assert.equal(readFileSync(join(workspace, "notes.md"), "utf8").includes("status: final"), true);

const applyPatch = runJson(["patch", "--stdin", "--write", "--no-backup", "--json"], {
  input: `*** Begin Patch
*** Add File: src/generated.json
+{
+  "ok": true
+}
*** End Patch
`,
});
assert.equal(applyPatch.success, true);
assert.deepEqual(JSON.parse(readFileSync(join(workspace, "src", "generated.json"), "utf8")), { ok: true });

execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
execFileSync("git", ["commit", "-m", "apply dogfood changes"], { cwd: workspace, stdio: "ignore" });

const history = runJson(["history-trace", "src/Page.tsx", "--contains", "Delete", "--json"]);
assert.equal(history.kind, "history-trace");
assert.equal(history.target.type, "contains");
assert.ok(history.commits.some((commit) => commit.subject === "apply dogfood changes"));

const missing = runFail(["edit", "src/Page.tsx", "--find", "does-not-exist", "--replace", "Nope", "--dry-run", "--json"]);
assert.equal(missing.status, 1);
assert.equal(missing.body.code, "MATCH_NONE");
assert.ok(Array.isArray(missing.body.next));
assert.ok(missing.body.next.length > 0);

console.log(JSON.stringify({
  ok: true,
  workspace,
  checks: [
    "search-text multiedit handoff",
    "invalid multiedit recovery hint",
    "multiedit dry-run compact contract",
    "multiedit write and verify-file",
    "unified patch stdin",
    "apply-patch stdin add file",
    "history-trace after git commit",
    "MATCH_NONE retry hints",
  ],
}, null, 2));

function setupWorkspace(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "Page.tsx"), [
    "export function Page() {",
    "  const title = \"삭제\";",
    "  const secondary = \"삭제\";",
    "  return (",
    "    <main>",
    "      <button aria-label=\"삭제\">{title}</button>",
    "      <p>{secondary}</p>",
    "    </main>",
    "  );",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "src", "labels.ts"), "export const fallback = \"삭제\";\n");
  writeFileSync(join(dir, "src", "style.css"), ".delete { content: \"삭제\"; }\n");
  writeFileSync(join(dir, "notes.md"), "# Notes\n\nstatus: draft\n");
  writeFileSync(join(dir, "config.json"), "{\n  \"enabled\": true\n}\n");

  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tedit@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "tedit"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial fixture"], { cwd: dir, stdio: "ignore" });
}

function runJson(args, options = {}) {
  return JSON.parse(run(args, { ...options, env: detailedEnv() }));
}

function runCompactJson(args, options = {}) {
  return JSON.parse(run(args, { ...options, env: compactEnv() }));
}

function run(args, options = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    input: options.input,
    env: options.env,
  });
}

function runFail(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
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
