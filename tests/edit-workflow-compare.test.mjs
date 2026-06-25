import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/compare-edit-workflows.mjs", import.meta.url).pathname;

test("edit workflow comparison reports tedit and plain workload metrics", () => {
  const output = execFileSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", TEDIT_COMPARE_RUNS: "1" },
  });
  const result = JSON.parse(output);

  assert.equal(result.ok, true);
  assert.equal(result.runs, 1);
  assert.match(result.tokenEstimateMethod, /proxy only/);
  assert.equal(result.scenarios.length, 4);
  for (const scenario of result.scenarios) {
    assert.equal(typeof scenario.name, "string");
    assert.equal(scenario.tedit.runs, 1);
    assert.equal(scenario.plain.runs, 1);
    assert.ok(scenario.tedit.medianOperations >= 1);
    assert.ok(scenario.plain.medianOperations >= 1);
    assert.ok(scenario.tedit.medianEstimatedTokens > 0);
    assert.ok(scenario.plain.medianEstimatedTokens > 0);
    assert.equal(typeof scenario.tedit.medianDetailDescriptors, "number");
    assert.equal(typeof scenario.tedit.medianDetailReads, "number");
    assert.equal(typeof scenario.tedit.medianDetailReadBytes, "number");
    assert.equal(typeof scenario.plain.medianDetailDescriptors, "number");
    assert.equal(typeof scenario.plain.medianDetailReads, "number");
  }
});
