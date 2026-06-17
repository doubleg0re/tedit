import { extname } from "node:path";

import { getOptionalAdapterForFile } from "./core/registry.js";

/**
 * Trust core: formats that earn the AST-precision route.
 *
 * Markdown and markup have structural adapters too, but the single edit
 * entrypoint routes them through the safe-string + verify path on purpose:
 * their structural value is thin, and a weak AST rule there would reintroduce
 * the exact routing doubt this dispatch is meant to remove. The breadth lives
 * in the dispatcher, not in N trust contracts.
 *
 * See ISSUE-single-edit-entrypoint-dispatch.md.
 */
const STRUCTURED_TRUST_CORE = new Set([".tsx", ".jsx", ".ts", ".js", ".json", ".yaml", ".yml"]);

export type EditRoute = "ast" | "string";

export interface EditRouteDecision {
  route: EditRoute;
  extension: string;
  /** Whether any tedit rule adapter claims this file — wider than the trust core. */
  hasStructuralAdapter: boolean;
}

/**
 * Decide how the single edit entrypoint handles a file, so the agent never has
 * to choose tedit-vs-Edit. Trust-core formats prefer the structural path;
 * everything else is served by the safe-string + verify-if-known path, which is
 * never worse than a plain string edit.
 */
export function resolveEditRoute(filePath: string): EditRouteDecision {
  const extension = extname(filePath).toLowerCase();
  return {
    route: STRUCTURED_TRUST_CORE.has(extension) ? "ast" : "string",
    extension,
    hasStructuralAdapter: getOptionalAdapterForFile(filePath) !== null,
  };
}
