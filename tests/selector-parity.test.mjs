import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modulePath } from "../scripts/path-helpers.mjs";

const cli = modulePath("../dist/cli.js", import.meta.url);

const selectorMatrix = [
  ["#hero", ["hero"]],
  [".primary", ["hero", "badge"]],
  ["[data-kind=card]", ["hero", "secondary"]],
  ["main > section", ["hero", "secondary"]],
  ["h2 + p", ["intro"]],
  ["h2 ~ span", ["badge"]],
  ["section:has(> p)", ["hero", "secondary"]],
  ["section:not(.skip)", ["hero"]],
  ["section:first-child", ["hero"]],
  ["section:last-child", ["secondary"]],
  ["section:nth-of-type(2)", ["secondary"]],
  ["main:has(:scope > section + section)", ["root"]],
];

test("JSX and markup rules share selector parity for supported selectors", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-selector-parity-"));
  const jsx = join(dir, "Page.tsx");
  const html = join(dir, "index.html");
  writeFileSync(jsx, jsxFixture());
  writeFileSync(html, htmlFixture());

  for (const [selector, expected] of selectorMatrix) {
    const jsxIds = findDataIds(jsx, selector);
    const htmlIds = findDataIds(html, selector);
    assert.deepEqual(jsxIds, expected, `JSX ${selector}`);
    assert.deepEqual(htmlIds, expected, `markup ${selector}`);
    assert.deepEqual(htmlIds, jsxIds, `parity ${selector}`);
  }
});

function findDataIds(file, selector) {
  const result = JSON.parse(run(["find", file, selector, "--json"]));
  return result.matches.map((match) => match.attributes["data-id"]);
}

function jsxFixture() {
  return `export function Page() {
  return (
    <main data-id="root">
      <section id="hero" data-id="hero" data-kind="card" className="card primary">
        <h2 data-id="heading" />
        <p data-id="intro" />
        <span data-id="badge" className="primary" />
      </section>
      <section data-id="secondary" data-kind="card" className="card skip">
        <p data-id="second" />
      </section>
    </main>
  );
}
`;
}

function htmlFixture() {
  return `<main data-id="root">
  <section id="hero" data-id="hero" data-kind="card" class="card primary">
    <h2 data-id="heading"></h2>
    <p data-id="intro"></p>
    <span data-id="badge" class="primary"></span>
  </section>
  <section data-id="secondary" data-kind="card" class="card skip">
    <p data-id="second"></p>
  </section>
</main>`;
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (result.status !== 0) {
    assert.fail(`${args.join(" ")}\nstatus=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result.stdout;
}
