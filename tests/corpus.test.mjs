import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modulePath } from "../scripts/path-helpers.mjs";

const cli = modulePath("../dist/cli.js", import.meta.url);

const corpusCases = [
  {
    name: "javascript base edit parse verification",
    file: "helpers.js",
    input: `export function label() {
  return "old";
}
`,
    commands: [
      ["edit", "{file}", "--find", "old", "--replace", "new", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `export function label() {
  return "new";
}
`,
  },
  {
    name: "jsx text child edit",
    file: "Card.jsx",
    input: `export function Card() {
  return <span>Old</span>;
}
`,
    commands: [
      ["text", "replace", "{file}", "span", "--match-text", "Old", "--with-text", "New", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `export function Card() {
  return <span>New</span>;
}
`,
  },
  {
    name: "typescript base edit parse verification",
    file: "labels.ts",
    input: `export const label: string = "old";
`,
    commands: [
      ["edit", "{file}", "--find", "old", "--replace", "new", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `export const label: string = "new";
`,
  },
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
    name: "ndjson first record edit",
    file: "events.ndjson",
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
    name: "xml attribute edit",
    file: "feed.xml",
    input: `<root><item id="a">One</item></root>`,
    commands: [
      ["prop", "set", "{file}", "item[id=a]", "id", "b", "--write"],
      ["verify-file", "{file}", "--json"],
    ],
    expected: `<root><item id="b">One</item></root>`,
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

const invalidParserCases = [
  {
    name: "javascript invalid edit is atomic",
    file: "broken.js",
    input: "export function f() { return 1; }\n",
    command: ["edit", "{file}", "--find", "}", "--delete", "--write"],
  },
  {
    name: "jsonl invalid edit is atomic",
    file: "broken.jsonl",
    input: "{\"id\":1}\n{\"id\":2}\n",
    command: ["edit", "{file}", "--find", "1", "--replace", "}", "--write"],
  },
  {
    name: "yaml invalid edit is atomic",
    file: "broken.yaml",
    input: "server:\n  host: localhost\n",
    command: ["edit", "{file}", "--find", "  host: localhost", "--replace", "  \thost: localhost", "--write"],
  },
  {
    name: "markdown invalid edit is atomic",
    file: "broken.md",
    input: "# Title\n\n```ts\nconst ok = true;\n```\n",
    command: ["edit", "{file}", "--find", "\n```\n", "--replace", "\n", "--write"],
  },
  {
    name: "xml invalid edit is atomic",
    file: "broken.xml",
    input: "<root><item>One</item></root>",
    command: ["edit", "{file}", "--find", "</item>", "--replace", "</entry>", "--write"],
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

test("corpus invalid parser edits fail atomically", () => {
  for (const item of invalidParserCases) {
    const dir = mkdtempSync(join(tmpdir(), "tedit-corpus-invalid-"));
    const file = join(dir, item.file);
    writeFileSync(file, item.input);

    const failed = runFail(item.command.map((arg) => arg === "{file}" ? file : arg), item.name);

    assert.equal(failed.status, 1, item.name);
    assert.equal(failed.body.code, "PARSE_BROKEN_AFTER_EDIT", item.name);
    assert.equal(readFileSync(file, "utf8"), item.input, item.name);
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

function runFail(args, label = args.join(" ")) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  assert.notEqual(result.status, 0, label);
  return {
    status: result.status,
    body: JSON.parse(result.stderr || result.stdout),
  };
}
