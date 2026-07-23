export type TeditMcpProfile = "agent" | "all";

export const MCP_WRITE_BY_DEFAULT = { defaultWrite: true } as const;

const AGENT_MCP_TOOL_NAMES = new Set([
  "actions",
  "select",
  "edit",
  "multiedit",
  "mutate",
  "apply_dry_run",
  "patch",
  "flow",
  "delete_file",
  "rename_file",
  "file_write",
  "search",
  "read_detail",
  "verify_file",
  "refactor",
  "version",
]);

export function teditMcpProfileFromEnv(env: NodeJS.ProcessEnv = process.env): TeditMcpProfile {
  return env.TEDIT_MCP_PROFILE === "all" || env.TEDIT_MCP_EXPOSE_ADVANCED === "true" ? "all" : "agent";
}

export function isDefaultMcpToolName(name: string): boolean {
  return AGENT_MCP_TOOL_NAMES.has(name);
}
