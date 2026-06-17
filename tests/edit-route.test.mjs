import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveEditRoute } from "../dist/edit-route.js";
import { verifyParseForFile } from "../dist/base-edit.js";

test("trust-core structured formats route to the AST path", () => {
  for (const file of ["a.tsx", "b.jsx", "c.ts", "d.js", "e.json", "f.yaml", "g.yml"]) {
    assert.equal(resolveEditRoute(file).route, "ast", file);
  }
});

test("non-core formats route to the safe-string path", () => {
  for (const file of ["notes.md", "page.html", "data.txt", "Makefile", "x.unknown"]) {
    assert.equal(resolveEditRoute(file).route, "string", file);
  }
});

test("markdown has a structural adapter but is deliberately string-routed", () => {
  const decision = resolveEditRoute("README.md");
  assert.equal(decision.hasStructuralAdapter, true);
  assert.equal(decision.route, "string");
});

test("never-worse safety: string-routed known formats still fail loud on broken syntax", () => {
  assert.throws(
    () => verifyParseForFile("broken.json", "{ not valid"),
    (err) => err.code === "PARSE_BROKEN_AFTER_EDIT",
  );
  const ok = verifyParseForFile("notes.md", "# title\n\nbody\n");
  assert.equal(ok.verified, true);
  assert.equal(ok.parser, "markdown-lite");
});
