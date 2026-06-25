import { fileURLToPath } from "node:url";

export function modulePath(relativePath, baseUrl) {
  return fileURLToPath(new URL(relativePath, baseUrl));
}
