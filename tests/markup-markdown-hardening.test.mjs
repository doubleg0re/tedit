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

test("valid YAML frontmatter (folded scalars, sequences, continuations) is accepted", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-md-frontmatter-"));
  const file = join(dir, "SKILL.md");
  const srcFile = join(dir, "source.md");
  const source = [
    "---",
    "description: >-",
    "  Folded scalar first line",
    "  and its continuation",
    "tags:",
    "  - alpha",
    "  - beta",
    "keywords:",
    "- gamma",
    "- delta",
    "title: Foo",
    "---",
    "# Body",
    "",
  ].join("\n");

  // New-file creation must not be rejected as broken syntax.
  writeFileSync(srcFile, source);
  run(["write", file, "--from-file", srcFile, "--write"]);
  assert.equal(readFileSync(file, "utf8"), source);

  // verify-file must accept the same frontmatter.
  run(["verify-file", file, "--json"]);

  // The structural markdown parser must read the frontmatter too.
  run(["prop", "set", file, "frontmatter", "draft", "false", "--write"]);
  assert.match(readFileSync(file, "utf8"), /title: Foo\ndraft: false\n---/);
});

test("a leading --- opening prose with a colon stays a thematic break, not frontmatter", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-md-hr-"));
  const file = join(dir, "notes.md");
  // No closing fence, and the prose merely contains a colon; this must not be
  // misread as an unclosed frontmatter block.
  writeFileSync(file, ["---", "다음 상황에서 사용: 여러 요청을 배치로 처리할 때.", "More prose here.", ""].join("\n"));

  const verified = JSON.parse(run(["verify-file", file, "--json"]));
  assert.equal(verified.parse_verified, true);
});

test("parse failures are reported per context (create vs verify vs edit)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-parse-context-"));
  const srcFile = join(dir, "broken-source.json");
  writeFileSync(srcFile, "{\"enabled\":}");

  // Creating a new file: no edit exists, so the copy must not mention editing.
  const created = runFail(["write", join(dir, "new.json"), "--from-file", srcFile, "--write", "--json"]);
  assert.equal(created.body.code, "PARSE_BROKEN_ON_CREATE");
  assert.doesNotMatch(created.body.error, /Edit would produce/);

  // Verifying an unchanged file on disk: not an edit or a write.
  const onDisk = join(dir, "config.json");
  writeFileSync(onDisk, "{\"enabled\":}\n");
  const verified = runFail(["verify-file", onDisk, "--json"]);
  assert.equal(verified.body.code, "PARSE_INVALID");
  assert.doesNotMatch(verified.body.error, /Edit would produce|no write was performed/);
  assert.equal(readFileSync(onDisk, "utf8"), "{\"enabled\":}\n");

  // Editing an existing file keeps the edit-centric code and copy.
  const edited = join(dir, "edit.json");
  writeFileSync(edited, "{\"enabled\": true}\n");
  const failed = runFail(["edit", edited, "--find", "true", "--replace", "", "--write", "--json"]);
  assert.equal(failed.body.code, "PARSE_BROKEN_AFTER_EDIT");
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
