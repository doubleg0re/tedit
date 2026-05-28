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
  "dist/mcp-tools.js",
  "dist/output.js",
  "README.md",
  "package.json",
];

const failures = [];
const missing = requiredFiles.filter((file) => !files.includes(file));
const backups = files.filter((file) => file.endsWith(".bak") || file.endsWith(".tedit.bak") || file.startsWith(".tedit-cache/"));
const lifecycleScripts = ["preinstall", "install", "postinstall"].filter((name) => pkg.scripts?.[name]);

if (missing.length > 0) failures.push({ check: "required-files", missing });
if (backups.length > 0) failures.push({ check: "backup-artifacts", backups });
if (lifecycleScripts.length > 0) failures.push({ check: "forbidden-lifecycle-scripts", scripts: lifecycleScripts });
if (pack.size > MAX_PACKAGE_BYTES) failures.push({ check: "package-size", size: pack.size, max: MAX_PACKAGE_BYTES });

for (const [name, binPath] of Object.entries(pkg.bin ?? {})) {
  const path = String(binPath).replace(/^\.\//, "");
  const packed = pack.files.find((file) => file.path === path);
  if (!packed) {
    failures.push({ check: "bin-packed", bin: name, path });
    continue;
  }
  const source = readFileSync(path, "utf8");
  if (!source.startsWith("#!/usr/bin/env node")) failures.push({ check: "bin-shebang", bin: name, path });
  const mode = statSync(path).mode;
  if ((mode & 0o111) === 0) failures.push({ check: "bin-executable", bin: name, path, mode: mode & 0o777 });
  if ((packed.mode & 0o111) === 0) failures.push({ check: "packed-bin-executable", bin: name, path, mode: packed.mode });
}

if (failures.length === 0) {
  await smokePackedArtifact();
}

if (failures.length > 0) {
  process.stderr.write(JSON.stringify({ success: false, failures }, null, 2) + "\n");
  process.exit(1);
}

process.stdout.write(output);

async function smokePackedArtifact() {
  const root = mkdtempSync(join(tmpdir(), "tedit-pack-check-"));
  try {
    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const [packed] = JSON.parse(packOutput);
    const tarball = join(root, packed.filename);
    const version = execFileSync("npx", ["-y", "--package", tarball, "tedit", "--version"], {
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    }).trim();
    if (version !== "tedit " + pkg.version) {
      failures.push({ check: "npx-cli-startup", expected: "tedit " + pkg.version, actual: version });
      return;
    }

    const installRoot = join(root, "install");
    mkdirSync(installRoot);
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
      cwd: installRoot,
      stdio: "ignore",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const mcpBin = join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "tedit-mcp.cmd" : "tedit-mcp");
    if (!existsSync(mcpBin)) {
      failures.push({ check: "packed-mcp-bin", path: mcpBin });
      return;
    }
    await smokeMcp(mcpBin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function smokeMcp(command) {
  const transport = new StdioClientTransport({ command, args: [], stderr: "pipe" });
  const client = new Client({ name: "tedit-pack-check", version: pkg.version });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name);
    for (const required of ["edit", "multiedit", "patch", "create_file", "verify_file"]) {
      if (!toolNames.includes(required)) failures.push({ check: "packed-mcp-tools", missing: required });
    }
  } finally {
    await client.close();
  }
}
