import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { modulePath } from "../scripts/path-helpers.mjs";

const cli = modulePath("../dist/cli.js", import.meta.url);

test("setup prints MCP config and host CLI command dry-runs", () => {
  const config = JSON.parse(run(["setup", "print"]));
  assert.deepEqual(config, { mcpServers: { tedit: { command: "tedit-mcp" } } });

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

test("doctor reports local MCP availability without network when requested", () => {
  const bin = fakeBin();
  const doctor = JSON.parse(run(["doctor", "--skip-update", "--json"], { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }));

  assert.equal(doctor.ok, true);
  assert.equal(doctor.checks.find((check) => check.name === "tedit-mcp").ok, true);
  assert.equal(doctor.latest, undefined);
});

test("update check reports newer npm version without installing", () => {
  const out = run(["update", "--check"], { TEDIT_TEST_LATEST_VERSION: "9.9.9" });

  assert.match(out, /update available: 0\.1\.0 -> 9\.9\.9/);
  assert.match(out, /npm install -g tedit@latest/);
});

function fakeBin() {
  const dir = mkdtempSync(join(tmpdir(), "tedit-cli-bin-"));
  const file = join(dir, process.platform === "win32" ? "tedit-mcp.cmd" : "tedit-mcp");
  writeFileSync(file, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(file, 0o755);
  return dir;
}

function run(args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", ...env },
  });
}
