import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}
