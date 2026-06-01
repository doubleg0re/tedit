import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MAX_PACKAGE_BYTES = 2_000_000;

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  env: { ...process.env, FORCE_COLOR: "0" },
});
const [pack] = JSON.parse(output);
const files = pack.files.map((file) => file.path);
const requiredFiles = [
  "dist/cli.js",
  "dist/mcp.js",
  "dist/mcp-runner.js",
  "dist/mcp-tools.js",
  "dist/output.js",
  "dist/version.js",
  "README.md",
  "package.json",
];

const failures = [];
const checks = [];
const missing = requiredFiles.filter((file) => !files.includes(file));
const backups = files.filter((file) => file.endsWith(".bak") || file.endsWith(".tedit.bak") || file.startsWith(".tedit-cache/"));
const lifecycleScripts = ["preinstall", "install", "postinstall"].filter((name) => pkg.scripts?.[name]);
const metadataFailures = packageMetadataFailures(pkg);

recordCheck("package-metadata", metadataFailures.length === 0, { failures: metadataFailures });
recordCheck("required-files", missing.length === 0, { missing, count: requiredFiles.length });
recordCheck("backup-artifacts", backups.length === 0, { backups });
recordCheck("forbidden-lifecycle-scripts", lifecycleScripts.length === 0, { scripts: lifecycleScripts });
recordCheck("package-size", pack.size <= MAX_PACKAGE_BYTES, { size: pack.size, max: MAX_PACKAGE_BYTES });

for (const [name, binPath] of Object.entries(pkg.bin ?? {})) {
  const path = String(binPath).replace(/^\.\//, "");
  const packed = pack.files.find((file) => file.path === path);
  if (!packed) {
    recordCheck("bin-packed", false, { bin: name, path });
    continue;
  }
  const source = readFileSync(path, "utf8");
  recordCheck("bin-packed", true, { bin: name, path });
  recordCheck("bin-shebang", source.startsWith("#!/usr/bin/env node"), { bin: name, path });
  const mode = statSync(path).mode;
  recordCheck("bin-executable", (mode & 0o111) !== 0, { bin: name, path, mode: mode & 0o777 });
  recordCheck("packed-bin-executable", (packed.mode & 0o111) !== 0, { bin: name, path, mode: packed.mode });
}

let smoke = {};
if (failures.length === 0) {
  smoke = await smokePackedArtifact();
}

if (failures.length > 0) {
  process.stderr.write(JSON.stringify(releaseSmokeResult(false, smoke), null, 2) + "\n");
  process.exit(1);
}

process.stdout.write(JSON.stringify(releaseSmokeResult(true, smoke), null, 2) + "\n");

async function smokePackedArtifact() {
  const smoke = {};
  const root = mkdtempSync(join(tmpdir(), "tedit-pack-check-"));
  try {
    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const [packed] = JSON.parse(packOutput);
    const tarball = join(root, packed.filename);
    smoke.tarball = packed.filename;

    const version = runCheckedCommand("npx-cli-startup", "npx", ["-y", "--package", tarball, "tedit", "--version"])?.trim();
    smoke.npxCliVersion = version;
    recordCheck("npx-cli-version", version === "tedit " + pkg.version, { expected: "tedit " + pkg.version, actual: version });

    const installRoot = join(root, "install");
    mkdirSync(installRoot);
    const install = runCheckedCommand("packed-install", "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
      cwd: installRoot,
      stdio: "pipe",
    });
    if (install === undefined) return smoke;

    const cliBin = join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "tedit.cmd" : "tedit");
    const mcpBin = join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "tedit-mcp.cmd" : "tedit-mcp");
    recordCheck("packed-cli-bin", existsSync(cliBin), { path: cliBin });
    recordCheck("packed-mcp-bin", existsSync(mcpBin), { path: mcpBin });
    if (!existsSync(cliBin) || !existsSync(mcpBin)) return smoke;

    const actionsOutput = runCheckedCommand("packed-cli-actions", cliBin, ["actions", "--json"], { cwd: installRoot });
    if (actionsOutput !== undefined) {
      try {
        const actions = JSON.parse(actionsOutput);
        smoke.cliActions = Array.isArray(actions.actions) ? actions.actions.length : 0;
        recordCheck("packed-cli-actions", actions.success === true && Array.isArray(actions.actions) && actions.actions.includes("edit.find"), {
          actionCount: smoke.cliActions,
        });
      } catch (error) {
        recordCheck("packed-cli-actions", false, { error: commandError(error) });
      }
    }

    smoke.mcp = await smokeMcp(mcpBin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return smoke;
}

async function smokeMcp(command) {
  const transport = new StdioClientTransport({ command, args: [], stderr: "pipe" });
  const client = new Client({ name: "tedit-pack-check", version: pkg.version });
  const requiredTools = ["actions", "edit", "multiedit", "patch", "file_write", "inspect_range", "search_text", "verify_file"];
  const smoke = { requiredTools };
  try {
    await client.connect(transport);
    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name);
    smoke.toolCount = toolNames.length;
    for (const required of requiredTools) {
      recordCheck("packed-mcp-tools", toolNames.includes(required), { tool: required });
    }
  } catch (error) {
    recordCheck("packed-mcp-startup", false, { error: commandError(error) });
  } finally {
    try {
      await client.close();
    } catch (error) {
      recordCheck("packed-mcp-close", false, { error: commandError(error) });
    }
  }
  return smoke;
}

function recordCheck(name, ok, details = {}) {
  const cleanDetails = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
  checks.push({ name, ok, ...cleanDetails });
  if (!ok) failures.push({ check: name, ...cleanDetails });
}

function runCheckedCommand(check, command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
      ...options,
    });
  } catch (error) {
    recordCheck(check, false, { command: [command, ...args].join(" "), error: commandError(error) });
    return undefined;
  }
}

function releaseSmokeResult(ok, smoke) {
  return {
    ok,
    success: ok,
    summary: ok ? "release smoke passed" : "release smoke failed",
    package: {
      name: pkg.name,
      version: pkg.version,
      filename: pack.filename,
      size: pack.size,
      unpackedSize: pack.unpackedSize,
      entryCount: pack.entryCount,
    },
    checks: ok ? { passed: checks.length, failed: 0 } : checks,
    smoke: ok ? compactSmoke(smoke) : smoke,
    failures,
    postPublishCheck: `npx -y ${pkg.name}@${pkg.version} --version`,
  };
}

function compactSmoke(smoke) {
  return {
    tarball: smoke.tarball,
    npxCliVersion: smoke.npxCliVersion,
    cliActions: smoke.cliActions,
    mcpToolCount: smoke.mcp?.toolCount,
    requiredMcpTools: smoke.mcp?.requiredTools?.length,
  };
}

function packageMetadataFailures(packageJson) {
  const metadataFailures = [];
  if (packageJson.name !== "tedit") metadataFailures.push({ field: "name", expected: "tedit", actual: packageJson.name });
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/.test(String(packageJson.version))) metadataFailures.push({ field: "version", actual: packageJson.version });
  if (packageJson.type !== "module") metadataFailures.push({ field: "type", expected: "module", actual: packageJson.type });
  if (typeof packageJson.description !== "string" || packageJson.description.trim() === "") metadataFailures.push({ field: "description" });
  if (!packageJson.bin?.tedit || !packageJson.bin?.["tedit-mcp"]) metadataFailures.push({ field: "bin", expected: ["tedit", "tedit-mcp"], actual: packageJson.bin });
  if (!Array.isArray(packageJson.files) || !packageJson.files.includes("dist") || !packageJson.files.includes("README.md")) {
    metadataFailures.push({ field: "files", expected: ["dist", "README.md"], actual: packageJson.files });
  }
  if (typeof packageJson.engines?.node !== "string" || !packageJson.engines.node.includes(">=20")) {
    metadataFailures.push({ field: "engines.node", expected: ">=20", actual: packageJson.engines?.node });
  }
  return metadataFailures;
}

function commandError(error) {
  if (!error || typeof error !== "object") return { message: String(error) };
  return {
    message: error.message,
    status: error.status,
    signal: error.signal,
    stdout: bufferText(error.stdout),
    stderr: bufferText(error.stderr),
  };
}

function bufferText(value) {
  if (value === undefined || value === null) return undefined;
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}
