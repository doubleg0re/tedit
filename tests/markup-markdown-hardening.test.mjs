import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { modulePath } from "../scripts/path-helpers.mjs";

const cli = modulePath("../dist/cli.js", import.meta.url);

test("html structural edits compose across attrs classes comments and wrapping", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-html-hardening-"));
  const file = join(dir, "index.html");
  writeFileSync(file, `<main id="app"><section class="old"><p>Hello</p><span>Remove</span></section></main>`);

  run(["class", "add", file, "section.old", "panel", "--write"]);
  run(["class", "replace", file, "section.panel", "old", "new", "--write"]);
  run(["prop", "set", file, "section.panel", "data-state", "ready", "--write"]);
  run(["prepend", file, "section", "--element", '{"tag":"header","text":"Start"}', "--write"]);
  run(["append", file, "section", "--element", '{"tag":"footer","text":"End"}', "--write"]);
  run(["insertComment", file, "section", "note", "--position", "inside-start", "--write"]);
  run(["wrap", file, "p", "--with", "article", "--write"]);
  run(["text", "replace", file, "p", "--match-text", "Hello", "--with-text", "Hi", "--write"]);
  run(["remove", file, "span", "--write"]);
  run(["rename", file, "footer", "--to", "aside", "--write"]);
  run(["unwrap", file, "article", "--write"]);
  run(["verify-file", file, "--json"]);

  assert.equal(
    readFileSync(file, "utf8"),
    `<main id="app"><section class="new panel" data-state="ready"><!-- note --><header>Start</header><p>Hi</p><aside>End</aside></section></main>`,
  );
});

test("xml structural edits handle attributes text append and self-closing wrappers", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-xml-hardening-"));
  const file = join(dir, "feed.xml");
  writeFileSync(file, `<root><item id="a"><name>One</name></item><item id="b" /></root>`);

  run(["prop", "set", file, "item[id=a]", "status", "active", "--write"]);
  run(["text", "set", file, "name", "--value", "Uno", "--write"]);
  run(["append", file, "item[id=a]", "--element", '{"tag":"entry","attrs":{"lang":"en"}}', "--write"]);
  run(["wrap", file, "item[id=b]", "--with", "group", "--write"]);
  run(["unwrap", file, "group", "--write"]);
  run(["verify-file", file, "--json"]);

  assert.equal(
    readFileSync(file, "utf8"),
    `<root><item id="a" status="active"><name>Uno</name><entry lang="en"></entry></item><item id="b" /></root>`,
  );
});

test("markdown structural edits cover frontmatter headings paragraphs lists and code", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-md-hardening-"));
  const file = join(dir, "README.md");
  writeFileSync(file, [
    "---",
    "title: Demo",
    "---",
    "# Intro",
    "Old paragraph",
    "",
    "- old item",
    "",
    "```ts",
    "const oldValue = 1;",
    "```",
    "",
  ].join("\n"));

  run(["prop", "set", file, "frontmatter", "draft", "false", "--write"]);
  run(["rename", file, "heading[level=1]", "--to", "Overview", "--write"]);
  run(["text", "replace", file, "paragraph", "--match-text", "Old paragraph", "--with-text", "New paragraph", "--write"]);
  run(["text", "set", file, "list-item", "--value", "new item", "--write"]);
  run(["text", "set", file, "code[lang=ts]", "--value", "const newValue = 2;", "--write"]);
  run(["prepend", file, "heading[level=1]", "--element", '{"text":"Lead note."}', "--write"]);
  run(["append", file, "heading[level=1]", "--element", '{"text":"Extra note."}', "--write"]);
  run(["verify-file", file, "--json"]);

  const updated = readFileSync(file, "utf8");
  assert.match(updated, /---\ntitle: Demo\ndraft: false\n---/);
  assert.match(updated, /# Overview/);
  assert.match(updated, /Lead note\./);
  assert.match(updated, /New paragraph/);
  assert.match(updated, /- new item/);
  assert.match(updated, /```ts\nconst newValue = 2;\n```/);
  assert.match(updated, /Extra note\./);
});

test("markup and markdown invalid edits still fail atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-markup-invalid-"));
  const html = join(dir, "broken.html");
  const markdown = join(dir, "broken.md");
  const htmlInput = "<main><p>Hello</p></main>";
  const markdownInput = "# Title\n\n```ts\nconst ok = true;\n```\n";
  writeFileSync(html, htmlInput);
  writeFileSync(markdown, markdownInput);

  const htmlFailed = runFail(["edit", html, "--find", "</p>", "--replace", "</span>", "--write", "--json"]);
  assert.equal(htmlFailed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.equal(readFileSync(html, "utf8"), htmlInput);

  const markdownFailed = runFail(["edit", markdown, "--find", "\n```\n", "--replace", "\n", "--write", "--json"]);
  assert.equal(markdownFailed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.equal(readFileSync(markdown, "utf8"), markdownInput);
});

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", TEDIT_OUTPUT: "detailed" },
  });
  if (result.status !== 0) {
    assert.fail(`${args.join(" ")}\nstatus=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result.stdout;
}

function runFail(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", TEDIT_OUTPUT: "detailed" },
  });
  assert.notEqual(result.status, 0, args.join(" "));
  return {
    status: result.status,
    body: JSON.parse(result.stderr || result.stdout),
  };
}
