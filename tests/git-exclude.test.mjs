import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modulePath } from "../scripts/path-helpers.mjs";

const cli = modulePath("../dist/cli.js", import.meta.url);

test("cache writes register .tedit/ in git info/exclude once", () => {
  const dir = createGitWorkspace();

  runCli(["edit", "notes.txt", "--find", "alpha", "--replace", "beta", "--write", "--backup"], dir);

  const excludePath = join(dir, ".git", "info", "exclude");
  assert.ok(existsSync(join(dir, ".tedit")));
  const excluded = () => readFileSync(excludePath, "utf8").split(/\r?\n/).filter((line) => line.trim() === ".tedit/");
  assert.equal(excluded().length, 1);
  assert.equal(spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).stdout.includes(".tedit"), false);

  runCli(["edit", "notes.txt", "--find", "beta", "--replace", "gamma", "--write", "--backup"], dir);
  assert.equal(excluded().length, 1);
});

test("cache writes outside a git repository stay silent", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tedit-exclude-")));
  writeFileSync(join(dir, "notes.txt"), "alpha\n");

  runCli(["edit", "notes.txt", "--find", "alpha", "--replace", "beta", "--write", "--backup"], dir);

  assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "beta\n");
  assert.ok(existsSync(join(dir, ".tedit")));
});

function createGitWorkspace() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tedit-exclude-")));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "notes.txt"), "alpha\n");
  return dir;
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
