import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { modulePath } from "../scripts/path-helpers.mjs";

const cli = modulePath("../dist/cli.js", import.meta.url);

test("setup prints MCP config and host CLI command dry-runs", () => {
  const config = JSON.parse(run(["setup", "print"]));
  assert.deepEqual(config, { mcpServers: { tedit: { command: "tedit-mcp" } } });

  assert.equal(run(["setup", "codex", "--dry-run"]), "codex mcp add tedit -- tedit-mcp\n");
  assert.equal(run(["setup", "claude", "--dry-run"]), "claude mcp add tedit -- tedit-mcp\n");
});

test("doctor reports local MCP availability without network when requested", () => {
  const bin = fakeBin();
  const doctor = JSON.parse(run(["doctor", "--skip-update", "--json"], { PATH: `${bin}:${process.env.PATH ?? ""}` }));

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
  const file = join(dir, "tedit-mcp");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return dir;
}

function run(args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", ...env },
  });
}
