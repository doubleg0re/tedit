import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const registeredTeditRoots = new Set<string>();

export function ensureTeditCacheDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const teditRoot = teditRootFor(dir);
  if (!teditRoot || registeredTeditRoots.has(teditRoot)) return;
  registeredTeditRoots.add(teditRoot);
  try {
    registerGitExclude(dirname(teditRoot));
  } catch {
    // Best-effort convenience; cache writes must never fail because git exclusion did.
  }
}

function teditRootFor(dir: string): string | undefined {
  const resolved = resolve(dir);
  if (resolved.endsWith(`${sep}.tedit`)) return resolved;
  const marker = `${sep}.tedit${sep}`;
  const index = resolved.lastIndexOf(marker);
  return index === -1 ? undefined : resolved.slice(0, index + marker.length - 1);
}

function registerGitExclude(base: string): void {
  const inside = spawnSync("git", ["-C", base, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 5_000 });
  if (inside.status !== 0 || String(inside.stdout).trim() !== "true") return;
  const exclude = spawnSync("git", ["-C", base, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8", timeout: 5_000 });
  if (exclude.status !== 0) return;
  const value = String(exclude.stdout).trim();
  if (!value) return;
  const excludePath = resolve(base, value);
  const source = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (source.split(/\r?\n/).some((line) => line.trim() === ".tedit/")) return;
  mkdirSync(dirname(excludePath), { recursive: true });
  writeFileSync(excludePath, source + (source && !source.endsWith("\n") ? "\n" : "") + ".tedit/\n");
}
