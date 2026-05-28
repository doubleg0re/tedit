import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;

const corpusCases = [
  {
    name: "tsx component class and prop edit",
    file: "Page.tsx",
    input: `export function Page() {
  return <main><Button className="primary">Save</Button></main>;
}
`,
    commands: [
      ["class", "add", "{file}", "Button.primary", "rounded", "--write"],
      ["prop", "set", "{file}", "Button", "data-state", "ready", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `export function Page() {
  return <main><Button className="primary rounded" data-state="ready">Save</Button></main>;
}
`,
  },
  {
    name: "json object property edit",
    file: "config.json",
    input: `{
  "name": "demo",
  "flags": {
    "enabled": false
  }
}
`,
    commands: [
      ["prop", "set", "{file}", "flags", "enabled", "true", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `{
  "name": "demo",
  "flags": {
    "enabled": true
  }
}
`,
  },
  {
    name: "jsonl first record edit",
    file: "events.jsonl",
    input: `{"id":1,"status":"old"}
{"id":2,"status":"keep"}
`,
    commands: [
      ["prop", "set", "{file}", '[path="$[0]"]', "status", "new", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `{"id":1,"status":"new"}
{"id":2,"status":"keep"}
`,
  },
  {
    name: "yaml scalar edit with document markers",
    file: "config.yaml",
    input: `---
server:
  host: localhost
  port: 3000
...
`,
    commands: [
      ["text", "set", "{file}", '[path="$.server.port"]', "--value", "4000", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `---
server:
  host: localhost
  port: 4000
...
`,
  },
  {
    name: "markdown frontmatter and heading edit",
    file: "README.md",
    input: `---
title: Demo
...
# Intro
Old text
`,
    commands: [
      ["prop", "set", "{file}", "frontmatter", "draft", "false", "--write"],
      ["rename", "{file}", "heading[level=1]", "--to", "Overview", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `---
title: Demo
draft: false
...
# Overview
Old text
`,
  },
  {
    name: "mdx heading edit keeps component paragraph",
    file: "Doc.mdx",
    input: `# Demo

<Component prop="x" />
`,
    commands: [
      ["rename", "{file}", "heading[level=1]", "--to", "Docs", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `# Docs

<Component prop="x" />
`,
  },
  {
    name: "html class and text edit",
    file: "index.html",
    input: `<main id="app" class="old"><p>Hello</p></main>`,
    commands: [
      ["class", "replace", "{file}", "main.old", "old", "new", "--write"],
      ["text", "replace", "{file}", "p", "--match-text", "Hello", "--with-text", "Hi", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `<main id="app" class="new"><p>Hi</p></main>`,
  },
  {
    name: "svg namespaced element selected by attribute",
    file: "icon.svg",
    input: `<svg viewBox="0 0 10 10"><svg:path id="shape" d="M0 0" /></svg>`,
    commands: [
      ["prop", "set", "{file}", "#shape", "data-icon", "check", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `<svg viewBox="0 0 10 10"><svg:path id="shape" d="M0 0" data-icon="check" /></svg>`,
  },
];

test("corpus rule round-trips representative structural edits", () => {
  for (const item of corpusCases) {
    const dir = mkdtempSync(join(tmpdir(), "tedit-corpus-"));
    const file = join(dir, item.file);
    writeFileSync(file, item.input);

    const before = run(["verify-file", file, "--json"]);
    assert.equal(JSON.parse(before).parse_verified, true, `${item.name}: initial verify-file failed`);

    for (const command of item.commands) {
      run(command.map((arg) => arg === "{file}" ? file : arg), undefined, item.name);
    }

    assert.equal(readFileSync(file, "utf8"), item.expected, item.name);
  }
});

function run(args, input, label = args.join(" ")) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (result.status !== 0) {
    assert.fail(`${label}\nstatus=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result.stdout;
}
