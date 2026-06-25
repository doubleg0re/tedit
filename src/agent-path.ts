import { basename, relative } from "node:path";

export function agentPath(filePath: string): string {
  return filePath.split("\\").join("/");
}

export function relativeAgentPath(from: string, to: string): string {
  return agentPath(relative(from, to) || basename(to));
}
