import { execFileSync } from "node:child_process";

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
  "README.md",
  "package.json",
];
const missing = requiredFiles.filter((file) => !files.includes(file));
const backups = files.filter((file) => file.endsWith(".bak") || file.endsWith(".tedit.bak"));

if (missing.length > 0 || backups.length > 0) {
  process.stderr.write(`${JSON.stringify({ success: false, missing, backups }, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(output);
