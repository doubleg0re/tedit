import { chmodSync, readFileSync, statSync } from "node:fs";

const bins = ["dist/cli.js", "dist/mcp.js"];

for (const bin of bins) {
  const source = readFileSync(bin, "utf8");
  if (!source.startsWith("#!/usr/bin/env node")) {
    throw new Error(bin + " must start with a node shebang.");
  }
  const mode = statSync(bin).mode;
  chmodSync(bin, mode | 0o755);
}
