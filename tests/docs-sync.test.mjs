import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { toolsForMcpProfile } from "../dist/mcp-tools.js";

test("docs: README MCP profile lists match registered profiles", () => {
  const readme = readFileSync("README.md", "utf8").replace(/\r\n/g, "\n");
  const agentTools = toolsForMcpProfile("agent").map((tool) => tool.name).sort();
  const allTools = toolsForMcpProfile("all").map((tool) => tool.name).sort();
  const advancedTools = allTools.filter((name) => !agentTools.includes(name)).sort();

  const defaultBlock = readmeSection(readme, "and intent-oriented:\n\n", "\n\n`select`");
  const documentedDefault = backtickValues(defaultBlock).sort();
  assert.deepEqual(documentedDefault, agentTools);

  const advancedBlock = readmeSection(readme, "Set `TEDIT_MCP_PROFILE=all`", "\n\nIn the `all` profile");
  const documentedAdvanced = new Set(backtickValues(advancedBlock));
  for (const tool of advancedTools) {
    assert.equal(documentedAdvanced.has(tool), true, `${tool} missing from README advanced MCP list`);
  }
});

function readmeSection(readme, startMarker, endMarker) {
  const start = readme.indexOf(startMarker);
  assert.notEqual(start, -1, `missing README marker: ${startMarker}`);
  const bodyStart = start + startMarker.length;
  const end = readme.indexOf(endMarker, bodyStart);
  assert.notEqual(end, -1, `missing README marker: ${endMarker}`);
  return readme.slice(bodyStart, end);
}

function backtickValues(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}
