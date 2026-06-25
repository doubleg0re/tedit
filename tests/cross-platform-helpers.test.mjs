import assert from "node:assert/strict";
import test from "node:test";
import { agentPath, relativeAgentPath } from "../dist/agent-path.js";
import { lineStartOffsets, sourceRangeForLocOrOffsets } from "../dist/source-range.js";

test("agent paths use stable slash separators", () => {
  assert.equal(agentPath("src\\rules\\jsx\\document.ts"), "src/rules/jsx/document.ts");
  assert.equal(relativeAgentPath("/repo", "/repo/src/file.ts"), "src/file.ts");
});

test("source ranges prefer loc line/column and fall back to parser offsets", () => {
  const source = "a\n😀x\n";
  const starts = lineStartOffsets(source);

  assert.deepEqual(sourceRangeForLocOrOffsets({
    loc: { start: { line: 2, column: 0 }, end: { line: 2, column: 2 } },
    start: 99,
    end: 100,
  }, starts), { start: 2, end: 4 });

  assert.deepEqual(sourceRangeForLocOrOffsets({ start: 1, end: 3 }, starts, (offset) => offset + 10), {
    start: 11,
    end: 13,
  });
});
