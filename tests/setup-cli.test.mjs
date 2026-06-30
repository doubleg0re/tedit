import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { modulePath } from "../scripts/path-helpers.mjs";

const cli = modulePath("../dist/cli.js", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("setup prints MCP config and host CLI command dry-runs", () => {
  const config = JSON.parse(run(["setup", "print"]));
  assert.deepEqual(config, { mcpServers: { tedit: { command: "tedit-mcp" } } });

  assert.throws(
    () => run(["setup", "--dry-run"]),
    /requires --target claude\|codex\|both/,
  );
  assert.equal(run(["setup", "codex", "--dry-run"]), "codex mcp add tedit -- tedit-mcp\n");
  assert.equal(run(["setup", "codex", "--scope", "user", "--dry-run"]), "codex mcp add tedit -- tedit-mcp\n");
  assert.equal(run(["setup", "claude", "--dry-run"]), "claude mcp add --scope user tedit -- tedit-mcp\n");
  assert.equal(run(["setup", "claude", "--scope", "project", "--dry-run"]), "claude mcp add --scope project tedit -- tedit-mcp\n");
  assert.equal(run(["setup", "mcp", "--target", "claude", "--scope", "project", "--dry-run"]), "claude mcp add --scope project tedit -- tedit-mcp\n");
  assert.equal(
    run(["setup", "mcp", "--target", "both", "--scope", "user", "--dry-run"]),
    "claude mcp add --scope user tedit -- tedit-mcp\ncodex mcp add tedit -- tedit-mcp\n",
  );
});

test("setup rejects project scope for Codex until the host CLI supports it", () => {
  assert.throws(
    () => run(["setup", "codex", "--scope", "project", "--dry-run"]),
    /Codex CLI does not currently support project-scoped MCP setup/,
  );
  assert.throws(
    () => run(["setup", "mcp", "--target", "both", "--scope", "project", "--dry-run"]),
    /Codex CLI does not currently support project-scoped MCP setup/,
  );
});

test("setup mcp requires explicit target when not interactive", () => {
  assert.throws(
    () => run(["setup", "mcp", "--dry-run"]),
    /requires --target claude\|codex\|both/,
  );
});

test("setup adds user-scoped agent MCP guidance under the user config dirs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tedit-setup-guide-"));
  const home = mkdtempSync(join(tmpdir(), "tedit-setup-home-"));
  const bin = fakeBin(["codex", "claude"]);
  const env = homeEnv(home, { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` });

  const agentsPath = join(home, ".codex", "AGENTS.md");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(agentsPath, "# Existing user guide\n");

  const codexOut = run(["setup", "codex", "--yes"], env, cwd);
  const codexBackup = codexOut.match(/backup -> (.*AGENTS\.md\.[0-9]+\.[0-9]+(?:\.[0-9]+)?\.bak)/)?.[1];
  assert.ok(codexBackup);
  assert.equal(readFileSync(codexBackup, "utf8"), "# Existing user guide\n");
  assert.equal(existsSync(agentsPath + ".bak"), false);
  const agents = readFileSync(agentsPath, "utf8");
  assert.match(agents, /<!-- tedit:mcp-guide sha256:[a-f0-9]+ version:[^\s]+ -->/);
  assert.match(agents, /tedit\.mutate/);
  assert.equal(existsSync(join(cwd, "AGENTS.md")), false);

  run(["setup", "codex", "--yes"], env, cwd);
  const again = readFileSync(agentsPath, "utf8");
  assert.equal((again.match(/tedit:mcp-guide/g) ?? []).length, 2);

  run(["setup", "claude", "--yes"], env, cwd);
  const claudeGuide = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
  assert.match(claudeGuide, /## tedit MCP/);
  assert.doesNotMatch(claudeGuide, /^@AGENTS\.md\n/);
  assert.equal(existsSync(join(cwd, "CLAUDE.md")), false);
});

test("setup adds project-scoped agent MCP guidance in the current project", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tedit-setup-project-guide-"));
  const home = mkdtempSync(join(tmpdir(), "tedit-setup-home-"));
  const bin = fakeBin(["claude"]);
  const env = homeEnv(home, { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` });

  const claudePath = join(cwd, "CLAUDE.md");
  writeFileSync(claudePath, "# Existing project guide\n");

  const claudeOut = run(["setup", "claude", "--scope", "project", "--yes"], env, cwd);
  const claudeBackup = claudeOut.match(/backup -> (.*CLAUDE\.md\.[0-9]+\.[0-9]+(?:\.[0-9]+)?\.bak)/)?.[1];
  assert.ok(claudeBackup);
  assert.equal(readFileSync(claudeBackup, "utf8"), "# Existing project guide\n");
  assert.equal(existsSync(claudePath + ".bak"), false);
  const claudeGuide = readFileSync(claudePath, "utf8");
  assert.match(claudeGuide, /## tedit MCP/);
  assert.equal(existsSync(join(home, ".claude", "CLAUDE.md")), false);
});

test("setup still offers user-scoped agent guidance when one host setup fails", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tedit-setup-guide-fail-"));
  const home = mkdtempSync(join(tmpdir(), "tedit-setup-home-"));
  const bin = fakeBin(["codex", "claude"]);
  const claude = join(bin, process.platform === "win32" ? "claude.cmd" : "claude");
  writeFileSync(claude, process.platform === "win32" ? "@echo off\r\nexit /b 9\r\n" : "#!/bin/sh\nexit 9\n");
  if (process.platform !== "win32") chmodSync(claude, 0o755);
  const env = homeEnv(home, { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` });

  let failed;
  try {
    run(["setup", "mcp", "--target", "both", "--scope", "user", "--yes"], env, cwd);
  } catch (error) {
    failed = error;
  }

  assert.ok(failed);
  assert.match(failed.stderr, /claude MCP setup failed/);
  assert.match(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8"), /tedit\.mutate/);
  assert.match(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8"), /tedit\.mutate/);
  assert.equal(existsSync(join(cwd, "AGENTS.md")), false);
  assert.equal(existsSync(join(cwd, "CLAUDE.md")), false);
});

test("setup treats an existing tedit MCP with the expected command as success", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tedit-setup-existing-"));
  const home = mkdtempSync(join(tmpdir(), "tedit-setup-home-"));
  const bin = fakeBin();
  writeFakeCommand(bin, "claude", `
if [ "$1 $2" = "mcp add" ]; then
  echo "MCP server tedit already exists in user config"
  exit 1
fi
if [ "$1 $2" = "mcp list" ]; then
  echo "tedit: tedit-mcp - ✔ Connected"
  exit 0
fi
exit 0
`);
  const out = run(["setup", "claude", "--scope", "user", "--yes", "--no-agent-guide"], homeEnv(home, { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }), cwd);

  assert.match(out, /already exists with the expected command: tedit-mcp/);
});

test("setup replaces an existing tedit MCP with a different command when --yes is set", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tedit-setup-replace-"));
  const home = mkdtempSync(join(tmpdir(), "tedit-setup-home-"));
  const bin = fakeBin();
  const log = join(cwd, "claude.log");
  writeFakeCommand(bin, "claude", `
echo "$@" >> "${log}"
if [ "$1 $2" = "mcp add" ]; then
  if [ -f "${join(cwd, "removed")}" ]; then exit 0; fi
  echo "MCP server tedit already exists in user config"
  exit 1
fi
if [ "$1 $2" = "mcp list" ]; then
  echo "tedit: node /old/tedit/dist/mcp.js - ✔ Connected"
  exit 0
fi
if [ "$1 $2" = "mcp remove" ]; then
  touch "${join(cwd, "removed")}"
  exit 0
fi
exit 0
`);

  run(["setup", "claude", "--scope", "user", "--yes", "--no-agent-guide"], homeEnv(home, { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }), cwd);
  const calls = readFileSync(log, "utf8");
  assert.match(calls, /mcp remove --scope user tedit/);
  assert.match(calls, /mcp add --scope user tedit -- tedit-mcp/);
});

test("doctor reports local MCP availability without network when requested", () => {
  const bin = fakeBin();
  const doctor = JSON.parse(run(["doctor", "--skip-update", "--json"], { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }));

  assert.equal(doctor.ok, true);
  assert.equal(doctor.checks.find((check) => check.name === "tedit-mcp").ok, true);
  assert.match(doctor.checks.find((check) => check.name === "tedit-mcp").detail, /PATH:/);
  assert.equal(doctor.checks.find((check) => check.name === "actions").detail, "80 actions");
  assert.equal(doctor.latest, undefined);
});

test("update check reports newer npm version without installing", () => {
  const out = run(["update", "--check"], { TEDIT_TEST_LATEST_VERSION: "9.9.9" });

  assert.match(out, new RegExp(`update available: ${packageJson.version.replace(/\./g, "\\.")} -> 9\\.9\\.9`));
  assert.match(out, /npm install -g tedit-tools@latest/);
});

test("update check queries tedit-tools and ignores older latest versions", () => {
  const bin = mkdtempSync(join(tmpdir(), "tedit-cli-npm-"));
  const calls = join(bin, "npm-calls.txt");
  writeFakeCommand(bin, "npm", `echo "$@" >> "${calls}"
if [ "$1" = "view" ]; then echo "0.0.4"; exit 0; fi
exit 1
`);

  const out = run(["update", "--check"], { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` });

  assert.match(readFileSync(calls, "utf8"), /view tedit-tools version/);
  assert.match(out, new RegExp(`tedit is up to date \\(${packageJson.version.replace(/\./g, "\\.")}\\)`));
});

function writeFakeCommand(dir, name, script) {
  const file = join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(file, process.platform === "win32" ? `@echo off
sh "${file}.sh" %*
` : `#!/bin/sh
${script}
`);
  if (process.platform === "win32") writeFileSync(`${file}.sh`, script);
  if (process.platform !== "win32") chmodSync(file, 0o755);
}

function fakeBin(extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "tedit-cli-bin-"));
  for (const name of ["tedit-mcp", ...extra]) {
    const file = join(dir, process.platform === "win32" ? `${name}.cmd` : name);
    writeFileSync(file, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") chmodSync(file, 0o755);
  }
  return dir;
}

function homeEnv(home, env = {}) {
  return { ...env, HOME: home, USERPROFILE: home };
}

function run(args, env = {}, cwd = undefined) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", ...env },
    cwd,
  });
}
