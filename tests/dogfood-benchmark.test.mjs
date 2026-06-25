import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/dogfood-benchmark.mjs", import.meta.url).pathname;

test("dogfood benchmark covers fixed agent adoption scenarios", () => {
  const result = JSON.parse(execFileSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.scenarios, 5);
  assert.equal(result.passed, 5);
  assert.ok(result.checks.includes("SearchToMultiedit"));
  assert.ok(result.checks.includes("AstShortcuts"));
  assert.ok(result.checks.includes("MarkupMarkdown"));
  assert.ok(result.checks.includes("PatchAndFileWrite"));
  assert.ok(result.checks.includes("RecoveryAndGuardrails"));
  assert.ok(result.metrics.compactResponses >= 10);
  assert.equal(typeof result.metrics.detailDescriptors, "number");
  assert.equal(typeof result.metrics.detailReads, "number");
  assert.equal(typeof result.metrics.detailReadBytes, "number");
  assert.ok(result.metrics.retryHints >= 2);
  assert.equal(result.metrics.parseGuardrails, 1);
  assert.ok(result.metrics.maxCompactBytes < 12000);
});
