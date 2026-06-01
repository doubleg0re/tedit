import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const mcp = new URL("../dist/mcp.js", import.meta.url).pathname;
const distDir = new URL("../dist", import.meta.url).pathname;

test("find returns JSX nodes as JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, fixture());

  const output = run(["find", file, "main", "--json"]);
  const result = JSON.parse(output);

  assert.equal(result.success, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].name, "main");
});

test("compact discovery output preserves payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, fixture());

  const find = JSON.parse(runRaw(["find", file, "main"]));
  assert.equal(find.ok, true);
  assert.equal(find.kind, "find");
  assert.match(find.summary, /1 match/);
  assert.equal(find.matches.length, 1);
  assert.equal(find.matches[0].name, "main");

  const inspect = JSON.parse(runRaw(["inspect", file, "main"]));
  assert.equal(inspect.ok, true);
  assert.equal(inspect.kind, "inspect");
  assert.equal(inspect.node.name, "main");

  const verify = JSON.parse(runRaw(["verify-file", file]));
  assert.equal(verify.ok, true);
  assert.equal(verify.kind, "verify-file");
  assert.equal(verify.path, file);
  assert.equal(verify.parse_verified, true);
  assert.equal(verify.parser, "jsx");

  const actions = JSON.parse(runRaw(["actions", file]));
  assert.equal(actions.ok, true);
  assert.equal(actions.kind, "actions");
  assert.ok(actions.actions.includes("wrap"));
  assert.ok(actions.rules.some((rule) => rule.name === "jsx"));

  const rules = JSON.parse(runRaw(["rules"]));
  assert.equal(rules.ok, true);
  assert.equal(rules.kind, "rules");
  assert.ok(rules.rules.some((rule) => rule.name === "jsx"));

  const stateFile = join(dir, "StatePage.tsx");
  writeFileSync(stateFile, refactorStateFixture());
  const state = JSON.parse(runRaw(["analyze-state", stateFile]));
  assert.equal(state.ok, true);
  assert.equal(state.kind, "analyze-state");
  assert.equal(state.path, stateFile);
  assert.equal(typeof state.states_total, "number");
  assert.equal(typeof state.handlers_total, "number");
  assert.ok(Array.isArray(state.clusters));
  assert.ok(state.analysis_summary);
});

test("ast string scan selects and edits hardcoded strings", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, [
    "import x from \"./x\";",
    "const msg = \"실패\";",
    "const item = { label: \"삭제\", path: \"/api/users\" };",
    "alert(\"오류\");",
    "export function Page() {",
    "  return <button className=\"px-2\" placeholder=\"검색\">저장</button>;",
    "}",
    "",
  ].join("\n"));

  const scan = JSON.parse(run(["scan-strings", file, "--json"]));
  const values = scan.strings.map((item) => item.value);
  assert.deepEqual(scan.strings.map((item) => item.id), ["str_1", "str_2", "str_3", "str_4", "str_5"]);
  assert.ok(values.includes("실패"));
  assert.ok(values.includes("삭제"));
  assert.ok(values.includes("오류"));
  assert.ok(values.includes("검색"));
  assert.ok(values.includes("저장"));
  assert.equal(values.includes("./x"), false);
  assert.equal(values.includes("/api/users"), false);
  assert.equal(values.includes("px-2"), false);
  assert.ok(scan.excludedCount >= 3);

  const label = JSON.parse(run(["ast-select", file, 'ObjectProperty[key.name="label"] > StringLiteral', "--json"]));
  assert.equal(label.kind, "ast-select");
  assert.equal(label.matches.length, 1);
  assert.equal(label.matches[0].value, "삭제");
  assert.equal(label.matches[0].editable, true);

  const alertCall = JSON.parse(run(["ast-select", file, 'CallExpression[callee.name="alert"]', "--json"]));
  assert.equal(alertCall.matches.length, 1);
  assert.equal(alertCall.matches[0].type, "CallExpression");

  const edit = JSON.parse(run(["ast-edit", file, 'ObjectProperty[key.name="label"]', "--replace", "Delete", "--write", "--json"]));
  assert.equal(edit.success, true);
  assert.equal(edit.changed, true);
  assert.equal(edit.written, true);
  assert.equal(edit.parse_verified, true);
  assert.match(readFileSync(file, "utf8"), /label: "Delete"/);

  const shortcutFile = join(dir, "shortcut.tsx");
  writeFileSync(shortcutFile, "const item = { label: \"삭제\" };\n");
  const shortcut = JSON.parse(run(["ast-edit", shortcutFile, "--object-key", "label", "--replace", "Shortcut", "--write", "--json"]));
  assert.equal(shortcut.success, true);
  assert.match(readFileSync(shortcutFile, "utf8"), /label: "Shortcut"/);
});

test("search-text and inspect-range bridge grep and sed workflows", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const src = join(dir, "src");
  const file = join(src, "Page.tsx");
  const helper = join(src, "labels.ts");
  const ignored = join(src, "style.css");
  mkdirSync(src, { recursive: true });
  writeFileSync(file, [
    "export function Page() {",
    "  const label = \"삭제\";",
    "  return <button>{label}</button>;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(helper, "export const copy = \"삭제\";\n");
  writeFileSync(ignored, ".delete { content: \"삭제\"; }\n");

  const search = JSON.parse(run(["search-text", "삭제", src, "--glob", "**/*.tsx", "--context", "1", "--multiedit-spec", "--replace", "Delete", "--json"]));
  assert.equal(search.kind, "search-text");
  assert.equal(search.count, 1);
  assert.equal(search.context, 1);
  assert.equal(search.multiedit.edits.length, 1);
  assert.equal(search.multiedit.edits[0].replace, "Delete");
  assert.equal(search.multiedit.edits[0].replaceAll, true);
  assert.equal(search.multiedit.edits[0].expectCount, 1);
  assert.equal(search.results[0].id, "text_1");
  assert.equal(search.results[0].match, "삭제");
  assert.equal(search.results[0].range.line, 2);
  assert.deepEqual(search.results[0].context.expanded, { start: 1, end: 3 });
  assert.equal(search.results[0].context.lines.length, 3);
  assert.equal(search.results[0].context.lines[2].text, "  return <button>{label}</button>;");
  assert.equal(search.results[0].suggested.tool, "edit");
  assert.equal(search.results[0].suggested.findLines, "2");
  assert.match(search.results[0].suggested.replaceHint, /trailing newline/);
  assert.equal(search.results[0].suggestions[0].tool, "inspect_range");
  assert.equal(search.results[0].suggestions[0].cliCommand, "inspect-range");

  const braceGlobSearch = JSON.parse(run(["search-text", "삭제", src, "--glob", "**/*.{tsx, ts}", "--multiedit-spec", "--replace", "Delete", "--json"]));
  assert.equal(braceGlobSearch.count, 2);
  assert.equal(braceGlobSearch.multiedit.edits.length, 2);
  assert.deepEqual(braceGlobSearch.results.map((result) => basename(result.file)).sort(), ["Page.tsx", "labels.ts"]);

  const helperVerify = JSON.parse(run(["verify-file", helper, "--json"]));
  assert.equal(helperVerify.parse_verified, true);
  assert.equal(helperVerify.parser, "typescript");

  const generatedMultiedit = JSON.parse(runWithInput(["multiedit", "--from-stdin", "--dry-run"], JSON.stringify(search.multiedit)));
  assert.equal(generatedMultiedit.success, true);
  assert.equal(generatedMultiedit.results.length, 1);
  assert.equal(generatedMultiedit.results[0].matches.length, 1);

  const regex = JSON.parse(run(["search-text", "--query", 'const\\s+label', src, "--regex", "--json"]));
  assert.equal(regex.regex, true);
  assert.equal(regex.count, 1);
  assert.equal(regex.results[0].match, "const label");

  const inspect = JSON.parse(run(["inspect-range", file, "--lines", "2:2", "--context", "1", "--json"]));
  assert.equal(inspect.kind, "inspect-range");
  assert.deepEqual(inspect.requested, { start: 2, end: 2 });
  assert.deepEqual(inspect.expanded, { start: 1, end: 3 });
  assert.equal(inspect.lines.length, 3);
  assert.equal(inspect.lines[1].text, "  const label = \"삭제\";");
  assert.equal(inspect.parse_verified, true);
  assert.equal(inspect.suggested.tool, "edit");
  assert.equal(inspect.suggested.findLines, "2:2");
  assert.match(inspect.suggested.replaceHint, /trailing newline/);

  const edit = JSON.parse(run(["edit", file, "--find-lines", "2", "--replace", "  const label = \"Delete\";\n", "--write", "--json"]));
  assert.equal(edit.written, true);
  assert.match(readFileSync(file, "utf8"), /"Delete"/);
  assert.match(readFileSync(file, "utf8"), /"Delete";\n  return/);
});

test("history-trace reports git line and text history", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-git-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tedit@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "tedit"], { cwd: dir });
  const file = join(dir, "Page.tsx");
  writeFileSync(file, "export function Page() {\n  return \"Before\";\n}\n");
  execFileSync("git", ["add", "Page.tsx"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial page"], { cwd: dir, stdio: "ignore" });
  writeFileSync(file, "export function Page() {\n  return \"After\";\n}\n");
  execFileSync("git", ["add", "Page.tsx"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "change label"], { cwd: dir, stdio: "ignore" });

  const lineHistory = JSON.parse(runInCwd(["history-trace", file, "--lines", "2:2", "--json"], dir));
  assert.equal(lineHistory.kind, "history-trace");
  assert.equal(lineHistory.target.type, "lines");
  assert.equal(lineHistory.blame.length, 1);
  assert.equal(lineHistory.blame[0].lineCount, 1);
  assert.ok(lineHistory.commands.blame.includes("git"));

  const textHistory = JSON.parse(runInCwd(["history-trace", file, "--contains", "After", "--json"], dir));
  assert.equal(textHistory.target.type, "contains");
  assert.ok(textHistory.commits.some((commit) => commit.subject === "change label"));
  assert.ok(textHistory.commands.log.includes("-S"));
});

test("append dry-run prints a diff and does not write", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, fixture());

  const output = run(["append", file, "main", "--element", '{"tag":"PageHead"}']);

  assert.match(output, /PageHead/);
  assert.doesNotMatch(readFileSync(file, "utf8"), /PageHead/);
});

test("wrap writes a matching wrapper around the selected element", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, fixture());

  run(["wrap", file, 'section[className*="today"]', "--with", "Card", "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<Card>/);
  assert.match(updated, /<\/Card>/);
  assert.match(updated, /<section className="today-card">/);
});

test("flow can store node refs, append children, and insert JSX comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const flow = join(dir, "flow.json");
  writeFileSync(file, fixture());
  writeFileSync(flow, JSON.stringify({
    info: { name: "add-page-head" },
    flow: [
      { comment: "Find page body" },
      { action: "find", selector: "main", out: "body" },
      { action: "append", target: "{{body}}", element: { tag: "PageHead" }, out: "head" },
      { action: "insertComment", target: "{{head}}", position: "inside-start", text: "Generated page controls" },
      { action: "append", target: "{{head}}", element: { tag: "LeftPanel" } }
    ]
  }, null, 2));

  run(["flow", file, flow, "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<PageHead>/);
  assert.match(updated, /Generated page controls/);
  assert.match(updated, /<LeftPanel \/>/);
});

test("chain converts :: segments into a flow with $ret references", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, fixture());

  run(["chain", file, "find", "main", "::", "append", "$ret", "PageHead", "::", "append", "$ret.id", "LeftPanel", "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<PageHead>/);
  assert.match(updated, /<LeftPanel \/>/);
});

test("chain supports named outputs, @refs, and element shorthand", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, chainFixture());

  run([
    "chain", file,
    "find", "ScrollArea", "as", "sa",
    "::", "rename", "@sa", "div",
    "::", "find", "DailyPlanBody", "as", "body",
    "::", "wrap", "@body", 'div.flex.flex-1.flex-col.gap-4',
    "::", "prop.set", "@sa", "data-testid", "scroll-body",
    "--write"
  ]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<div viewportClassName="px-7" data-testid="scroll-body">/);
  assert.match(updated, /<div className="flex flex-1 flex-col gap-4"><DailyPlanBody \/><\/div>/);
});

test("chain accepts standalone-style flags inside steps", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const chainFile = join(dir, "flags.chain");
  writeFileSync(file, chainFixture());
  writeFileSync(chainFile, `find ScrollArea as sa
rename @sa --to div
find DailyPlanBody as body
wrap @body --with div.flex.gap-4
prop.set @sa data-testid --expr testId
`);

  run(["chain", file, "--from-file", chainFile, "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<div viewportClassName="px-7" data-testid=\{testId\}>/);
  assert.doesNotMatch(updated, /<--to/);
  assert.match(updated, /<div className="flex gap-4"><DailyPlanBody \/><\/div>/);
});

test("inline chain preserves step flags instead of parsing them as top-level flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, chainFixture());

  run(["chain", file, "find", "ScrollArea", "as", "sa", "::", "rename", "@sa", "--to", "div", "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<div viewportClassName="px-7">/);
  assert.doesNotMatch(updated, /<--to/);
});

test("chain rejects unknown step flags loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const chainFile = join(dir, "bad.chain");
  writeFileSync(file, chainFixture());
  writeFileSync(chainFile, `find ScrollArea as sa
rename @sa --bad div
`);

  const failed = runFail(["chain", file, "--from-file", chainFile, "--write"]);
  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "INVALID_CHAIN");
  assert.match(failed.body.error, /unknown argument "--bad"/);
  assert.match(failed.body.error, /line 2/);
  assert.match(readFileSync(file, "utf8"), /<ScrollArea/);
});

test("chain element shorthand supports boolean expr and text children", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, fixture());

  run([
    "chain", file,
    "find", "main", "as", "root",
    "::", "append", "@root", 'Button.variant="primary".disabled.onClick={handleClick}.children="확인"',
    "--write"
  ]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<Button variant="primary" disabled onClick=\{handleClick\}>확인<\/Button>/);
});

test("chain can load line-based input from a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const chainFile = join(dir, "edit.chain");
  writeFileSync(file, chainFixture());
  writeFileSync(chainFile, `# implicit :: between non-empty lines
find ScrollArea[viewportClassName="px-7"] as sa
rename @sa div
prop.remove @sa viewportClassName
find DailyPlanBody as body
wrap @body div.flex.gap-4
`);

  run(["chain", file, "--from-file", chainFile, "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<div>/);
  assert.doesNotMatch(updated, /viewportClassName=/);
  assert.match(updated, /<div className="flex gap-4"><DailyPlanBody \/><\/div>/);
});

test("chain can load line-based input from stdin", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, fixture());

  runWithInput(["chain", file, "--from-stdin", "--write"], `find main as root
append @root PageHead
append $ret.id LeftPanel
`);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<PageHead>/);
  assert.match(updated, /<LeftPanel \/>/);
});

test("ambiguous selector fails with a stable error code", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, `export function Page() {
  return (
    <main>
      <section id="intro" />
      <section className="summary-card" />
      <section data-testid="details" />
    </main>
  );
}
`);

  const failed = runFail(["wrap", file, "section", "--with", "Card", "--write"]);
  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "AMBIGUOUS_SELECTOR");
  assert.match(failed.body.error, /matched 3 nodes/);
  assert.deepEqual(failed.body.details.selector_candidates.map((candidate) => candidate.selector), ["#intro", "section.summary-card", 'section[data-testid="details"]']);
  assert.deepEqual(failed.body.suggestions, ["Retry with selector #intro.", "Retry with selector section.summary-card.", 'Retry with selector section[data-testid="details"].']);
});

test("selector failures include base literal candidates", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, `export function Page() {
  return <Button>SaveButton</Button>;
}
`);

  const failed = runFail(["wrap", file, "SaveButton", "--with", "Card", "--write"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "NODE_NOT_FOUND");
  assert.deepEqual(failed.body.details.base_candidates, [
    { line: 2, preview: "return <Button>SaveButton</Button>;" }
  ]);
});

test("find traverses fragments, conditionals, and map callbacks", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Complex.tsx");
  writeFileSync(file, `export function Complex({ items, isOpen }) {
  return (
    <>
      {isOpen && <Modal open={isOpen} />}
      {items.map((item) => (
        <TodoItem key={item.id} item={item} />
      ))}
    </>
  );
}
`);

  const modal = JSON.parse(run(["find", file, "Modal[open]", "--json"]));
  const todo = JSON.parse(run(["find", file, "TodoItem[item]", "--json"]));
  const fragment = JSON.parse(run(["find", file, "Fragment", "--json"]));

  assert.equal(modal.matches.length, 1);
  assert.equal(todo.matches.length, 1);
  assert.equal(fragment.matches.length, 1);
});

test("find supports structural selectors and expression containers", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Selectors.tsx");
  writeFileSync(file, structuralSelectorFixture());

  const descendant = JSON.parse(run(["find", file, "ContentView ScrollArea", "--json"]));
  const directChild = JSON.parse(run(["find", file, 'DialogFooter > Button[variant="primary"]', "--json"]));
  const hasImage = JSON.parse(run(["find", file, "Card:has(Image)", "--json"]));
  const withoutImage = JSON.parse(run(["find", file, "Card:not(:has(Image))", "--json"]));
  const secondRadio = JSON.parse(run(["find", file, "Radio:nth-of-type(2)", "--json"]));
  const expression = JSON.parse(run(["find", file, "ContentView :expr", "--json"]));

  assert.equal(descendant.matches.length, 1);
  assert.equal(descendant.matches[0].attributes["data-area"], "body");
  assert.equal(directChild.matches.length, 1);
  assert.equal(directChild.matches[0].attributes.variant, "primary");
  assert.equal(hasImage.matches.length, 1);
  assert.equal(hasImage.matches[0].attributes["data-card"], "with-image");
  assert.equal(withoutImage.matches.length, 1);
  assert.equal(withoutImage.matches[0].attributes["data-card"], "without-image");
  assert.equal(secondRadio.matches.length, 1);
  assert.equal(secondRadio.matches[0].attributes.value, "b");
  assert.equal(expression.matches.length, 1);
  assert.equal(expression.matches[0].kind, "expression");
});

test("find supports scoped relative selectors inside :has", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "ScopedHas.tsx");
  writeFileSync(file, `export function ScopedHas() {
  return (
    <main>
      <div data-kind="direct"><br /></div>
      <div data-kind="nested"><span><br /></span></div>
      <section data-kind="section"><div><br /></div></section>
    </main>
  );
}
`);

  const direct = JSON.parse(run(["find", file, "main > div:has(> br)", "--json"]));
  const loose = JSON.parse(run(["find", file, "main > div:has(br)", "--json"]));
  const nestedChain = JSON.parse(run(["find", file, "main > div:has(> span > br)", "--json"]));
  const section = JSON.parse(run(["find", file, "section:has(> div > br)", "--json"]));
  const noDirectSectionBr = JSON.parse(run(["find", file, "section:has(> br)", "--json"]));

  assert.deepEqual(direct.matches.map((match) => match.attributes["data-kind"]), ["direct"]);
  assert.deepEqual(loose.matches.map((match) => match.attributes["data-kind"]), ["direct", "nested"]);
  assert.deepEqual(nestedChain.matches.map((match) => match.attributes["data-kind"]), ["nested"]);
  assert.deepEqual(section.matches.map((match) => match.attributes["data-kind"]), ["section"]);
  assert.equal(noDirectSectionBr.matches.length, 0);
});

test("find supports :scope and sibling combinators", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "SiblingSelectors.tsx");
  writeFileSync(file, `export function SiblingSelectors() {
  return (
    <main data-id="root">
      <Label data-id="main-label" />
      <Input data-id="main-input" />
      <Hint data-id="main-hint" />
      <Input data-id="later-input" />
      <section data-id="field">
        <Label data-id="field-label" />
        <Input data-id="field-input" />
        <Hint data-id="field-hint" />
      </section>
      <h2 data-id="heading" />
      <p data-id="intro" />
    </main>
  );
}
`);

  const adjacent = JSON.parse(run(["find", file, "Label + Input", "--json"]));
  const general = JSON.parse(run(["find", file, "Label ~ Hint", "--json"]));
  const headingParagraph = JSON.parse(run(["find", file, "h2 + p", "--json"]));
  const headingWithNextParagraph = JSON.parse(run(["find", file, "h2:has(+ p)", "--json"]));
  const scopedChain = JSON.parse(run(["find", file, "main:has(:scope > h2 + p)", "--json"]));
  const noAdjacent = JSON.parse(run(["find", file, "Label + Hint", "--json"]));

  assert.deepEqual(adjacent.matches.map((match) => match.attributes["data-id"]), ["main-input", "field-input"]);
  assert.deepEqual(general.matches.map((match) => match.attributes["data-id"]), ["main-hint", "field-hint"]);
  assert.deepEqual(headingParagraph.matches.map((match) => match.attributes["data-id"]), ["intro"]);
  assert.deepEqual(headingWithNextParagraph.matches.map((match) => match.attributes["data-id"]), ["heading"]);
  assert.deepEqual(scopedChain.matches.map((match) => match.attributes["data-id"]), ["root"]);
  assert.equal(noAdjacent.matches.length, 0);
});

test("find supports CSS id and class shorthand selectors", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "CssSelectors.tsx");
  writeFileSync(file, `export function CssSelectors() {
  return (
    <main>
      <div id="hero" className="card primary">
        <span className="primary" />
      </div>
      <Button className="primary" />
      <Card.Header className="title" />
      <a href="https://example.com/docs/start" rel="external help current" lang="en-US" data-kind="docs-card" />
    </main>
  );
}
`);

  const byIdAndClass = JSON.parse(run(["find", file, "div#hero.card", "--json"]));
  const anyPrimary = JSON.parse(run(["find", file, ".primary", "--json"]));
  const componentClass = JSON.parse(run(["find", file, "Button.primary", "--json"]));
  const memberComponentClass = JSON.parse(run(["find", file, "Card.Header.title", "--json"]));
  const classAttrAlias = JSON.parse(run(["find", file, 'div[class="card primary"]', "--json"]));
  const hrefPrefix = JSON.parse(run(["find", file, 'a[href^="https://example.com"]', "--json"]));
  const hrefSuffix = JSON.parse(run(["find", file, 'a[href$="/start"]', "--json"]));
  const relWord = JSON.parse(run(["find", file, 'a[rel~="help"]', "--json"]));
  const langDash = JSON.parse(run(["find", file, 'a[lang|="en"]', "--json"]));
  const unquotedAttr = JSON.parse(run(["find", file, "a[data-kind=docs-card]", "--json"]));

  assert.equal(byIdAndClass.matches.length, 1);
  assert.equal(byIdAndClass.matches[0].name, "div");
  assert.equal(anyPrimary.matches.length, 3);
  assert.equal(componentClass.matches.length, 1);
  assert.equal(componentClass.matches[0].name, "Button");
  assert.equal(memberComponentClass.matches.length, 1);
  assert.equal(memberComponentClass.matches[0].name, "Card.Header");
  assert.equal(classAttrAlias.matches.length, 1);
  assert.equal(hrefPrefix.matches[0].attributes["data-kind"], "docs-card");
  assert.equal(hrefSuffix.matches[0].attributes["data-kind"], "docs-card");
  assert.equal(relWord.matches[0].attributes["data-kind"], "docs-card");
  assert.equal(langDash.matches[0].attributes["data-kind"], "docs-card");
  assert.equal(unquotedAttr.matches[0].attributes["data-kind"], "docs-card");
});

test("unsupported selector pseudos fail with actionable diagnostics", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "UnsupportedSelector.tsx");
  writeFileSync(file, `export function UnsupportedSelector() {
  return <main><Card /></main>;
}
`);

  const pseudo = runFail(["find", file, "Card:nth-child(1)", "--json"]);
  const pseudoElement = runFail(["find", file, "Card::before", "--json"]);

  assert.equal(pseudo.status, 1);
  assert.equal(pseudo.body.code, "UNSUPPORTED_SELECTOR");
  assert.match(pseudo.body.error, /Unsupported pseudo-class :nth-child/);
  assert.match(pseudo.body.error, /Supported pseudos: .*:nth-of-type\(n\)/);
  assert.equal(pseudoElement.body.code, "UNSUPPORTED_SELECTOR");
  assert.match(pseudoElement.body.error, /Unsupported pseudo-element ::before/);
});

test("agent-facing diagnostics include rule hints suggestions and snippets", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const html = join(dir, "index.html");
  const yaml = join(dir, "config.yaml");
  const badYaml = join(dir, "bad.yaml");
  writeFileSync(html, '<main><p>Hello</p></main>');
  writeFileSync(yaml, 'name: demo\n');
  writeFileSync(badYaml, 'name: one\nname: two\n');

  const missing = runFail(["remove", html, "article", "--write", "--json"]);
  assert.equal(missing.body.code, "NODE_NOT_FOUND");
  assert.equal(missing.body.details.rule, "markup");
  assert.match(missing.body.details.selector_hint, /:has/);
  assert.match(missing.body.suggestions[0], /tedit inspect/);

  const unsupported = runFail(["class", "add", yaml, "root", "highlight", "--json"]);
  assert.equal(unsupported.body.code, "UNSUPPORTED_ACTION");
  assert.equal(unsupported.body.details.rule, "yaml");
  assert.match(unsupported.body.details.capability_hint, /yaml supports:/);
  assert.match(unsupported.body.suggestions[0], /tedit actions/);

  const parseFailure = runFail(["verify-file", badYaml, "--json"]);
  assert.equal(parseFailure.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.equal(parseFailure.body.details.rule, "yaml-lite");
  assert.equal(parseFailure.body.details.line, 2);
  assert.equal(parseFailure.body.details.snippet, "name: two");
  assert.match(parseFailure.body.suggestions[0], /reported line/);
});

test("class actions add remove and replace static className tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, `export function Page() {
  return <>
    <Button className="px-2 text-sm" />
    <Icon />
  </>;
}
`);

  run(["class", "add", file, "Button", "rounded", "px-2", "--write"]);
  run(["class", "remove", file, "Button", "text-sm", "--write"]);
  run(["class", "replace", file, "Button", "px-2", "px-4", "--write"]);
  run(["class", "add", file, "Icon", "inline", "--write"]);

  const updated = readFileSync(file, "utf8");
  assert.match(updated, /className="px-4 rounded"/);
  assert.match(updated, /<Icon className="inline" \/>/);
  assert.doesNotMatch(updated, /text-sm/);
});

test("chain can run JSX class actions", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, `export function Page() {
  return <Button className="px-2 text-sm" />;
}
`);

  run([
    "chain", file,
    "find", "Button", "as", "button",
    "::", "class.add", "@button", "rounded", "shadow-sm",
    "::", "class.replace", "@button", "text-sm", "text-base",
    "--write"
  ]);

  assert.match(readFileSync(file, "utf8"), /className="px-2 text-base rounded shadow-sm"/);
});

test("class actions reject expression className without writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const source = `export function Page({ className }) {
  return <Button className={className} />;
}
`;
  writeFileSync(file, source);

  const failed = runFail(["class", "add", file, "Button", "rounded", "--write"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "UNSUPPORTED_CLASS_VALUE");
  assert.equal(readFileSync(file, "utf8"), source);
});

test("chain CSS-style element shorthand creates id and class attributes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, chainFixture());

  run(["chain", file, "find", "DailyPlanBody", "as", "body", "::", "wrap", "@body", 'div#content.flex.gap-4[data-testid="body"]', "--write"]);

  const updated = readFileSync(file, "utf8");
  assert.match(updated, /<div id="content" className="flex gap-4" data-testid="body"><DailyPlanBody \/><\/div>/);
});

test("expr.replace patches the targeted JSX expression container", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Expression.tsx");
  writeFileSync(file, structuralSelectorFixture());

  run(["expr", "replace", file, "ContentView :expr", "--code", "cond ? <InlinePanel /> : <FallbackPanel />", "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /\{cond \? <InlinePanel \/> : <FallbackPanel \/>\}/);
  assert.doesNotMatch(updated, /cond && <InlinePanel \/>/);
});

test("expression helpers wrap unwrap and convert conditionals", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "ExpressionHelpers.tsx");
  writeFileSync(file, expressionHelpersFixture());

  run(["expr", "toTernary", file, "Panel :expr:has(InlinePanel)", "--alternate", "<FallbackPanel />", "--write"]);
  run(["expr", "toShortCircuit", file, "Panel :expr:has(ReadyPanel)", "--write"]);
  run(["expr", "unwrap", file, "Panel :expr:has(OpenPanel)", "--write"]);
  run(["expr", "wrap", file, "Label :expr", "--code", "String($expr)", "--write"]);

  const updated = readFileSync(file, "utf8");

  assert.match(updated, /\{cond \? <InlinePanel \/> : <FallbackPanel \/>\}/);
  assert.match(updated, /\{ready && <ReadyPanel \/>\}/);
  assert.match(updated, /\{open && <OpenPanel \/>\}/);
  assert.match(updated, /<Label value=\{String\(label\)\} \/>/);
});

test("text.set replaces all children and can convert self-closing elements", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Text.tsx");
  writeFileSync(file, `export function Text({ t }) {
  return (
    <div>
      <Button>저장</Button>
      <Label />
    </div>
  );
}
`);

  run(["text", "set", file, "Button", "--value", "확인", "--write"]);
  run(["text", "set", file, "Label", "--expr", 't("label")', "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<Button>확인<\/Button>/);
  assert.match(updated, /<Label>\{t\("label"\)\}<\/Label>/);
});

test("text.replace swaps matching text children without removing siblings", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Text.tsx");
  writeFileSync(file, `export function Text() {
  return <Button><Icon /> 저장</Button>;
}
`);

  run(["text", "replace", file, "Button", "--match-text", "저장", "--with-text", "확인", "--write"]);

  assert.match(readFileSync(file, "utf8"), /<Button><Icon \/> 확인<\/Button>/);
});

test("text.replace miss with padded text reports trimmed candidates", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Text.tsx");
  writeFileSync(file, `export function Text() {
  return <Button><Icon /> 저장</Button>;
}
`);

  const failed = runFail(["text", "replace", file, "Button", "--match-text", " 저장", "--with-text", "확인", "--write"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "TEXT_MATCH_NONE");
  assert.equal(failed.body.details.trimmed_request, "저장");
  assert.match(failed.body.details.note, /trims leading and trailing whitespace/);
  assert.equal(failed.body.details.candidates[0].trimmed_text, "저장");
  assert.match(failed.body.details.suggestions[0], /--match-text/);
  assert.match(readFileSync(file, "utf8"), /저장/);
});

test("text.replace swaps expression children by canonical expression source", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Text.tsx");
  writeFileSync(file, `export function Text({ t }) {
  return <Button>{t("save")}</Button>;
}
`);

  run(["text", "replace", file, "Button", "--match-expr", 't("save")', "--with-expr", 't("confirm")', "--write"]);

  assert.match(readFileSync(file, "utf8"), /\{t\("confirm"\)\}/);
});

test("chain can run text.set and text.replace steps", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Text.tsx");
  writeFileSync(file, `export function Text() {
  return <div><Button>저장</Button><Label>대기</Label></div>;
}
`);

  run([
    "chain", file,
    "find", "Button", "as", "btn",
    "::", "text.replace", "@btn", "--match-text", "저장", "--with-text", "확인",
    "::", "find", "Label", "as", "label",
    "::", "text.set", "@label", "--value", "완료",
    "--write"
  ]);

  const updated = readFileSync(file, "utf8");
  assert.match(updated, /<Button>확인<\/Button>/);
  assert.match(updated, /<Label>완료<\/Label>/);
});

test("flow supports import add remove rename and move", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Imports.tsx");
  const flow = join(dir, "imports-flow.json");
  writeFileSync(file, `import { Button, ScrollArea } from "@/button";
import { LegacyIcon } from "@/old-icon";
import { OldName } from "@/legacy";

export function Imports() {
  return <Button />;
}
`);
  writeFileSync(flow, JSON.stringify({
    flow: [
      { action: "imports.remove", from: "@/button", named: ["ScrollArea"] },
      { action: "imports.add", from: "@/button", named: ["IconButton"] },
      { action: "imports.rename", from: "@/legacy", name: "OldName", to: "NewName" },
      { action: "imports.move", from: "@/old-icon", to: "@/icons", named: ["LegacyIcon"] }
    ]
  }, null, 2));

  run(["flow", file, flow, "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.doesNotMatch(updated, /ScrollArea/);
  assert.match(updated, /import \{ Button, IconButton \} from "@\/button";/);
  assert.match(updated, /import \{ NewName \} from "@\/legacy";/);
  assert.doesNotMatch(updated, /@\/old-icon/);
  assert.match(updated, /import \{ LegacyIcon \} from "@\/icons";/);
});

test("create writes parse-clean source only with --write and refuses overwrite by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "components", "Button.tsx");

  const source = "export function Button() { return <button />; }";
  const dryRun = run(["create", file, "--source", source]);
  assert.match(dryRun, /Button/);
  assert.throws(() => readFileSync(file, "utf8"));

  run(["create", file, "--source", source, "--write"]);
  const matches = JSON.parse(run(["find", file, "button", "--json"]));
  assert.equal(matches.matches.length, 1);

  const failed = runFail(["create", file, "--source", source, "--write"]);
  assert.equal(failed.status, 1);
  assert.match(failed.body.error, /Refusing to overwrite/);

  const fromFile = join(dir, "FromFile.tsx");
  const template = join(dir, "template.tsx");
  writeFileSync(template, "export function FromFile() { return <section />; }\n");
  run(["create", fromFile, "--from-file", template, "--write"]);
  assert.equal(JSON.parse(run(["find", fromFile, "section", "--json"])).matches.length, 1);

  const fromStdin = join(dir, "FromStdin.tsx");
  runWithInput(["create", fromStdin, "--from-stdin", "--write"], "export function FromStdin() { return <article />; }\n");
  assert.equal(JSON.parse(run(["find", fromStdin, "article", "--json"])).matches.length, 1);
});

test("scaffold creates a structured React component from flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Button.tsx");

  run([
    "scaffold", file,
    "--directives", "use client",
    "--imports", "@/lib/utils:cn",
    "--imports", "react:type ReactNode",
    "--export", "function:Button(props: { children: ReactNode })",
    "--body", 'button.className={cn("btn")}.children="Click"',
    "--write"
  ]);
  const source = readFileSync(file, "utf8");
  const button = JSON.parse(run(["find", file, "button", "--json"]));

  assert.match(source, /"use client";/);
  assert.match(source, /import \{ cn \} from "@\/lib\/utils";/);
  assert.match(source, /import type \{ ReactNode \} from "react";/);
  assert.match(source, /export function Button\(props: \{ children: ReactNode \}\)/);
  assert.match(source, /className=\{cn\("btn"\)\}/);
  assert.equal(button.matches.length, 1);
});

test("new creates files from built-in and local templates", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const builtIn = join(dir, "Card.tsx");
  run(["new", "react-client-component", builtIn, "--param", "name=Card", "--write"]);
  const cardSource = readFileSync(builtIn, "utf8");
  assert.match(cardSource, /"use client";/);
  assert.match(cardSource, /export type CardProps =/);
  assert.match(cardSource, /function Card\(props: CardProps\)/);
  assert.equal(JSON.parse(run(["find", builtIn, "div", "--json"])).matches.length, 1);

  const templateDir = join(dir, ".tedit", "templates");
  const templatePath = join(templateDir, "named.tedit-template.json");
  mkdirp(templateDir);
  writeFileSync(templatePath, JSON.stringify({
    exports: [
      { kind: "function", name: "{{name}}", body: { tag: "section", attributes: { "data-name": "{{name}}" } } }
    ]
  }));

  const templates = JSON.parse(runInCwd(["templates", "--json"], dir));
  assert.equal(templates.kind, "templates");
  assert.ok(templates.templates.some((template) => template.name === "react-client-component" && template.source === "builtin"));
  assert.ok(templates.templates.some((template) => template.name === "named" && template.source === "local"));

  const local = join(dir, "Local.tsx");
  runInCwd(["new", "named", local, "--param", "name=LocalThing", "--write"], dir);
  const localSource = readFileSync(local, "utf8");
  assert.match(localSource, /function LocalThing/);
  assert.match(localSource, /data-name="LocalThing"/);

  const action = join(dir, "save.ts");
  run(["new", "server-action", action, "--param", "name=saveDraft", "--write"]);
  const actionSource = readFileSync(action, "utf8");
  assert.match(actionSource, /"use server";/);
  assert.match(actionSource, /export async function saveDraft\(\)/);
});

test("--dry-run is explicit and conflicts with --write", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, fixture());

  run(["append", file, "main", "--element", '{"tag":"PageHead"}', "--dry-run"]);
  assert.doesNotMatch(readFileSync(file, "utf8"), /PageHead/);

  const failed = runFail(["append", file, "main", "--element", '{"tag":"PageHead"}', "--dry-run", "--write"]);
  assert.equal(failed.status, 1);
  assert.match(failed.body.error, /--write or --dry-run/);
});

test("rules command exposes registered rules", () => {
  const result = JSON.parse(run(["rules", "--json"]));
  assert.equal(result.success, true);
  assert.equal(result.rules[0].name, "jsx");
  assert.deepEqual(result.rules[0].extensions, [".js", ".jsx", ".ts", ".tsx"]);
  assert.equal(result.rules[1].name, "json");
  assert.deepEqual(result.rules[1].extensions, [".json", ".jsonl", ".ndjson"]);
  assert.equal(result.rules[2].name, "yaml");
  assert.deepEqual(result.rules[2].extensions, [".yaml", ".yml"]);
  assert.equal(result.rules[3].name, "markdown");
  assert.deepEqual(result.rules[3].extensions, [".md", ".markdown", ".mdx"]);
  assert.equal(result.rules[4].name, "markup");
  assert.deepEqual(result.rules[4].extensions, [".html", ".htm", ".xml", ".svg"]);
});

test("json rule can inspect and edit object properties and scalar values", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({
    name: "demo",
    scripts: { build: "vite build" },
    flags: ["old", "keep"],
    unused: true
  }, null, 2) + "\n");

  const found = JSON.parse(run(["find", file, "scripts", "--json"]));
  assert.equal(found.matches[0].attributes.path, "$.scripts");

  run(["prop", "set", file, "scripts", "dev", "vite", "--write"]);
  run(["text", "set", file, "name", "--value", "demo-next", "--write"]);
  run(["remove", file, '[path="$.flags[0]"]', "--write"]);
  run(["prop", "remove", file, "root", "unused", "--write"]);
  const updated = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(updated.name, "demo-next");
  assert.equal(updated.scripts.dev, "vite");
  assert.deepEqual(updated.flags, ["keep"]);
  assert.equal("unused" in updated, false);
});

test("jsonl rule edits line records as root array items", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "events.jsonl");
  writeFileSync(file, "{\"id\":1,\"ok\":false}\n{\"id\":2,\"ok\":false}\n");
  run(["prop", "set", file, '[path="$[0]"]', "ok", "true", "--write"]);

  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].ok, true);
  assert.equal(lines[1].ok, false);
});

test("yaml rule edits mapping keys and sequence items", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "config.yaml");
  writeFileSync(file, "name: demo\nserver:\n  host: localhost\n  port: 3000\nfeatures:\n  - old\n  - keep\n");

  const found = JSON.parse(run(["find", file, "server", "--json"]));
  assert.equal(found.matches[0].attributes.path, "$.server");

  run(["prop", "set", file, "server", "mode", "dev", "--write"]);
  run(["text", "set", file, '[path="$.server.port"]', "--value", "4000", "--write"]);
  run(["remove", file, '[path="$.features[0]"]', "--write"]);
  run(["prop", "remove", file, "server", "host", "--write"]);

  const updated = readFileSync(file, "utf8");
  assert.match(updated, /server:\n  port: 4000\n  mode: dev/);
  assert.match(updated, /features:\n  - keep/);
  assert.doesNotMatch(updated, /host:/);
  assert.doesNotMatch(updated, /old/);
});

test("yaml rule rejects property edits on scalar nodes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "config.yaml");
  const original = "name: demo\n";
  writeFileSync(file, original);

  const failed = runFail(["prop", "set", file, '[path="$.name"]', "nested", "value", "--write"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "YAML_NOT_MAPPING");
  assert.equal(readFileSync(file, "utf8"), original);
});

test("markdown rule edits frontmatter sections and code blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "README.md");
  writeFileSync(file, "---\ntitle: Demo\n---\n# Intro\nOld paragraph\n\n## Usage\n\n```ts\nconst oldValue = 1;\n```\n\n### Remove Me\ngone\n");

  const frontmatter = JSON.parse(run(["find", file, "frontmatter", "--json"]));
  assert.equal(frontmatter.matches[0].attributes.path, "$/frontmatter");

  run(["prop", "set", file, "frontmatter", "draft", "false", "--write"]);
  run(["prop", "remove", file, "frontmatter", "title", "--write"]);
  run(["rename", file, "heading[level=2]", "--to", "Guide", "--write"]);
  run(["text", "set", file, "code[lang=ts]", "--value", "const newValue = 2;", "--write"]);
  run(["append", file, "heading[level=2]", "--element", '{"text":"Extra note."}', "--write"]);
  run(["remove", file, "heading[level=3]", "--write"]);

  const updated = readFileSync(file, "utf8");
  assert.match(updated, /---\ndraft: false\n---/);
  assert.match(updated, /## Guide/);
  assert.match(updated, /```ts\nconst newValue = 2;\n```/);
  assert.match(updated, /Extra note\./);
  assert.doesNotMatch(updated, /title: Demo/);
  assert.doesNotMatch(updated, /Remove Me|gone/);
});

test("markdown rule treats an unclosed leading thematic break as content", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "README.md");
  const frontmatterish = join(dir, "frontmatterish.md");
  writeFileSync(file, "---\ncontent\n");
  writeFileSync(frontmatterish, "---\ntitle: Demo\nbody\n");

  const verify = JSON.parse(run(["verify-file", file, "--json"]));
  assert.equal(verify.parse_verified, true);
  assert.equal(verify.parser, "markdown-lite");

  const found = JSON.parse(run(["find", file, "paragraph", "--json"]));
  assert.equal(found.matches[0].attributes.text, "---\ncontent");

  const failed = runFail(["verify-file", frontmatterish, "--json"]);
  assert.equal(failed.body.code, "PARSE_BROKEN_AFTER_EDIT");
});

test("markup rule edits html and xml structures", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const html = join(dir, "index.html");
  const xml = join(dir, "feed.xml");
  writeFileSync(html, '<html><body><main class="old"><p>Hello</p><br /></main></body></html>');
  writeFileSync(xml, '<root><item id="a">One</item></root>');

  const found = JSON.parse(run(["find", html, "main.old", "--json"]));
  assert.equal(found.matches[0].name, "main");
  const foundByClassAttr = JSON.parse(run(["find", html, "[class=old]", "--json"]));
  assert.equal(foundByClassAttr.matches[0].name, "main");

  run(["class", "add", html, "main", "panel", "--write"]);
  run(["class", "replace", html, "main", "old", "content", "--write"]);
  run(["prop", "set", html, "p", "data-id", "greeting", "--write"]);
  run(["text", "replace", html, "p", "--match-text", "Hello", "--with-text", "Hi", "--write"]);
  run(["append", html, "main", "--element", '{"tag":"span","attrs":{"class":"badge"},"text":"New"}', "--write"]);
  run(["rename", html, "span", "--to", "strong", "--write"]);
  run(["insertComment", html, "main", "done", "--position", "inside-end", "--write"]);
  run(["remove", html, "br", "--write"]);
  run(["prop", "set", xml, "item[id=a]", "id", "b", "--write"]);
  run(["rename", xml, "item", "--to", "entry", "--write"]);

  const updatedHtml = readFileSync(html, "utf8");
  assert.match(updatedHtml, /<main class="content panel">/);
  assert.match(updatedHtml, /<p data-id="greeting">Hi<\/p>/);
  assert.match(updatedHtml, /<strong class="badge">New<\/strong><!-- done -->/);
  assert.doesNotMatch(updatedHtml, /<br/);
  assert.equal(readFileSync(xml, "utf8"), '<root><entry id="b">One</entry></root>');
});

test("markup rule preserves greater-than signs inside quoted attributes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "quoted.xml");
  writeFileSync(file, '<root><item data="a>b">One</item></root>');

  const found = JSON.parse(run(["find", file, 'item[data="a>b"]', "--json"]));
  assert.equal(found.matches[0].attributes.data, "a>b");

  run(["prop", "set", file, 'item[data="a>b"]', "id", "x", "--write"]);

  assert.equal(readFileSync(file, "utf8"), '<root><item data="a>b" id="x">One</item></root>');
});

test("markup rule ignores raw text comments and CDATA while editing real elements", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const html = join(dir, "raw.html");
  const xml = join(dir, "raw.xml");
  writeFileSync(html, '<main><script>if (a < b && c > d) { console.log("<p>raw</p>"); }</script><style>.x > .y { color: red; }</style><!-- <p>comment</p> --><p>Hello</p></main>');
  writeFileSync(xml, '<root><![CDATA[<item id="raw">raw</item>]]><!-- <item id="comment" /> --><item id="real">One</item></root>');

  const htmlParagraphs = JSON.parse(run(["find", html, "p", "--json"]));
  assert.equal(htmlParagraphs.matches.length, 1);
  assert.equal(htmlParagraphs.matches[0].preview, "<p>Hello</p>");
  run(["text", "replace", html, "p", "--match-text", "Hello", "--with-text", "Hi", "--write"]);
  assert.equal(readFileSync(html, "utf8"), '<main><script>if (a < b && c > d) { console.log("<p>raw</p>"); }</script><style>.x > .y { color: red; }</style><!-- <p>comment</p> --><p>Hi</p></main>');

  const xmlItems = JSON.parse(run(["find", xml, "item", "--json"]));
  assert.equal(xmlItems.matches.length, 1);
  assert.equal(xmlItems.matches[0].attributes.id, "real");
  run(["prop", "set", xml, "item", "status", "ok", "--write"]);
  assert.equal(readFileSync(xml, "utf8"), '<root><![CDATA[<item id="raw">raw</item>]]><!-- <item id="comment" /> --><item id="real" status="ok">One</item></root>');
});

test("rename does not reprint unrelated conditional JSX attribute consequents", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const flow = join(dir, "flow.json");
  writeFileSync(file, conditionalConsequentFixture());
  writeFileSync(flow, JSON.stringify({
    info: { name: "swap-scrollarea-to-div" },
    flow: [
      { action: "find", selector: "ScrollArea", out: "sa" },
      { action: "rename", target: "{{sa}}", name: "div" }
    ]
  }, null, 2));

  run(["flow", file, flow, "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<div className="x" viewportClassName="gap-4">/);
  assert.match(updated, /<\/div>/);
  assert.match(updated, /showHeader \? \(\n          \/\/ keep this comment\n          <PageHead title="hello" \/>\n        \) : undefined/);
  assert.doesNotMatch(updated, /\(<PageHead title="hello" \/>\)/);
});

test("prop.remove does not reprint unrelated conditional JSX attribute consequents", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, conditionalConsequentFixture());

  run(["prop", "remove", file, "ScrollArea", "viewportClassName", "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.doesNotMatch(updated, /viewportClassName=/);
  assertUnchangedConditionalConsequent(updated);
});

test("prop.set does not reprint unrelated conditional JSX attribute consequents", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, conditionalConsequentFixture());

  run(["prop", "set", file, "ScrollArea", "data-testid", "scroll-area", "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /data-testid="scroll-area"/);
  assertUnchangedConditionalConsequent(updated);
});

test("wrap does not reprint unrelated conditional JSX attribute consequents", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, conditionalConsequentFixture());

  run(["wrap", file, "Body", "--with", "div", "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<div><Body \/><\/div>/);
  assertUnchangedConditionalConsequent(updated);
});

test("append does not reprint unrelated conditional JSX attribute consequents", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, conditionalConsequentFixture());

  run(["append", file, "Body", "--element", '{"tag":"Footer"}', "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<Body><Footer \/><\/Body>/);
  assertUnchangedConditionalConsequent(updated);
});

test("prepend does not reprint unrelated conditional JSX attribute consequents", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, conditionalConsequentFixture());

  run(["prepend", file, "ScrollArea", "--element", '{"tag":"Header"}', "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<Header \/>/);
  assertUnchangedConditionalConsequent(updated);
});

test("unwrap does not reprint unrelated conditional JSX attribute consequents", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, conditionalConsequentFixture());

  run(["unwrap", file, "ScrollArea", "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.doesNotMatch(updated, /ScrollArea/);
  assert.match(updated, /<Body \/>/);
  assertUnchangedConditionalConsequent(updated);
});

test("remove does not reprint unrelated conditional JSX attribute consequents", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, conditionalConsequentFixture());

  run(["remove", file, "Body", "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.doesNotMatch(updated, /<Body/);
  assert.match(updated, /<ScrollArea className="x" viewportClassName="gap-4">/);
  assertUnchangedConditionalConsequent(updated);
});

test("insertComment does not reprint unrelated conditional JSX attribute consequents", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, conditionalConsequentFixture());

  run(["insertComment", file, "ScrollArea", "Generated marker", "--position", "inside-start", "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /\{\/\* Generated marker \*\/\}/);
  assertUnchangedConditionalConsequent(updated);
});

test("mixed rename prop and wrap flow stays surgical for unrelated conditional JSX", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const flow = join(dir, "flow.json");
  writeFileSync(file, conditionalConsequentFixture());
  writeFileSync(flow, JSON.stringify({
    info: { name: "mixed-scrollarea-refactor" },
    flow: [
      { action: "find", selector: "ScrollArea", out: "sa" },
      { action: "rename", target: "{{sa}}", name: "div" },
      { action: "prop.remove", target: "{{sa}}", name: "viewportClassName" },
      { action: "prop.set", target: "{{sa}}", name: "data-testid", value: "scroll-area" },
      { action: "find", selector: "Body", out: "body" },
      { action: "wrap", target: "{{body}}", with: "div" }
    ]
  }, null, 2));

  run(["flow", file, flow, "--write"]);
  const updated = readFileSync(file, "utf8");

  assert.match(updated, /<div className="x" data-testid="scroll-area">/);
  assert.doesNotMatch(updated, /viewportClassName=/);
  assert.match(updated, /<div><Body \/><\/div>/);
  assertUnchangedConditionalConsequent(updated);
});

test("extract creates a component file and replaces the call site", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, extractFixture());

  const result = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--write"]));
  const updated = readFileSync(file, "utf8");
  const created = readFileSync(out, "utf8");

  assert.equal(result.success, true);
  assert.deepEqual(result.props.map((prop) => prop.name), ["pageTitle", "description", "handleEdit"]);
  assert.deepEqual(result.imports.removed_from_source.map((item) => item.from), ["@/ui/card", "@/ui/button"]);
  assert.match(updated, /import \{ PageCard \} from "\.\/components\/PageCard";/);
  assert.doesNotMatch(updated, /@\/ui\/card/);
  assert.doesNotMatch(updated, /@\/ui\/button/);
  assert.match(updated, /<PageCard pageTitle=\{pageTitle\} description=\{description\} handleEdit=\{handleEdit\} \/>/);
  assert.match(created, /import \{ Card, CardHeader, CardBody \} from "@\/ui\/card";/);
  assert.match(created, /import \{ Button \} from "@\/ui\/button";/);
  assert.match(created, /type PageCardProps = \{\n  pageTitle: unknown; \/\/ TODO\(tedit\): infer type\n  description: unknown; \/\/ TODO\(tedit\): infer type\n  handleEdit: unknown; \/\/ TODO\(tedit\): infer type\n\};/);
  assert.match(created, /handleEdit: unknown;/);
  assert.match(created, /export function PageCard\(\{ pageTitle, description, handleEdit \}: PageCardProps\)/);
  assert.equal(result.inference_mode, "annotation-only");
  assert.doesNotMatch(created, /return \(\n\s+\(/);
  assert.match(created, /<CardHeader title=\{pageTitle\} \/>/);
  assert.match(created, /<p>\{description\}<\/p>/);
});

test("extract infers prop types from TypeScript annotations", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, typedExtractFixture());

  const result = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--write"]));
  const updated = readFileSync(file, "utf8");
  const created = readFileSync(out, "utf8");

  assert.deepEqual(result.props.map((prop) => [prop.name, prop.type, prop.optional ?? false]), [
    ["pageTitle", "string", false],
    ["description", "string", true],
    ["handleEdit", "(status: \"draft\" | \"done\") => void", false],
    ["status", "\"draft\" | \"done\"", false]
  ]);
  assert.match(updated, /<PageCard pageTitle=\{pageTitle\} description=\{description\} handleEdit=\{handleEdit\} status=\{status\} \/>/);
  assert.match(created, /type PageCardProps = \{\n  pageTitle: string;\n  description\?: string;\n  handleEdit: \(status: "draft" \| "done"\) => void;\n  status: "draft" \| "done";\n\};/);
  assert.doesNotMatch(created, /TODO\(tedit\): infer type/);
});

test("extract infers simple AST expression prop types", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, expressionInferenceExtractFixture());

  const result = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--write"]));
  const created = readFileSync(out, "utf8");

  assert.deepEqual(result.props.map((prop) => [prop.name, prop.type]), [
    ["label", "string"],
    ["count", "number"],
    ["enabled", "boolean"],
    ["staticMessage", "string"],
    ["tags", "string[]"],
    ["meta", "{ id: number; active: boolean }"]
  ]);
  assert.doesNotMatch(created, /TODO\(tedit\): infer type/);
});

test("extract infers useState generic state and setter props", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, useStateInferenceExtractFixture());

  const result = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--write"]));
  const created = readFileSync(out, "utf8");

  assert.deepEqual(result.props.map((prop) => [prop.name, prop.type]), [
    ["setSelectedId", "(value: string | null | ((previous: string | null) => string | null)) => void"],
    ["selectedId", "string | null"]
  ]);
  assert.match(created, /selectedId: string \| null;/);
  assert.doesNotMatch(created, /TODO\(tedit\): infer type/);
});

test("extract uses TypeScript checker inference when AST annotations are not explicit", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, checkerExtractFixture());

  const result = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--typecheck", "--write"]));
  const created = readFileSync(out, "utf8");

  assert.equal(result.inference_mode, "with-checker");
  assert.deepEqual(result.props.map((prop) => [prop.name, prop.type]), [
    ["pageTitle", "string"],
    ["inferredCount", "number"],
    ["isLong", "boolean"]
  ]);
  assert.match(created, /inferredCount: number;/);
  assert.match(created, /isLong: boolean;/);
  assert.doesNotMatch(created, /TODO\(tedit\): infer type/);
});

test("extract slot mode leaves slot content at the call site", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, extractFixture());

  const result = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--slot", "CardBody.children", "--write"]));
  const updated = readFileSync(file, "utf8");
  const created = readFileSync(out, "utf8");

  assert.equal(result.success, true);
  assert.deepEqual(result.props.map((prop) => prop.name), ["pageTitle", "children"]);
  assert.doesNotMatch(JSON.stringify(result.props), /description/);
  assert.deepEqual(result.imports.removed_from_source, [{ from: "@/ui/card", named: ["Card", "CardHeader", "CardBody"] }]);
  assert.match(updated, /<PageCard pageTitle=\{pageTitle\}>/);
  assert.doesNotMatch(updated, /@\/ui\/card/);
  assert.match(updated, /import \{ Button \} from "@\/ui\/button";/);
  assert.match(updated, /<p>\{description\}<\/p>/);
  assert.match(updated, /<Button onClick=\{handleEdit\}>Edit<\/Button>/);
  assert.match(created, /import type \{ ReactNode \} from "react";/);
  assert.match(created, /children: ReactNode;/);
  assert.match(created, /<CardBody>\{children\}<\/CardBody>/);
  assert.doesNotMatch(created, /description/);
  assert.doesNotMatch(created, /handleEdit/);
});

test("extract supports named slots", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, namedSlotExtractFixture());

  const result = JSON.parse(run([
    "extract", file, "Card",
    "--to", out,
    "--name", "PageCard",
    "--slot", "CardHeader.children=header",
    "--slot", "CardBody.children",
    "--write"
  ]));
  const updated = readFileSync(file, "utf8");
  const created = readFileSync(out, "utf8");

  assert.deepEqual(result.props.map((prop) => prop.name), ["header", "children"]);
  assert.deepEqual(result.imports.removed_from_source, [{ from: "@/ui/card", named: ["Card", "CardHeader", "CardBody"] }]);
  assert.match(updated, /header=\{<>/);
  assert.match(updated, /<Title icon=\{icon\} \/>/);
  assert.match(updated, /<PageCard header=\{<>/);
  assert.match(created, /<CardHeader>\{header\}<\/CardHeader>/);
  assert.match(created, /<CardBody>\{children\}<\/CardBody>/);
  assert.doesNotMatch(created, /icon/);
});

test("extract rejects depth without explicit slot and suggests candidates", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, extractFixture());

  const failed = runFail(["extract", file, "Card", "--to", out, "--name", "PageCard", "--depth", "1"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "EXTRACT_SLOT_REQUIRED");
  assert.match(failed.body.error, /Cannot determine slot boundary/);
  assert.deepEqual(failed.body.details.suggestedSlots, [
    "CardHeader.children=header",
    "CardBody.children=children"
  ]);
});

test("extract moves shell-only helper dependency closure", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, helperDependencyExtractFixture());

  const result = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--write"]));
  const updated = readFileSync(file, "utf8");
  const created = readFileSync(out, "utf8");

  assert.deepEqual(result.helpers.map((helper) => [helper.name, helper.class, helper.action]), [
    ["formatTitle", "shell-only", "moved"],
    ["normalizeTitle", "shell-only", "moved"]
  ]);
  assert.deepEqual(result.props.map((prop) => prop.name), ["pageTitle"]);
  assert.doesNotMatch(updated, /function formatTitle/);
  assert.doesNotMatch(updated, /function normalizeTitle/);
  assert.doesNotMatch(updated, /@\/text/);
  assert.match(created, /import \{ titleCase \} from "@\/text";/);
  assert.match(created, /function normalizeTitle/);
  assert.match(created, /function formatTitle/);
  assert.match(created, /titleCase\(normalizeTitle\(value\)\)/);
});

test("extract detects shared helper cycles", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, helperExtractFixture());

  const failed = runFail(["extract", file, "Card", "--to", out, "--name", "PageCard"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "SHARED_HELPER_CYCLE");
  assert.match(failed.body.error, /sharedLabel/);
  assert.deepEqual(failed.body.details.helpers, [
    { name: "sharedLabel", class: "shared", sourceRefsRemaining: 1 }
  ]);
  assert.deepEqual(failed.body.details.workarounds, [
    "--helpers as-prop",
    "pass individual --helper name=as-prop / name=leave",
    "move shared helpers to a separate shared module first"
  ]);
});

test("extract reports all shared helper cycles in one diagnostic", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, multiSharedHelperExtractFixture());

  const failed = runFail(["extract", file, "Card", "--to", out, "--name", "PageCard"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "SHARED_HELPER_CYCLE");
  assert.match(failed.body.error, /formatTitle, formatStatus/);
  assert.deepEqual(failed.body.details.helpers, [
    { name: "formatTitle", class: "shared", sourceRefsRemaining: 1 },
    { name: "formatStatus", class: "shared", sourceRefsRemaining: 1 }
  ]);
});

test("extract can pass a shared helper as a prop by explicit override", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, helperExtractFixture());

  const result = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--helper", "sharedLabel=as-prop", "--write"]));
  const updated = readFileSync(file, "utf8");
  const created = readFileSync(out, "utf8");

  assert.deepEqual(result.helpers.map((helper) => [helper.name, helper.action]), [
    ["formatTitle", "moved"],
    ["sharedLabel", "passed-as-prop"]
  ]);
  assert.match(updated, /<PageCard sharedLabel=\{sharedLabel\} pageTitle=\{pageTitle\} \/>|<PageCard pageTitle=\{pageTitle\} sharedLabel=\{sharedLabel\} \/>/);
  assert.match(created, /sharedLabel: unknown; \/\/ TODO\(tedit\): infer type/);
  assert.match(created, /function formatTitle/);
});

test("extract refuses to move shared helpers under move policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, helperExtractFixture());

  const failed = runFail(["extract", file, "Card", "--to", out, "--name", "PageCard", "--helpers", "move"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "SHARED_HELPER_MOVE_REFUSED");
  assert.match(failed.body.error, /sharedLabel/);
});

test("extract auto-slot uses depth suggestions when explicitly requested", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, namedSlotExtractFixture());

  const result = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--depth", "1", "--auto-slot", "--write"]));
  const updated = readFileSync(file, "utf8");
  const created = readFileSync(out, "utf8");

  assert.deepEqual(result.slots, [
    { selector: "CardHeader", prop: "header" },
    { selector: "CardBody", prop: "children" }
  ]);
  assert.match(updated, /<PageCard header=\{<>/);
  assert.match(created, /<CardHeader>\{header\}<\/CardHeader>/);
  assert.match(created, /<CardBody>\{children\}<\/CardBody>/);
});

test("extract dry-run returns JSON and does not write files", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, extractFixture());

  const result = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard"]));

  assert.equal(result.success, true);
  assert.equal(result.written, false);
  assert.match(result.diffs.source, /PageCard/);
  assert.throws(() => readFileSync(out, "utf8"));
  assert.doesNotMatch(readFileSync(file, "utf8"), /PageCard/);
});

test("extract plan-out writes a validated plan and apply-plan applies it", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  const planPath = join(dir, ".tedit", "plans", "extract-card.json");
  writeFileSync(file, extractFixture());

  const planResult = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--plan-out", planPath]));

  assert.equal(planResult.success, true);
  assert.equal(planResult.kind, "extract-component-plan");
  assert.equal(planResult.source, file);
  assert.equal(planResult.target, out);
  assert.deepEqual(planResult.steps.map((step) => step.id), ["create-component-file", "replace-callsite"]);
  assert.throws(() => readFileSync(out, "utf8"));
  assert.doesNotMatch(readFileSync(file, "utf8"), /PageCard/);

  const inspect = JSON.parse(run(["plan", "inspect", planPath, "--json"]));
  assert.equal(inspect.success, true);
  assert.equal(inspect.component, "PageCard");
  assert.equal(inspect.stale, false);
  assert.equal(inspect.steps_total, 2);
  assert.equal(inspect.risks.medium, 1);
  assert.match(run(["plan", "inspect", planPath]), /extract-component-plan: 2 steps, 0 high risk, ready/);

  const dryRun = JSON.parse(run(["apply-plan", planPath, "--dry-run", "--diff-out", join(dir, "extract.diff")]));
  assert.equal(dryRun.success, true);
  assert.equal(dryRun.written, false);
  assert.match(dryRun.files.find((entry) => entry.step === "replace-callsite").diff, /PageCard/);
  assert.throws(() => readFileSync(out, "utf8"));

  const applied = JSON.parse(run(["apply-plan", planPath, "--write"]));
  assert.equal(applied.written, true);
  assert.match(readFileSync(file, "utf8"), /<PageCard pageTitle=\{pageTitle\} description=\{description\} handleEdit=\{handleEdit\} \/>/);
  assert.match(readFileSync(out, "utf8"), /export function PageCard/);
});

test("apply-plan rejects stale source hashes before writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  const planPath = join(dir, "extract-card.json");
  writeFileSync(file, extractFixture());
  run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--plan-out", planPath]);
  writeFileSync(file, extractFixture().replace("pageTitle", "heading"));

  const failed = runFail(["apply-plan", planPath, "--write"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "PLAN_STALE_SOURCE");
  assert.throws(() => readFileSync(out, "utf8"));
});

test("apply-plan can skip helper move steps by passing helpers as props", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  const planPath = join(dir, "extract-card.json");
  writeFileSync(file, helperDependencyExtractFixture());
  const planResult = JSON.parse(run(["extract", file, "Card", "--to", out, "--name", "PageCard", "--plan-out", planPath]));

  assert.ok(planResult.steps.some((step) => step.id === "move-helper-formatTitle"));

  const applied = JSON.parse(run(["apply-plan", planPath, "--skip", "move-helper-formatTitle", "--write"]));
  const helperStep = applied.steps.find((step) => step.id === "move-helper-formatTitle");

  assert.equal(helperStep.status, "skipped");
  assert.match(readFileSync(file, "utf8"), /function formatTitle/);
  assert.match(readFileSync(file, "utf8"), /formatTitle=\{formatTitle\}/);
  assert.doesNotMatch(readFileSync(out, "utf8"), /function formatTitle/);
  assert.match(readFileSync(out, "utf8"), /formatTitle: unknown; \/\/ TODO\(tedit\): infer type/);
});

test("workspace-flow extracts and mutates the created file in one transaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  const flow = join(dir, "workspace-flow.json");
  writeFileSync(file, extractFixture());
  writeFileSync(flow, JSON.stringify({
    flow: [
      {
        action: "extract",
        from: file,
        selector: "Card",
        to: out,
        name: "PageCard",
        out: "extracted"
      },
      {
        action: "chain",
        file: out,
        steps: [
          { action: "find", selector: "Card", out: "card" },
          { action: "prop.set", target: "{{card}}", name: "data-extracted", value: true }
        ]
      }
    ]
  }, null, 2));

  const result = JSON.parse(run(["workspace-flow", flow, "--write"]));
  const updated = readFileSync(file, "utf8");
  const created = readFileSync(out, "utf8");

  assert.equal(result.success, true);
  assert.deepEqual(result.files.map((item) => [item.file, item.changed, item.written]), [
    [file, true, true],
    [out, true, true]
  ]);
  assert.match(updated, /import \{ PageCard \} from "\.\/components\/PageCard";/);
  assert.match(created, /<Card className="p-4 rounded-xl border" data-extracted>/);
});

test("workspace-flow does not write any file when a later step fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  const flow = join(dir, "workspace-flow.json");
  const original = extractFixture();
  writeFileSync(file, original);
  writeFileSync(flow, JSON.stringify({
    flow: [
      { action: "extract", from: file, selector: "Card", to: out, name: "PageCard" },
      { action: "chain", file: out, steps: [{ action: "find", selector: "Missing" }] }
    ]
  }, null, 2));

  const failed = runFail(["workspace-flow", flow, "--write"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "NODE_NOT_FOUND");
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(existsSync(out), false);
});

test("chain-workspace runs extract and file-scoped chain steps", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, extractFixture());

  const result = JSON.parse(run([
    "chain-workspace",
    "extract", file, "Card", "--to", out, "--name", "PageCard",
    "::", "in", out, "find", "Card", "as", "card",
    "::", "in", out, "prop.set", "@card", "data-chain", "true",
    "--write"
  ]));
  const created = readFileSync(out, "utf8");

  assert.equal(result.success, true);
  assert.match(created, /<Card className="p-4 rounded-xl border" data-chain>/);
});

test("chain-workspace can load line-based input from a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  const chainFile = join(dir, "workspace.chain");
  writeFileSync(file, extractFixture());
  writeFileSync(chainFile, `# workspace chain
extract ${file} Card --to ${out} --name PageCard
in ${out} find Card as card
in ${out} prop.set @card data-file true
`);

  const result = JSON.parse(run(["chain-workspace", "--from-file", chainFile, "--write"]));
  const created = readFileSync(out, "utf8");

  assert.equal(result.success, true);
  assert.match(created, /<Card className="p-4 rounded-xl border" data-file>/);
});

test("chain-workspace can load line-based input from stdin", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "components", "PageCard.tsx");
  writeFileSync(file, extractFixture());

  const result = JSON.parse(runWithInput(["chain-workspace", "--from-stdin", "--write"], `extract ${file} Card --to ${out} --name PageCard
in ${out} find Card as card
in ${out} prop.set @card data-stdin true
`));
  const created = readFileSync(out, "utf8");

  assert.equal(result.success, true);
  assert.match(created, /<Card className="p-4 rounded-xl border" data-stdin>/);
});

test("npm pack includes CLI and MCP distribution files", () => {
  const root = new URL("..", import.meta.url);
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const [pack] = JSON.parse(output);
  const files = pack.files.map((file) => file.path);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.bin.tedit, "./dist/cli.js");
  assert.equal(pkg.bin["tedit-mcp"], "./dist/mcp.js");
  assert.ok(files.includes("dist/cli.js"));
  assert.ok(files.includes("dist/mcp.js"));
  assert.ok(files.includes("dist/mcp-runner.js"));
  assert.ok(files.includes("dist/mcp-tools.js"));
  assert.ok(files.includes("dist/output.js"));
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("package.json"));
  assert.ok(files.every((file) => !file.endsWith(".bak") && !file.endsWith(".tedit.bak")));
  assert.ok(pack.size < 2_000_000);
  assert.equal(pkg.scripts.postinstall, undefined);
  assert.notEqual(pack.files.find((file) => file.path === "dist/cli.js").mode & 0o111, 0);
  assert.notEqual(pack.files.find((file) => file.path === "dist/mcp.js").mode & 0o111, 0);
});

test("mcp server lists tools and runs universal edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  const jsxFile = join(dir, "Page.tsx");
  const jsonFile = join(dir, "config.json");
  const extractFile = join(dir, "Extract.tsx");
  const extractOut = join(dir, "components", "PageCard.tsx");
  const extractPlan = join(dir, ".tedit", "plans", "extract-card.json");
  const mcpWriteFile = join(dir, "written.json");
  const mcpCreateFile = join(dir, "created.md");
  const mcpScaffoldFile = join(dir, "Scaffolded.tsx");
  const mcpNewFile = join(dir, "ClientCard.tsx");
  const mcpLoopFile = join(dir, "loop.ts");
  const mcpWarnFile = join(dir, "Warn.tsx");
  const mcpAstFile = join(dir, "Ast.tsx");
  const mcpSearchDir = join(dir, "search");
  const mcpSearchFile = join(mcpSearchDir, "Search.tsx");
  writeFileSync(file, "# Title\nold value\n");
  writeFileSync(jsxFile, chainFixture());
  writeFileSync(jsonFile, "{\"enabled\":true}\n");
  writeFileSync(extractFile, extractFixture());
  writeFileSync(mcpLoopFile, "function save(\n  value\n) {\n  return value;\n}\n");
  writeFileSync(mcpWarnFile, "export function Warn() {\n  return <div className=\"w-full w-9\" />;\n}\n");
  writeFileSync(mcpAstFile, "const item = { label: \"삭제\" };\nalert(\"오류\");\nexport function Ast() { return <input placeholder=\"검색\" />; }\n");
  mkdirSync(mcpSearchDir, { recursive: true });
  writeFileSync(mcpSearchFile, "export function Search() {\n  const label = \"삭제\";\n  return <span>{label}</span>;\n}\n");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcp],
    stderr: "pipe",
  });
  const client = new Client({ name: "tedit-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.deepEqual(toolNames.sort(), [
      "actions",
      "edit",
      "file_write",
      "inspect_range",
      "multiedit",
      "patch",
      "search_text",
      "verify_file",
    ].sort());
    assert.ok(tools.tools.some((tool) => tool.name === "edit"));
    assert.ok(tools.tools.some((tool) => tool.name === "file_write"));
    assert.ok(tools.tools.some((tool) => tool.name === "verify_file"));
    assert.ok(tools.tools.some((tool) => tool.name === "inspect_range"));
    assert.ok(tools.tools.some((tool) => tool.name === "search_text"));
    assert.equal(toolNames.includes("chain_workspace"), false);
    assert.equal(toolNames.includes("apply_plan"), false);
    assert.equal(toolNames.includes("create_file"), false);
    assert.equal(toolNames.includes("templates"), false);
    assert.equal(toolNames.includes("history_trace"), false);
    assert.equal(toolNames.includes("scan_strings"), false);
    assert.equal(toolNames.includes("ast_select"), false);
    assert.equal(toolNames.includes("ast_edit"), false);
    assert.equal(toolNames.includes("jsx_node"), false);
    assert.equal(toolNames.includes("write_file"), false);
    assert.equal(toolNames.includes("scaffold_file"), false);
    assert.equal(toolNames.includes("new_file"), false);
    assert.equal(toolNames.includes("refactor_state_plan"), false);
    assert.equal(toolNames.includes("extract_plan"), false);
    assert.equal(toolNames.includes("wrap"), false);
    assert.equal(toolNames.includes("prop_set"), false);
    const listedEdit = tools.tools.find((tool) => tool.name === "edit");
    const listedActions = tools.tools.find((tool) => tool.name === "actions");
    assert.match(listedEdit.description, /Safer replacement for routine Edit/);
    assert.ok(listedActions.description.includes("choosing between native read/edit/write/patch and tedit"));

    const actionsDiscovery = await client.callTool({
      name: "actions",
      arguments: {},
    });
    assert.equal(actionsDiscovery.isError, undefined);
    assert.ok(actionsDiscovery.structuredContent.actions.includes("multiedit"));
    assert.ok(actionsDiscovery.structuredContent.actions.includes("patch"));
    assert.ok(actionsDiscovery.structuredContent.actions.includes("file_write"));
    assert.ok(actionsDiscovery.structuredContent.actions.includes("inspect_range"));
    assert.ok(actionsDiscovery.structuredContent.actions.includes("search_text"));
    assert.ok(actionsDiscovery.structuredContent.actions.includes("verify_file"));
    assert.equal(actionsDiscovery.structuredContent.actions.includes("create_file"), false);
    assert.equal(actionsDiscovery.structuredContent.actions.includes("templates"), false);
    assert.equal(actionsDiscovery.structuredContent.actions.includes("history_trace"), false);
    assert.equal(actionsDiscovery.structuredContent.actions.includes("scan_strings"), false);
    assert.equal(actionsDiscovery.structuredContent.actions.includes("ast_select"), false);
    assert.equal(actionsDiscovery.structuredContent.actions.includes("ast_edit"), false);
    assert.equal(actionsDiscovery.structuredContent.actions.includes("refactor_state_plan"), false);
    assert.equal(actionsDiscovery.structuredContent.actions.includes("class.add"), false);
    assert.ok(actionsDiscovery.structuredContent.tools.some((tool) => tool.name === "multiedit"));
    const editToolMeta = actionsDiscovery.structuredContent.tools.find((tool) => tool.name === "edit");
    const verifyMeta = actionsDiscovery.structuredContent.tools.find((tool) => tool.name === "verify_file");
    const searchTextMeta = actionsDiscovery.structuredContent.tools.find((tool) => tool.name === "search_text");
    const templatesMeta = actionsDiscovery.structuredContent.advanced_tools.find((tool) => tool.name === "templates");
    const scanStringsMeta = actionsDiscovery.structuredContent.advanced_tools.find((tool) => tool.name === "scan_strings");
    const jsxAttrMeta = actionsDiscovery.structuredContent.advanced_tools.find((tool) => tool.name === "jsx_attr");
    const propSetMeta = actionsDiscovery.structuredContent.advanced_tools.find((tool) => tool.name === "prop_set");
    assert.equal(editToolMeta.category, "edit");
    assert.ok(editToolMeta.best_for.includes("single localized text/code edit"));
    assert.equal(verifyMeta.readOnly, true);
    assert.equal(jsxAttrMeta.exposure, "advanced");
    assert.equal(jsxAttrMeta.registered, false);
    assert.equal(templatesMeta.category, "discover");
    assert.equal(templatesMeta.readOnly, true);
    assert.equal(templatesMeta.registered, false);
    assert.equal(searchTextMeta.category, "discover");
    assert.equal(searchTextMeta.readOnly, true);
    assert.equal(scanStringsMeta.category, "ast");
    assert.equal(scanStringsMeta.readOnly, true);
    assert.equal(scanStringsMeta.registered, false);
    assert.equal(propSetMeta.action, "prop.set");
    assert.ok(propSetMeta.aliases.includes("prop.set"));
    assert.equal(propSetMeta.exposure, "advanced");
    assert.equal(propSetMeta.registered, false);
    assert.equal(actionsDiscovery.structuredContent.profiles.current, "agent");
    assert.deepEqual(actionsDiscovery.structuredContent.profiles.agent.sort(), [
      "actions",
      "edit",
      "file_write",
      "inspect_range",
      "multiedit",
      "patch",
      "search_text",
      "verify_file",
    ].sort());
    assert.equal(actionsDiscovery.structuredContent.profiles.agent.includes("jsx_attr"), false);
    assert.equal(actionsDiscovery.structuredContent.profiles.agent.includes("prop_set"), false);
    assert.ok(actionsDiscovery.structuredContent.profiles.all.includes("prop_set"));
    assert.match(actionsDiscovery.structuredContent.guidance.read_path[0], /native Read/);
    assert.ok(actionsDiscovery.structuredContent.guidance.tool_priorities.some((item) => item.includes("TEDIT_MCP_PROFILE=all")));
    assert.match(actionsDiscovery.structuredContent.guidance.no_read_file_tool, /less useful than native Read/);

    const jsxActionsDiscovery = await client.callTool({
      name: "actions",
      arguments: { file: jsxFile },
    });
    assert.equal(jsxActionsDiscovery.isError, undefined);
    assert.deepEqual(jsxActionsDiscovery.structuredContent.guidance.file_rules, ["jsx"]);
    assert.ok(jsxActionsDiscovery.structuredContent.actions.includes("class.add"));

    const result = await client.callTool({
      name: "edit",
      arguments: { file, find: "old value", replace: "new value", write: true },
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.success, undefined);
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.kind, "mutation");
    assert.equal(result.structuredContent.changedCount, 1);
    assert.equal(result.structuredContent.writtenCount, 1);
    assert.match(result.structuredContent.summary, /1 file written/);
    assert.equal(result.structuredContent.files[0].path, file);
    assert.equal(result.structuredContent.files[0].change, "modified");
    assert.equal(result.structuredContent.files[0].persisted, true);
    assert.equal(result.structuredContent.parse_skipped, true);
    assert.equal(result.structuredContent.parse_skip_reason, "unsupported_extension");
    assert.equal(result.structuredContent.files[0].parse_skipped, true);
    assert.equal(result.structuredContent.files[0].diffAvailable, true);
    assert.equal(result.structuredContent.files[0].diff.mode, "inline");
    assert.match(result.structuredContent.files[0].diff.preview, /new value/);
    assert.equal(result.structuredContent.diff, undefined);
    assert.equal(result.structuredContent.write_policy, undefined);
    assert.equal(result.structuredContent.next, undefined);
    assert.equal(result.structuredContent.files[0].file, undefined);
    assert.equal(result.structuredContent.files[0].changed, undefined);
    assert.equal(result.structuredContent.files[0].written, undefined);
    assert.equal(result.structuredContent.files[0].status, undefined);
    assert.equal(readFileSync(file, "utf8"), "# Title\nnew value\n");

    const multieditResult = await client.callTool({
      name: "multiedit",
      arguments: {
        edits: [
          { file, find: "new value", replace: "multi value" },
          { file: jsonFile, find: "\"enabled\":true", replace: "\"enabled\":false" }
        ],
        dryRun: true,
      },
    });
    assert.equal(multieditResult.isError, undefined);
    assert.equal(multieditResult.structuredContent.success, undefined);
    assert.equal(multieditResult.structuredContent.ok, true);
    assert.equal(multieditResult.structuredContent.kind, "mutation");
    assert.equal(multieditResult.structuredContent.changedCount, 2);
    assert.equal(multieditResult.structuredContent.writtenCount, 0);
    assert.match(multieditResult.structuredContent.summary, /2 files would change/);
    assert.equal(multieditResult.structuredContent.results, undefined);
    assert.equal(multieditResult.structuredContent.diff, undefined);
    assert.equal(multieditResult.structuredContent.write_policy, undefined);
    assert.ok(multieditResult.structuredContent.files.every((item) => item.file === undefined));
    assert.ok(multieditResult.structuredContent.files.every((item) => item.change === "modified"));
    assert.ok(multieditResult.structuredContent.files.every((item) => item.persisted === false));
    assert.ok(multieditResult.structuredContent.files.every((item) => item.changed === undefined));
    assert.ok(multieditResult.structuredContent.files.every((item) => item.written === undefined));
    assert.ok(multieditResult.structuredContent.files.every((item) => item.status === undefined));
    assert.ok(multieditResult.structuredContent.files.every((item) => item.diffAvailable === true));
    assert.ok(multieditResult.structuredContent.files.every((item) => item.diff.mode === "inline"));
    const multieditText = JSON.parse(multieditResult.content[0].text);
    assert.deepEqual(multieditText, multieditResult.structuredContent);
    assert.equal(multieditText.results, undefined);
    assert.equal(multieditText.diff, undefined);
    assert.equal(multieditText.write_policy, undefined);
    assert.ok(multieditText.files.every((item) => item.file === undefined));
    assert.ok(multieditText.files.every((item) => item.change === "modified"));
    assert.ok(multieditText.files.every((item) => item.diff.mode === "inline"));
    assert.equal(readFileSync(file, "utf8"), "# Title\nnew value\n");

    const detailedEdit = await client.callTool({
      name: "edit",
      arguments: { file, find: "new value", replace: "final value", dryRun: true, output: "detailed" },
    });
    assert.equal(detailedEdit.isError, undefined);
    assert.match(detailedEdit.structuredContent.diff, /final value/);
    assert.ok(detailedEdit.structuredContent.write_policy);
    assert.deepEqual(detailedEdit.structuredContent.next, ["rerun with write=true to apply"]);

    const failedEdit = await client.callTool({
      name: "edit",
      arguments: { file, find: "missing value", replace: "ignored" },
    });
    assert.equal(failedEdit.isError, true);
    assert.ok(Array.isArray(failedEdit.structuredContent.suggestions));
    assert.ok(failedEdit.structuredContent.suggestions.length > 0);

    const fuzzyMiss = await client.callTool({
      name: "edit",
      arguments: { file: mcpLoopFile, find: "function save( value )", replace: "function save(value)" },
    });
    assert.equal(fuzzyMiss.isError, true);
    assert.equal(fuzzyMiss.structuredContent.code, "MATCH_FUZZY_ONLY");
    assert.match(fuzzyMiss.structuredContent.suggestions[0], /--find-fuzzy/);

    const fuzzyRetry = await client.callTool({
      name: "edit",
      arguments: { file: mcpLoopFile, findFuzzy: "function save( value )", replace: "function save(value)", write: true },
    });
    assert.equal(fuzzyRetry.isError, undefined);
    assert.equal(fuzzyRetry.structuredContent.writtenCount, 1);
    assert.equal(fuzzyRetry.structuredContent.files[0].change, "modified");
    assert.equal(fuzzyRetry.structuredContent.files[0].persisted, true);
    assert.ok(readFileSync(mcpLoopFile, "utf8").includes("function save(value)"));

    const searchTextResult = await client.callTool({
      name: "search_text",
      arguments: { query: "삭제", paths: [mcpSearchDir], glob: "**/*.tsx", context: 1, multieditSpec: true, replace: "Delete" },
    });
    assert.equal(searchTextResult.isError, undefined);
    assert.equal(searchTextResult.structuredContent.kind, "search-text");
    assert.equal(searchTextResult.structuredContent.context, 1);
    assert.equal(searchTextResult.structuredContent.multiedit.edits.length, 1);
    assert.equal(searchTextResult.structuredContent.multiedit.edits[0].replace, "Delete");
    assert.equal(searchTextResult.structuredContent.results.length, 1);
    assert.equal(searchTextResult.structuredContent.files.length, 1);
    assert.equal(searchTextResult.structuredContent.results[0].fileId, searchTextResult.structuredContent.files[0].id);
    assert.equal(searchTextResult.structuredContent.results[0].lineRange, "2");
    assert.equal(searchTextResult.structuredContent.results[0].context, undefined);
    assert.equal(searchTextResult.structuredContent.results[0].suggested, undefined);
    assert.ok(searchTextResult.structuredContent.suggestions.some((suggestion) => suggestion.includes("inspect_range")));

    const inspectRangeResult = await client.callTool({
      name: "inspect_range",
      arguments: { file: mcpSearchFile, lines: "2:2", context: 1 },
    });
    assert.equal(inspectRangeResult.isError, undefined);
    assert.equal(inspectRangeResult.structuredContent.kind, "inspect-range");
    assert.equal(inspectRangeResult.structuredContent.lines.length, 3);
    assert.equal(inspectRangeResult.structuredContent.suggested.findLines, "2:2");
    assert.match(inspectRangeResult.structuredContent.suggested.replaceHint, /trailing newline/);

    const writeFileResult = await client.callTool({
      name: "file_write",
      arguments: { mode: "write", file: mcpWriteFile, source: "{\"ok\":true}\n", write: true },
    });
    assert.equal(writeFileResult.isError, undefined);
    assert.equal(writeFileResult.structuredContent.parser, "json");
    assert.equal(writeFileResult.structuredContent.files[0].change, "created");
    assert.equal(writeFileResult.structuredContent.files[0].persisted, true);
    assert.match(writeFileResult.structuredContent.summary, /1 file written; parse verified with json/);
    assert.equal(readFileSync(mcpWriteFile, "utf8"), "{\"ok\":true}\n");

    const scaffoldResult = await client.callTool({
      name: "file_write",
      arguments: {
        mode: "scaffold",
        file: mcpScaffoldFile,
        spec: { exports: [{ kind: "function", name: "Scaffolded", body: { tag: "section" } }] },
        write: true,
      },
    });
    assert.equal(scaffoldResult.isError, undefined);
    assert.equal(scaffoldResult.structuredContent.parser, "jsx");
    assert.match(readFileSync(mcpScaffoldFile, "utf8"), /export function Scaffolded/);

    const newFileResult = await client.callTool({
      name: "file_write",
      arguments: { mode: "template", file: mcpNewFile, template: "react-client-component", params: { name: "ClientCard" }, write: true },
    });
    assert.equal(newFileResult.isError, undefined);
    assert.equal(newFileResult.structuredContent.parser, "jsx");
    assert.match(readFileSync(mcpNewFile, "utf8"), /export function ClientCard/);

    const verifyResult = await client.callTool({
      name: "verify_file",
      arguments: { file: jsonFile },
    });
    assert.equal(verifyResult.isError, undefined);
    assert.equal(verifyResult.structuredContent.parse_verified, true);
    assert.equal(verifyResult.structuredContent.parser, "json");

    const warningVerifyResult = await client.callTool({
      name: "verify_file",
      arguments: { file: mcpWarnFile },
    });
    assert.equal(warningVerifyResult.isError, undefined);
    assert.equal(warningVerifyResult.structuredContent.warnings[0].code, "CLASSNAME_CONFLICT");
    assert.equal(warningVerifyResult.structuredContent.warnings[0].group, "width");

    const textVerifyResult = await client.callTool({
      name: "verify_file",
      arguments: { file },
    });
    assert.equal(textVerifyResult.isError, undefined);
    assert.equal(textVerifyResult.structuredContent.parse_verified, false);
    assert.equal(textVerifyResult.structuredContent.parse_skipped, true);
    assert.equal(textVerifyResult.structuredContent.parse_skip_reason, "unsupported_extension");

  } finally {
    await client.close();
  }
});

test("mcp server exposes advanced tools when profile is all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-mcp-all-"));
  const jsxFile = join(dir, "Advanced.tsx");
  const astFile = join(dir, "strings.tsx");
  const createdFile = join(dir, "created.md");
  writeFileSync(jsxFile, "export function Advanced() {\n  return <DailyPlanBody />;\n}\n");
  writeFileSync(astFile, "const item = { label: \"삭제\" };\nexport function Strings() { return <input placeholder=\"검색\" />; }\n");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcp],
    stderr: "pipe",
    env: { ...process.env, TEDIT_MCP_PROFILE: "all" },
  });
  const client = new Client({ name: "tedit-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("write_file"));
    assert.ok(names.includes("scaffold_file"));
    assert.ok(names.includes("new_file"));
    assert.ok(names.includes("create_file"));
    assert.ok(names.includes("templates"));
    assert.ok(names.includes("history_trace"));
    assert.ok(names.includes("scan_strings"));
    assert.ok(names.includes("ast_select"));
    assert.ok(names.includes("ast_edit"));
    assert.ok(names.includes("jsx_node"));
    assert.ok(names.includes("wrap"));
    assert.ok(names.includes("prop_set"));
    assert.ok(names.includes("apply_plan"));
    assert.ok(names.includes("extract_plan"));
    assert.ok(names.includes("refactor_state_plan"));

    const actionsDiscovery = await client.callTool({
      name: "actions",
      arguments: {},
    });
    assert.equal(actionsDiscovery.isError, undefined);
    assert.equal(actionsDiscovery.structuredContent.profiles.current, "all");
    const writeMeta = actionsDiscovery.structuredContent.tools.find((tool) => tool.name === "write_file");
    assert.equal(writeMeta.exposure, "advanced");
    assert.equal(writeMeta.registered, true);

    const templatesResult = await client.callTool({
      name: "templates",
      arguments: {},
    });
    assert.equal(templatesResult.isError, undefined);
    assert.equal(templatesResult.structuredContent.kind, "templates");
    assert.ok(templatesResult.structuredContent.templates.some((template) => template.name === "react-client-component"));

    const scanStringsResult = await client.callTool({
      name: "scan_strings",
      arguments: { file: astFile },
    });
    assert.equal(scanStringsResult.isError, undefined);
    assert.equal(scanStringsResult.structuredContent.kind, "scan-strings");
    assert.ok(scanStringsResult.structuredContent.strings.some((item) => item.value === "삭제"));
    assert.ok(scanStringsResult.structuredContent.strings.some((item) => item.value === "검색"));

    const astEditResult = await client.callTool({
      name: "ast_edit",
      arguments: { file: astFile, objectKey: "label", replace: "Delete", write: true },
    });
    assert.equal(astEditResult.isError, undefined);
    assert.equal(astEditResult.structuredContent.ok, true);
    assert.equal(astEditResult.structuredContent.kind, "mutation");
    assert.equal(astEditResult.structuredContent.writtenCount, 1);
    assert.match(readFileSync(astFile, "utf8"), /label: "Delete"/);

    const wrapResult = await client.callTool({
      name: "jsx_node",
      arguments: { action: "wrap", file: jsxFile, selector: "DailyPlanBody", with: "div.flex.gap-4", write: true },
    });
    assert.equal(wrapResult.isError, undefined);
    assert.equal(wrapResult.structuredContent.ok, true);
    assert.equal(wrapResult.structuredContent.kind, "mutation");
    assert.match(readFileSync(jsxFile, "utf8"), /<div className="flex gap-4"><DailyPlanBody \/><\/div>/);

    const createFileResult = await client.callTool({
      name: "create_file",
      arguments: { file: createdFile, source: "# Created\n", write: true },
    });
    assert.equal(createFileResult.isError, undefined);
    assert.equal(createFileResult.structuredContent.parser, "markdown-lite");
    assert.equal(createFileResult.structuredContent.files[0].change, "created");
    assert.equal(readFileSync(createdFile, "utf8"), "# Created\n");
  } finally {
    await client.close();
  }
});

test("mcp server hot-loads tool logic without reconnect", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-tedit-mcp-hot-"));
  const installDir = join(dir, "dist");
  const file = join(dir, "notes.md");
  cpSync(distDir, installDir, { recursive: true });
  writeFileSync(file, "# Title\n");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(installDir, "mcp.js")],
    stderr: "pipe",
  });
  const client = new Client({ name: "tedit-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const before = await client.callTool({
      name: "verify_file",
      arguments: { file },
    });
    assert.equal(before.isError, undefined);
    assert.equal(before.structuredContent.hot_reload_probe, undefined);

    const toolsFile = join(installDir, "mcp-tools.js");
    const source = readFileSync(toolsFile, "utf8");
    assert.match(source, /function runVerifyFileTool/);
    const patched = source.replace(
      /(function runVerifyFileTool[\s\S]*?success: true,\n)(\s+file: filePath,)/,
      "$1        hot_reload_probe: \"after\",\n$2",
    );
    assert.notEqual(patched, source);
    writeFileSync(toolsFile, patched);

    const after = await client.callTool({
      name: "verify_file",
      arguments: { file },
    });
    assert.equal(after.isError, undefined);
    assert.equal(after.structuredContent.hot_reload_probe, "after");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("base edit exact replace dry-runs and writes unsupported files", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "# Title\nold value\n");

  const dryRun = run(["edit", file, "--find", "old value", "--replace", "new value"]);
  assert.match(dryRun, /new value/);
  assert.equal(readFileSync(file, "utf8"), "# Title\nold value\n");

  const result = JSON.parse(run(["edit", file, "--find", "old value", "--replace", "new value", "--write", "--json"]));
  assert.equal(result.success, true);
  assert.equal(result.changed, true);
  assert.equal(result.written, true);
  assert.equal(result.parse_verified, false);
  assert.equal(result.parse_skipped, true);
  assert.equal(result.parse_skip_reason, "unsupported_extension");
  assert.equal(readFileSync(file, "utf8"), "# Title\nnew value\n");
});

test("base edit reports ambiguous exact matches with candidates", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "copy.txt");
  writeFileSync(file, "Button\nSpacer\nButton\n");

  const failed = runFail(["edit", file, "--find", "Button", "--replace", "Link", "--write"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "MATCH_NOT_UNIQUE");
  assert.equal(failed.body.details.matches.length, 2);
  assert.deepEqual(failed.body.details.retry_hints.filter((hint) => hint.kind === "find-lines").map((hint) => hint.findLines), ["1", "3"]);
  assert.deepEqual(failed.body.suggestions.slice(0, 2), ["Retry candidate 1 with --find-lines 1.", "Retry candidate 2 with --find-lines 3."]);
  assert.match(readFileSync(file, "utf8"), /Button\nSpacer\nButton/);
});

test("base edit exact failure surfaces a fuzzy-only diagnostic without writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "source.ts");
  const original = "function save(\n  value\n) {\n  return value;\n}\n";
  writeFileSync(file, original);

  const failed = runFail(["edit", file, "--find", "function save( value )", "--replace", "function save(value)", "--write"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "MATCH_FUZZY_ONLY");
  assert.equal(failed.body.details.matches.length, 1);
  assert.equal(failed.body.details.matches[0].lineRange, "1:3");
  assert.equal(failed.body.details.fuzzy_candidates[0].find_lines, "1:3");
  assert.equal(failed.body.details.retry_hints[0].kind, "find-fuzzy");
  assert.equal(failed.body.details.retry_hints[0].findFuzzy, "function save( value )");
  assert.equal(failed.body.details.retry_hints[1].findLines, "1:3");
  assert.deepEqual(failed.body.suggestions, [
    'Retry with --find-fuzzy "function save( value )" using the same mutation.',
    "Retry candidate 1 with --find-lines 1:3."
  ]);
  assert.deepEqual(failed.body.details.fuzzy_candidates[0].whitespace_drift.requested_runs, [1, 1, 1]);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("base edit exact miss surfaces near candidates and retry hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "source.txt");
  writeFileSync(file, "Hello world\nStatus: pending\n");

  const failed = runFail(["edit", file, "--find", "Helo", "--replace", "Hi", "--write"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "MATCH_NONE");
  assert.equal(failed.body.details.near_candidates[0].find_lines, "1");
  assert.match(failed.body.details.near_candidates[0].preview, /Hello world/);
  assert.equal(failed.body.details.retry_hints[0].kind, "find-lines");
  assert.equal(failed.body.details.retry_hints[0].findLines, "1");
  assert.equal(failed.body.suggestions[0], "Retry near candidate 1 with --find-lines 1.");
  assert.equal(readFileSync(file, "utf8"), "Hello world\nStatus: pending\n");
});

test("base edit fuzzy strategy applies whitespace-insensitive replacements", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "source.txt");
  writeFileSync(file, "const   answer\n =   42;\n");

  run(["edit", file, "--find-fuzzy", "const answer = 42;", "--replace", "const answer = 43;", "--write"]);

  assert.equal(readFileSync(file, "utf8"), "const answer = 43;\n");
});

test("base edit anchor strategy inserts relative to a section marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "handlers.txt");
  writeFileSync(file, "start\n// Handlers\nfoo()\nbar()\n");

  run(["edit", file, "--find-anchor-after", "// Handlers", "--find", "foo()", "--insert-after", "\ninserted()", "--write"]);

  assert.equal(readFileSync(file, "utf8"), "start\n// Handlers\nfoo()\ninserted()\nbar()\n");
});

test("base edit regex replace-all honors expect-count", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "style.css");
  writeFileSync(file, ".a { color: red; }\n.b { background: red; }\n");

  const result = JSON.parse(run(["edit", file, "--find-regex", "\\bred\\b", "--replace", "blue", "--replace-all", "--expect-count", "2", "--write", "--json"]));

  assert.equal(result.matches.length, 2);
  assert.equal(readFileSync(file, "utf8"), ".a { color: blue; }\n.b { background: blue; }\n");
});

test("base edit regex replacement treats dollar backrefs literally", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "styles.css");
  writeFileSync(file, "color: red;\n");

  const result = JSON.parse(run(["edit", file, "--find-regex", "(red)", "--replace", "var($1)", "--replace-all", "--expect-count", "1", "--write", "--json"]));

  assert.equal(result.success, true);
  assert.equal(readFileSync(file, "utf8"), "color: var($1);\n");
});

test("dogfood regression covers edit summary replace-all and TSX prop set", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const notes = join(dir, "dogfood.md");
  const card = join(dir, "Card.tsx");
  writeFileSync(notes, "# Demo\nThe quick brown fox.\nStatus: pending\nStatus: pending\n");
  writeFileSync(card, "export function Card() {\n  return <div className=\"card\">Hello</div>;\n}\n");

  const summary = run(["edit", notes, "--find", "quick brown", "--replace", "careful brown", "--dry-run", "--summary"]);
  assert.match(summary, /result: success - 1\/1 match/);
  assert.match(summary, /full diff omitted/);
  assert.equal(readFileSync(notes, "utf8"), "# Demo\nThe quick brown fox.\nStatus: pending\nStatus: pending\n");

  run(["edit", notes, "--find", "quick brown", "--replace", "careful brown", "--write"]);
  run(["edit", notes, "--find-regex", "Status: pending", "--replace", "Status: done", "--replace-all", "--expect-count", "2", "--write"]);
  run(["prop", "set", card, "div.card", "className", "card active", "--write"]);

  assert.equal(readFileSync(notes, "utf8"), "# Demo\nThe careful brown fox.\nStatus: done\nStatus: done\n");
  assert.match(readFileSync(card, "utf8"), /<div className="card active">Hello<\/div>/);
});

test("base edit line ranges can delete full lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "lines.txt");
  writeFileSync(file, "a\nb\nc\n");

  run(["edit", file, "--find-lines", "2:2", "--delete", "--write"]);

  assert.equal(readFileSync(file, "utf8"), "a\nc\n");
});

test("base edit line replacement preserves missing trailing newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "lines.txt");
  writeFileSync(file, "a\nb\nc\n");

  const result = JSON.parse(run(["edit", file, "--find-lines", "2", "--replace", "B", "--write", "--json"]));

  assert.equal(result.success, true);
  assert.equal(result.guardrails[0].kind, "line-replace-newline-preserved");
  assert.equal(readFileSync(file, "utf8"), "a\nB\nc\n");
});

test("base edit can read find and replace text from files", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  const findFile = join(dir, "old.txt");
  const replaceFile = join(dir, "new.txt");
  writeFileSync(file, "before\nold\nblock\nafter\n");
  writeFileSync(findFile, "old\nblock");
  writeFileSync(replaceFile, "new\nblock");

  run(["edit", file, "--find-file", findFile, "--replace-file", replaceFile, "--write"]);

  assert.equal(readFileSync(file, "utf8"), "before\nnew\nblock\nafter\n");
});

test("base edit can read replacement from stdin", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "before\nold\nafter\n");

  runWithInput(["edit", file, "--find", "old", "--replace-stdin", "--write"], "new\nmulti");

  assert.equal(readFileSync(file, "utf8"), "before\nnew\nmulti\nafter\n");
});

test("base edit can read find text from stdin", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "before\nold\nblock\nafter\n");

  runWithInput(["edit", file, "--find-stdin", "--replace", "new", "--write"], "old\nblock");

  assert.equal(readFileSync(file, "utf8"), "before\nnew\nafter\n");
});

test("base edit accepts a single-edit JSON spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  const spec = join(dir, "edit.json");
  writeFileSync(file, "timeout: 3000\n");
  writeFileSync(spec, JSON.stringify({ find: "timeout: 3000", replace: "timeout: 5000" }));

  const result = JSON.parse(run(["edit", file, "--spec", spec, "--write", "--json"]));

  assert.equal(result.success, true);
  assert.equal(readFileSync(file, "utf8"), "timeout: 5000\n");
});

test("base edit rejects conflicting stdin-backed inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "old\n");

  const failed = runFail(["edit", file, "--find-stdin", "--replace-stdin", "--write"], "old");

  assert.equal(failed.status, 1);
  assert.match(failed.body.error, /Use only one stdin-backed edit input flag/);
  assert.equal(readFileSync(file, "utf8"), "old\n");
});

test("base edit verifies registered language rules before writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const original = "export function Page() {\n  return <main><Title /></main>;\n}\n";
  writeFileSync(file, original);

  const failed = runFail(["edit", file, "--find", "<Title />", "--replace", "<Title>", "--write"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.equal(readFileSync(file, "utf8"), original);
});

test("base edit verifies JSON before writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "config.json");
  const original = "{\n  \"timeout\": 3000\n}\n";
  writeFileSync(file, original);

  const result = JSON.parse(run(["edit", file, "--find", "3000", "--replace", "5000", "--write", "--json"]));
  assert.equal(result.parse_verified, true);
  assert.equal(result.parser, "json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { timeout: 5000 });

  const failed = runFail(["edit", file, "--find", "5000", "--replace", "}", "--write"]);
  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.equal(readFileSync(file, "utf8"), "{\n  \"timeout\": 5000\n}\n");
});

test("base edit verifies lightweight Markdown fences before writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.md");
  const original = "# Title\n\n```ts\nconst value = \"old\";\n```\n";
  writeFileSync(file, original);

  const result = JSON.parse(run(["edit", file, "--find", "old", "--replace", "new", "--write", "--json"]));
  assert.equal(result.parse_verified, true);
  assert.equal(result.parser, "markdown-lite");

  const failed = runFail(["edit", file, "--find", "\n```\n", "--replace", "\n", "--write"]);
  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.equal(readFileSync(file, "utf8"), "# Title\n\n```ts\nconst value = \"new\";\n```\n");
});

test("verify-file reports current parser coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const jsonFile = join(dir, "config.json");
  const markdownFile = join(dir, "README.md");
  const mdxFile = join(dir, "Component.mdx");
  const textFile = join(dir, "notes.txt");
  writeFileSync(jsonFile, "{\"enabled\":true}\n");
  writeFileSync(markdownFile, "# Notes\n\n```ts\nconst ok = true;\n```\n");
  writeFileSync(mdxFile, "# Notes\n\n<Component />\n");
  writeFileSync(textFile, "plain\n");

  const json = JSON.parse(run(["verify-file", jsonFile, "--json"]));
  const markdown = JSON.parse(run(["verify-file", markdownFile, "--json"]));
  const mdx = JSON.parse(run(["verify-file", mdxFile, "--json"]));
  const text = JSON.parse(run(["verify-file", textFile, "--json"]));

  assert.equal(json.parse_verified, true);
  assert.equal(json.parser, "json");
  assert.equal(markdown.parse_verified, true);
  assert.equal(markdown.parser, "markdown-lite");
  assert.equal(mdx.parse_verified, true);
  assert.equal(mdx.parser, "markdown-lite");
  assert.equal(text.parse_verified, false);
  assert.equal(text.parse_skipped, true);
  assert.equal(text.parse_skip_reason, "unsupported_extension");
  assert.equal(text.parser, undefined);

  const many = JSON.parse(run(["verify-file", jsonFile, markdownFile, textFile, "--json"]));
  assert.equal(many.kind, "verify-files");
  assert.equal(many.count, 3);
  assert.equal(many.verifiedCount, 2);
  assert.equal(many.skippedCount, 1);
  assert.equal(many.files[2].file, textFile);
  assert.equal(many.files[2].parse_skip_reason, "unsupported_extension");

  const compactMany = JSON.parse(runRaw(["verify-file", jsonFile, markdownFile, textFile]));
  assert.equal(compactMany.kind, "verify-files");
  assert.equal(compactMany.count, 3);
  assert.equal(compactMany.verifiedCount, 2);
  assert.equal(compactMany.skippedCount, 1);
  assert.equal(compactMany.files[0].file, undefined);
  assert.equal(compactMany.files[0].path, jsonFile);
  assert.equal(compactMany.files[2].parse_skip_reason, "unsupported_extension");
});

test("verify-file enforces Markdown and YAML lightweight boundaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const thematic = join(dir, "thematic.md");
  const frontmatterEnd = join(dir, "frontmatter.md");
  const mdxList = join(dir, "List.mdx");
  const validYaml = join(dir, "valid.yaml");
  const tabYaml = join(dir, "tab.yaml");
  const oddIndentYaml = join(dir, "odd.yaml");
  const duplicateYaml = join(dir, "duplicate.yaml");
  const multiDocYaml = join(dir, "multi.yaml");
  writeFileSync(thematic, "---\ncontent\ntitle: Not frontmatter\n");
  writeFileSync(frontmatterEnd, "---\ntitle: Demo\n...\n# Body\n");
  writeFileSync(mdxList, "# List\n\n- <Component prop=\"x\" />\n");
  writeFileSync(validYaml, "---\nserver:\n  host: localhost\n...\n");
  writeFileSync(tabYaml, "server:\n  \thost: localhost\n");
  writeFileSync(oddIndentYaml, "server:\n host: localhost\n");
  writeFileSync(duplicateYaml, "server:\n  host: localhost\n  host: 127.0.0.1\n");
  writeFileSync(multiDocYaml, "name: one\n---\nname: two\n");

  assert.equal(JSON.parse(run(["verify-file", thematic, "--json"])).parse_verified, true);
  assert.equal(JSON.parse(run(["verify-file", frontmatterEnd, "--json"])).parse_verified, true);
  assert.equal(JSON.parse(run(["verify-file", mdxList, "--json"])).parse_verified, true);
  assert.equal(JSON.parse(run(["verify-file", validYaml, "--json"])).parser, "yaml-lite");
  assert.equal(JSON.parse(run(["find", frontmatterEnd, "frontmatter", "--json"])).matches[0].attributes.path, "$/frontmatter");
  assert.equal(JSON.parse(run(["find", thematic, "paragraph", "--json"])).matches[0].attributes.text, "---\ncontent\ntitle: Not frontmatter");

  for (const file of [tabYaml, oddIndentYaml, duplicateYaml, multiDocYaml]) {
    const failed = runFail(["verify-file", file, "--json"]);
    assert.equal(failed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  }
});

test("verify-file fails on invalid parseable files without modifying them", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "config.json");
  writeFileSync(file, "{\"enabled\":}\n");

  const failed = runFail(["verify-file", file, "--json"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.equal(readFileSync(file, "utf8"), "{\"enabled\":}\n");
});

test("write creates files and verifies JSON before overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "config.json");

  const created = JSON.parse(run(["write", file, "--source", "{\"enabled\":true}", "--write", "--json"]));
  assert.equal(created.success, true);
  assert.equal(created.parse_verified, true);
  assert.equal(created.parser, "json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { enabled: true });

  const refused = runFail(["write", file, "--source", "{\"enabled\":false}", "--write"]);
  assert.equal(refused.status, 1);
  assert.match(refused.body.error, /Refusing to overwrite/);

  const failed = runFail(["write", file, "--source", "{\"enabled\":}", "--overwrite", "--write"]);
  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { enabled: true });

  const overwritten = JSON.parse(run(["write", file, "--source", "{\"enabled\":false}", "--overwrite", "--write", "--json"]));
  assert.equal(overwritten.written, true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { enabled: false });
});

test("multiedit applies same-file edits sequentially and atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  const edits = join(dir, "edits.json");
  writeFileSync(file, "status: draft\nnext: draft\n");
  writeFileSync(edits, JSON.stringify({
    edits: [
      { file, find: "status: draft", replace: "status: reviewed" },
      { file, find: "status: reviewed", replace: "status: approved" }
    ]
  }));

  const result = JSON.parse(run(["multiedit", edits, "--write"]));
  assert.equal(result.success, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.files.length, 1);
  assert.equal(result.parse[0].parse_verified, false);
  assert.equal(result.parse[0].parse_skipped, true);
  assert.equal(result.parse[0].parse_skip_reason, "unsupported_extension");
  assert.equal(readFileSync(file, "utf8"), "status: approved\nnext: draft\n");
});

test("multiedit applies multiple files and reports final parse verification", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const textFile = join(dir, "notes.txt");
  const jsonFile = join(dir, "config.json");
  const input = JSON.stringify({
    edits: [
      { file: textFile, find: "draft", replace: "reviewed" },
      { file: jsonFile, find: "3000", replace: "5000" }
    ]
  });
  writeFileSync(textFile, "Status: draft\n");
  writeFileSync(jsonFile, "{\n  \"timeout\": 3000\n}\n");

  const result = JSON.parse(runWithInput(["multiedit", "--from-stdin", "--write"], input));
  const jsonParse = result.parse.find((item) => item.file === jsonFile);
  const textParse = result.parse.find((item) => item.file === textFile);
  assert.equal(result.files.length, 2);
  assert.equal(jsonParse.parse_verified, true);
  assert.equal(jsonParse.parser, "json");
  assert.equal(textParse.parse_verified, false);
  assert.equal(textParse.parse_skipped, true);

  const compactTextFile = join(dir, "compact.txt");
  const compactJsonFile = join(dir, "compact.json");
  writeFileSync(compactTextFile, "mode: old\n");
  writeFileSync(compactJsonFile, "{\n  \"mode\": \"old\"\n}\n");
  const compactInput = JSON.stringify({
    edits: [
      { file: compactTextFile, find: "old", replace: "new" },
      { file: compactJsonFile, find: "old", replace: "new" }
    ]
  });
  const compact = JSON.parse(runRaw(["multiedit", "--from-stdin", "--write"], compactInput));
  assert.match(compact.summary, /2 files written; parse verified\/skipped/);
  assert.equal(compact.kind, "mutation");
  assert.equal(compact.changedCount, 2);
  assert.equal(compact.writtenCount, 2);
  assert.equal(compact.files.find((item) => item.path === compactTextFile).parse_skipped, true);
  assert.equal(compact.files.find((item) => item.path === compactJsonFile).parser, "json");
  assert.ok(compact.files.every((item) => item.change === "modified"));
  assert.ok(compact.files.every((item) => item.persisted === true));

  assert.equal(readFileSync(textFile, "utf8"), "Status: reviewed\n");
  assert.deepEqual(JSON.parse(readFileSync(jsonFile, "utf8")), { timeout: 5000 });
});

test("multiedit summary mode omits diffs and can list files or edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  const edits = join(dir, "edits.json");
  writeFileSync(a, "old a\n");
  writeFileSync(b, "old b\n");
  writeFileSync(edits, JSON.stringify({
    edits: [
      { file: a, find: "old a", replace: "new a" },
      { file: b, find: "old b", replace: "new b" }
    ]
  }));

  const byFile = run(["multiedit", edits, "--dry-run", "--summary"]);
  assert.match(byFile, /spec: edits\.json \(2 edits, 2 files\)/);
  assert.ok(byFile.includes(a));
  assert.ok(byFile.includes(b));
  assert.match(byFile, /ok\s+1\/1/);
  assert.match(byFile, /result: success - 2\/2 edits matched, no files written \(dry-run\)/);
  assert.doesNotMatch(byFile, /^--- /m);
  assert.equal(readFileSync(a, "utf8"), "old a\n");

  const byEdit = run(["multiedit", edits, "--dry-run", "--summary=edits"]);
  assert.match(byEdit, /edit\[0\].*ok\s+1 match\s+exact replace/);
  assert.match(byEdit, /edit\[1\].*ok\s+1 match\s+exact replace/);
});

test("edit summary mode omits dry-run diffs", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "old\n");

  const output = run(["edit", file, "--find", "old", "--replace", "new", "--dry-run", "--summary"]);

  assert.ok(output.includes("edit: " + file));
  assert.match(output, /result: success - 1\/1 match, no files written \(dry-run\)/);
  assert.match(output, /full diff omitted/);
  assert.doesNotMatch(output, /^--- /m);
  assert.equal(readFileSync(file, "utf8"), "old\n");
});

test("edit summary mode reports failures tersely with suggestions", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "Hello world\n");

  const failed = spawnSync(process.execPath, [cli, "edit", file, "--find", "Helo", "--replace", "Hi", "--summary"], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, "");
  assert.match(failed.stdout, /FAIL - no match/);
  assert.match(failed.stdout, /result: failure - MATCH_NONE/);
  assert.match(failed.stdout, /Retry near candidate 1 with --find-lines 1/);
  assert.equal(readFileSync(file, "utf8"), "Hello world\n");
});

test("multiedit summary mode reports failures tersely", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  const edits = join(dir, "edits.json");
  writeFileSync(a, "old a\n");
  writeFileSync(b, "old b\n");
  writeFileSync(edits, JSON.stringify({
    edits: [
      { file: a, find: "old a", replace: "new a" },
      { file: b, find: "missing", replace: "new b" }
    ]
  }));

  const failed = spawnSync(process.execPath, [cli, "multiedit", edits, "--dry-run", "--summary"], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAIL\s+0\/1/);
  assert.match(failed.stdout, /edit\[1\] find: "missing" - no match/);
  assert.match(failed.stdout, /result: failure - MATCH_NONE/);
  assert.doesNotMatch(failed.stdout, /^--- /m);
  assert.equal(failed.stderr, "");
  assert.equal(readFileSync(a, "utf8"), "old a\n");
  assert.equal(readFileSync(b, "utf8"), "old b\n");
});

test("CLI version and subcommand help are concise", () => {
  const version = run(["--version"]);
  assert.match(version, /^tedit 0\.1\.0\n$/);

  const help = run(["help", "verify"]);
  assert.match(help, /tedit verify/);
  assert.match(help, /explicit dry-run/);
  assert.doesNotMatch(help, /tedit scaffold/);

  const topics = [
    "edit", "multiedit", "verify", "verify-file", "patch", "actions", "templates", "inspect-range", "search-text", "history-trace", "scan-strings", "ast-select", "ast-edit", "analyze-state",
    "refactor-state", "find", "inspect", "append", "prepend", "wrap",
    "unwrap", "remove", "rename", "insertComment", "text", "prop",
    "imports", "expr", "extract", "apply-plan", "plan", "create", "write", "scaffold", "new",
    "flow", "workspace-flow", "wflow", "chain", "chain-workspace", "wchain",
    "rules", "backups"
  ];
  for (const topic of topics) {
    const topicHelp = run(["help", topic]);
    assert.match(topicHelp, /^tedit /, topic);
    assert.doesNotMatch(topicHelp, /Unknown help topic/, topic);
  }

  const searchHelp = run(["help", "search-text"]);
  assert.match(searchHelp, /\*\*\/\*\.\{ts,tsx\}/);
  assert.match(searchHelp, /spaces around brace alternatives are ignored/);
});

test("cli non-tty defaults to compact output and detailed override keeps legacy diff text", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "old\n");

  const compact = JSON.parse(runRaw(["edit", file, "--find", "old", "--replace", "new", "--dry-run"]));

  assert.equal(compact.success, undefined);
  assert.equal(compact.ok, true);
  assert.equal(compact.kind, "mutation");
  assert.equal(compact.changedCount, 1);
  assert.equal(compact.writtenCount, 0);
  assert.match(compact.summary, /1 file would change; parse skipped \(unsupported_extension\)/);
  assert.equal(compact.parse_skipped, true);
  assert.equal(compact.parse_skip_reason, "unsupported_extension");
  assert.equal(compact.files[0].file, undefined);
  assert.equal(compact.files[0].change, "modified");
  assert.equal(compact.files[0].persisted, false);
  assert.equal(compact.files[0].changed, undefined);
  assert.equal(compact.files[0].written, undefined);
  assert.equal(compact.files[0].path, file);
  assert.equal(compact.files[0].status, undefined);
  assert.equal(compact.files[0].diffAvailable, true);
  assert.equal(compact.files[0].diff.mode, "inline");
  assert.equal(compact.files[0].diff.hunks, 1);
  assert.match(compact.files[0].diff.preview, /\+new/);
  assert.equal(compact.diff, undefined);
  assert.deepEqual(compact.next, ["rerun with write=true to apply"]);
  assert.equal(readFileSync(file, "utf8"), "old\n");

  const detailed = runRaw(["edit", file, "--find", "old", "--replace", "new", "--dry-run", "--output", "detailed"]);
  assert.match(detailed, /^--- /m);
  assert.match(detailed, /\+new/);
});

test("config file can choose the default CLI output mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  mkdirp(join(dir, ".tedit"));
  writeFileSync(join(dir, ".tedit", "config.json"), JSON.stringify({
    output: { defaultMode: "detailed" }
  }, null, 2));
  writeFileSync(file, "old\n");

  const detailed = runRaw(["edit", file, "--find", "old", "--replace", "new", "--dry-run"]);
  assert.match(detailed, /^--- /m);
  assert.match(detailed, /\+new/);

  const compact = JSON.parse(runRaw(["edit", file, "--find", "old", "--replace", "new", "--dry-run", "--output", "compact"]));
  assert.equal(compact.success, undefined);
  assert.equal(compact.ok, true);
  assert.equal(compact.kind, "mutation");
  assert.equal(compact.diff, undefined);
  assert.equal(compact.files[0].file, undefined);
  assert.equal(compact.files[0].change, "modified");
  assert.equal(compact.files[0].persisted, false);
  assert.equal(compact.files[0].diffAvailable, true);
  assert.equal(compact.files[0].diff.mode, "inline");
  assert.match(compact.files[0].diff.preview, /\+new/);
});

test("compact diffMode auto inlines small diffs and spills large write diffs to artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const smallFile = join(dir, "small.txt");
  const largeFile = join(dir, "large.txt");
  writeFileSync(smallFile, "old\n");
  writeFileSync(largeFile, "old\n");

  const small = JSON.parse(runRawInCwd(["edit", smallFile, "--find", "old", "--replace", "new", "--dry-run"], dir));
  assert.equal(small.files[0].diff.mode, "inline");
  assert.match(small.files[0].diff.preview, /\+new/);
  assert.equal(small.files[0].diff.path, undefined);

  const largeReplace = "new " + "x".repeat(9000);
  const large = JSON.parse(runRawInCwd(["edit", largeFile, "--find", "old", "--replace", largeReplace, "--write", "--no-backup"], dir));
  const diff = large.files[0].diff;

  assert.equal(diff.mode, "artifact");
  assert.equal(diff.truncated, true);
  assert.ok(diff.bytes > 8000);
  assert.equal(diff.hunks, 1);
  assert.ok(realpathSync(diff.path).startsWith(realpathSync(join(dir, ".tedit-cache", "diffs"))));
  assert.match(diff.relPath, /^\.tedit-cache\/diffs\/large\.txt-[a-f0-9]+\.diff$/);
  assert.match(diff.preview, /diff truncated/);
  assert.match(readFileSync(diff.path, "utf8"), /\+new x/);
  assert.equal(readFileSync(largeFile, "utf8"), largeReplace + "\n");
});

test("compact diffMode auto does not write dry-run artifacts unless explicitly enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const dryFile = join(dir, "dry.txt");
  const explicitFile = join(dir, "explicit.txt");
  const replace = "new " + "x".repeat(9000);
  writeFileSync(dryFile, "old\n");
  writeFileSync(explicitFile, "old\n");

  const dryRun = JSON.parse(runRawInCwd(["edit", dryFile, "--find", "old", "--replace", replace, "--dry-run"], dir));
  assert.equal(dryRun.files[0].diff.mode, "truncated");
  assert.equal(dryRun.files[0].diff.path, undefined);
  assert.match(dryRun.files[0].diff.preview, /diff truncated/);
  assert.equal(existsSync(join(dir, ".tedit-cache", "diffs")), false);
  assert.equal(readFileSync(dryFile, "utf8"), "old\n");

  const explicit = JSON.parse(runRawInCwd(["edit", explicitFile, "--find", "old", "--replace", replace, "--dry-run", "--diff-artifacts=true"], dir));
  assert.equal(explicit.files[0].diff.mode, "artifact");
  assert.ok(existsSync(explicit.files[0].diff.path));
  assert.equal(readFileSync(explicitFile, "utf8"), "old\n");
});

test("compact diffMode can be configured or disabled per command", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const statsFile = join(dir, "stats.txt");
  const disabledFile = join(dir, "disabled.txt");
  mkdirp(join(dir, ".tedit"));
  writeFileSync(join(dir, ".tedit", "config.json"), JSON.stringify({
    output: { diffMode: "stats" }
  }, null, 2));
  writeFileSync(statsFile, "old\n");
  writeFileSync(disabledFile, "old\n");

  const stats = JSON.parse(runRawInCwd(["edit", statsFile, "--find", "old", "--replace", "new", "--dry-run"], dir));
  assert.equal(stats.files[0].diff.mode, "stats");
  assert.equal(stats.files[0].diff.preview, undefined);
  assert.equal(stats.files[0].diff.path, undefined);

  const disabled = JSON.parse(runRawInCwd(["edit", disabledFile, "--find", "old", "--replace", "new", "--dry-run", "--diff-mode=off"], dir));
  assert.equal(disabled.files[0].diffAvailable, true);
  assert.equal(disabled.files[0].diff, undefined);
});

test("config file validates the default CLI output mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  mkdirp(join(dir, ".tedit"));
  writeFileSync(join(dir, ".tedit", "config.json"), JSON.stringify({
    output: { defaultMode: "verbose" }
  }, null, 2));
  writeFileSync(file, "old\n");

  const failed = spawnSync(process.execPath, [cli, "edit", file, "--find", "old", "--replace", "new", "--dry-run"], {
    encoding: "utf8",
    env: rawEnv(),
  });
  const body = JSON.parse(failed.stderr);

  assert.equal(failed.status, 1);
  assert.equal(body.code, "INVALID_TEDIT_CONFIG");
  assert.match(body.error, /output\.defaultMode/);
  assert.equal(readFileSync(file, "utf8"), "old\n");
});

test("config file validates compact diff output settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  mkdirp(join(dir, ".tedit"));
  writeFileSync(join(dir, ".tedit", "config.json"), JSON.stringify({
    output: { diffMode: "hunks" }
  }, null, 2));
  writeFileSync(file, "old\n");

  const failed = spawnSync(process.execPath, [cli, "edit", file, "--find", "old", "--replace", "new", "--dry-run"], {
    encoding: "utf8",
    env: rawEnv(),
  });
  const body = JSON.parse(failed.stderr);

  assert.equal(failed.status, 1);
  assert.equal(body.code, "INVALID_TEDIT_CONFIG");
  assert.match(body.error, /output\.diffMode/);
  assert.equal(readFileSync(file, "utf8"), "old\n");
});

test("cli non-tty failures use compact error output", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "Hello world\n");

  const failed = spawnSync(process.execPath, [cli, "edit", file, "--find", "Helo", "--replace", "Hi"], {
    encoding: "utf8",
    env: rawEnv(),
  });
  const body = JSON.parse(failed.stderr);

  assert.equal(failed.status, 1);
  assert.equal(body.success, undefined);
  assert.equal(body.ok, false);
  assert.equal(body.kind, "error");
  assert.equal(body.code, "MATCH_NONE");
  assert.match(body.summary, /No match found/);
  assert.equal(body.details, undefined);
  assert.equal(body.suggestions[0], "Retry near candidate 1 with --find-lines 1.");
});

test("edit quiet mode suppresses stdout while diff-out captures detail", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  const diff = join(dir, "change.diff");
  writeFileSync(file, "old\n");

  const output = run(["edit", file, "--find", "old", "--replace", "new", "--dry-run", "--quiet", "--diff-out", diff]);

  assert.equal(output, "");
  assert.equal(readFileSync(file, "utf8"), "old\n");
  assert.match(readFileSync(diff, "utf8"), /\+new/);
});

test("write quiet mode suppresses stdout while diff-out captures detail", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "created.txt");
  const diff = join(dir, "write.diff");

  const output = run(["write", file, "--source", "created", "--dry-run", "--quiet", "--diff-out", diff]);

  assert.equal(output, "");
  assert.equal(existsSync(file), false);
  assert.match(readFileSync(diff, "utf8"), /\+created/);
});

test("verify runs multiedit specs as terse dry-runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  const edits = join(dir, "edits.json");
  const diff = join(dir, "verify.diff");
  writeFileSync(file, "old\n");
  writeFileSync(edits, JSON.stringify({ edits: [{ file, find: "old", replace: "new" }] }));

  const summary = run(["verify", edits, "--diff-out", diff]);
  assert.match(summary, /spec: edits\.json \(1 edit, 1 file\)/);
  assert.match(summary, /result: success - 1\/1 edits matched, no files written \(dry-run\)/);
  assert.equal(readFileSync(file, "utf8"), "old\n");
  assert.match(readFileSync(diff, "utf8"), /\+new/);

  const quiet = run(["verify", edits, "--quiet"]);
  assert.equal(quiet, "");
});

test("verify quiet mode reports failures as terse JSON on stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  const edits = join(dir, "edits.json");
  writeFileSync(file, "old\n");
  writeFileSync(edits, JSON.stringify({ edits: [{ file, find: "missing", replace: "new" }] }));

  const failed = spawnSync(process.execPath, [cli, "verify", edits, "--quiet"], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.equal(JSON.parse(failed.stderr).code, "MATCH_NONE");
});

test("patch quiet mode suppresses stdout and can write diff-out", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  const patch = join(dir, "change.patch");
  const diff = join(dir, "patch.diff");
  writeFileSync(file, "old\n");
  writeFileSync(patch, [
    "*** Begin Patch",
    "*** Update File: " + file,
    "@@",
    "-old",
    "+new",
    "*** End Patch",
    ""
  ].join("\n"));

  const output = run(["patch", patch, "--dry-run", "--quiet", "--diff-out", diff]);

  assert.equal(output, "");
  assert.equal(readFileSync(file, "utf8"), "old\n");
  assert.match(readFileSync(diff, "utf8"), /\+new/);
});

test("multiedit failure prevents all writes and includes edit context", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  const edits = join(dir, "edits.json");
  writeFileSync(a, "old a\n");
  writeFileSync(b, "old b\n");
  writeFileSync(edits, JSON.stringify({
    edits: [
      { file: a, find: "old a", replace: "new a" },
      { file: b, find: "missing", replace: "new b" }
    ]
  }));

  const failed = runFail(["multiedit", edits, "--write"]);
  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "MATCH_NONE");
  assert.equal(failed.body.details.edit, 1);
  assert.equal(failed.body.details.file, b);
  assert.equal(readFileSync(a, "utf8"), "old a\n");
  assert.equal(readFileSync(b, "utf8"), "old b\n");
});

test("multiedit expectCount and final TSX parse failures prevent writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const textFile = join(dir, "copy.txt");
  const tsxFile = join(dir, "Page.tsx");
  writeFileSync(textFile, "red red\n");
  writeFileSync(tsxFile, "export function Page() {\n  return <main><Title /></main>;\n}\n");

  const countFailed = runFail(["multiedit", "--from-stdin", "--write"], JSON.stringify({
    edits: [
      { file: textFile, findRegex: "\\bred\\b", replace: "blue", replaceAll: true, expectCount: 3 }
    ]
  }));
  assert.equal(countFailed.status, 1);
  assert.equal(countFailed.body.code, "MATCH_COUNT_MISMATCH");
  assert.equal(countFailed.body.suggestions[0], "If the observed 2 match(es) are intended, retry with --expect-count 2.");
  assert.equal(readFileSync(textFile, "utf8"), "red red\n");

  const parseFailed = runFail(["multiedit", "--from-stdin", "--write"], JSON.stringify({
    edits: [
      { file: tsxFile, find: "<Title />", replace: "<Title>" }
    ]
  }));
  assert.equal(parseFailed.status, 1);
  assert.equal(parseFailed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.equal(parseFailed.body.details.file, tsxFile);
  assert.match(readFileSync(tsxFile, "utf8"), /<Title \/>/);
});

test("patch applies unified diffs and verifies changed files", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  const patch = join(dir, "change.patch");
  writeFileSync(file, "old\nkeep\n");
  writeFileSync(patch, `--- ${file}
+++ ${file}
@@ -1,2 +1,2 @@
-old
+new
 keep
`);

  const result = JSON.parse(run(["patch", patch, "--write"]));
  assert.equal(result.success, true);
  assert.equal(result.patches[0].file, file);
  assert.equal(readFileSync(file, "utf8"), "new\nkeep\n");
});

test("patch accepts git-prefixed absolute paths without the leading slash", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "old\nkeep\n");

  const result = JSON.parse(runWithInput(["patch", "--stdin", "--write"], `--- a${file}
+++ b${file}
@@ -1,2 +1,2 @@
-old
+new
 keep
`));

  assert.equal(result.success, true);
  assert.equal(result.patches[0].file, file);
  assert.equal(readFileSync(file, "utf8"), "new\nkeep\n");
});

test("patch accepts apply-patch format from --stdin", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "old\nkeep\n");

  const result = JSON.parse(runWithInput(["patch", "--stdin", "--write"], `*** Begin Patch
*** Update File: ${file}
@@
-old
+new
 keep
*** End Patch
`));

  assert.equal(result.success, true);
  assert.equal(result.patches[0].file, file);
  assert.equal(readFileSync(file, "utf8"), "new\nkeep\n");
});

test("patch apply-patch format can add and update files atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const existing = join(dir, "existing.txt");
  const added = join(dir, "added.txt");
  writeFileSync(existing, "alpha\n");

  const result = JSON.parse(runWithInput(["patch", "--stdin", "--write"], `*** Begin Patch
*** Add File: ${added}
+first
+second
*** Update File: ${existing}
@@
-alpha
+beta
*** End Patch
`));

  assert.equal(result.success, true);
  assert.equal(result.files.length, 2);
  assert.equal(readFileSync(existing, "utf8"), "beta\n");
  assert.equal(readFileSync(added, "utf8"), "first\nsecond\n");
});

test("patch supports deleting files in apply-patch format", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "delete-me.txt");
  writeFileSync(file, "remove me\n");

  const result = JSON.parse(runWithInput(["patch", "--stdin", "--write"], `*** Begin Patch
*** Delete File: ${file}
*** End Patch
`));

  assert.equal(result.success, true);
  assert.equal(result.patches[0].deleted, true);
  assert.equal(existsSync(file), false);
});

test("patch supports unified file deletion", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "delete-me.txt");
  writeFileSync(file, "remove me\n");

  const result = JSON.parse(runWithInput(["patch", "--stdin", "--write"], `--- ${file}
+++ /dev/null
@@ -1 +0,0 @@
-remove me
`));

  assert.equal(result.success, true);
  assert.equal(result.patches[0].deleted, true);
  assert.equal(existsSync(file), false);
});

test("patch supports unified rename with edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const oldFile = join(dir, "old.txt");
  const newFile = join(dir, "new.txt");
  writeFileSync(oldFile, "old\nkeep\n");

  const result = JSON.parse(runWithInput(["patch", "--stdin", "--write"], `diff --git a/${oldFile} b/${newFile}
rename from ${oldFile}
rename to ${newFile}
--- ${oldFile}
+++ ${newFile}
@@ -1,2 +1,2 @@
-old
+new
 keep
`));

  assert.equal(result.success, true);
  assert.equal(result.patches[0].renamed, true);
  assert.equal(existsSync(oldFile), false);
  assert.equal(readFileSync(newFile, "utf8"), "new\nkeep\n");
});

test("patch supports apply-patch Move to", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const oldFile = join(dir, "old.txt");
  const newFile = join(dir, "new.txt");
  writeFileSync(oldFile, "alpha\nbeta\n");

  const result = JSON.parse(runWithInput(["patch", "--stdin", "--write"], `*** Begin Patch
*** Update File: ${oldFile}
*** Move to: ${newFile}
@@
-alpha
+gamma
 beta
*** End Patch
`));

  assert.equal(result.success, true);
  assert.equal(result.patches[0].renamed, true);
  assert.equal(existsSync(oldFile), false);
  assert.equal(readFileSync(newFile, "utf8"), "gamma\nbeta\n");
});

test("patch apply-patch hunk failure prevents all writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  writeFileSync(a, "old a\n");
  writeFileSync(b, "old b\n");

  const failed = runFail(["patch", "--stdin", "--write"], `*** Begin Patch
*** Update File: ${a}
@@
-old a
+new a
*** Update File: ${b}
@@
-missing
+new b
*** End Patch
`);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "PATCH_HUNK_FAILED");
  assert.equal(readFileSync(a, "utf8"), "old a\n");
  assert.equal(readFileSync(b, "utf8"), "old b\n");
});

test("patch failure and parse failure prevent writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  const jsonFile = join(dir, "config.json");
  writeFileSync(a, "old a\n");
  writeFileSync(b, "old b\n");
  writeFileSync(jsonFile, "{\n  \"value\": 1\n}\n");

  const failed = runFail(["patch", "--from-stdin", "--write"], `--- ${a}
+++ ${a}
@@ -1 +1 @@
-old a
+new a
--- ${b}
+++ ${b}
@@ -1 +1 @@
-missing
+new b
`);
  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "PATCH_HUNK_FAILED");
  assert.equal(readFileSync(a, "utf8"), "old a\n");
  assert.equal(readFileSync(b, "utf8"), "old b\n");

  const parseFailed = runFail(["patch", "--from-stdin", "--write"], `--- ${jsonFile}
+++ ${jsonFile}
@@ -1,3 +1,3 @@
 {
-  "value": 1
+  "value": }
 }
`);
  assert.equal(parseFailed.status, 1);
  assert.equal(parseFailed.body.code, "PARSE_BROKEN_AFTER_EDIT");
  assert.deepEqual(JSON.parse(readFileSync(jsonFile, "utf8")), { value: 1 });
});

test("actions lists base actions for every file and language actions when available", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const textFile = join(dir, "notes.txt");
  const jsxFile = join(dir, "Page.tsx");
  writeFileSync(textFile, "hello\n");
  writeFileSync(jsxFile, fixture());

  const baseOnly = JSON.parse(run(["actions", textFile, "--json"]));
  const jsx = JSON.parse(run(["actions", jsxFile, "--json"]));

  assert.ok(baseOnly.actions.includes("edit.replace"));
  assert.equal(baseOnly.rules.length, 1);
  assert.ok(jsx.actions.includes("edit.replace"));
  assert.ok(jsx.actions.includes("rename"));
});

test("chain-workspace can run base edit steps inside a file scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "timeout: 3000\n");

  const result = JSON.parse(run([
    "chain-workspace",
    "in", file, "edit", "--find", "timeout: 3000", "--replace", "timeout: 5000",
    "--write"
  ]));

  assert.equal(result.success, true);
  assert.equal(readFileSync(file, "utf8"), "timeout: 5000\n");
});

test("single-file chain can create a file before JSX actions", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");

  const result = JSON.parse(run([
    "chain", file,
    "create", "--source", "export function Page() { return <main><Button>Save</Button></main>; }",
    "::", "find", "Button", "as", "button",
    "::", "prop.set", "@button", "data-created", "true",
    "--write"
  ]));

  assert.equal(result.success, true);
  assert.match(readFileSync(file, "utf8"), /<Button data-created>Save<\/Button>/);
});

test("single-file chain can mix base edit and JSX actions", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, `export function Page() {
  return <Button>Save</Button>;
}
`);

  const result = JSON.parse(run([
    "chain", file,
    "edit", "--find", "Save", "--replace", "Confirm",
    "::", "find", "Button", "as", "button",
    "::", "prop.set", "@button", "data-edited", "true",
    "--write"
  ]));

  assert.equal(result.success, true);
  assert.match(readFileSync(file, "utf8"), /<Button data-edited>Confirm<\/Button>/);
});

test("className conflict guardrail reports static JSX utility conflicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, `export function Page() {
  return <input className="w-full w-9 text-sm text-red-500" />;
}
`);

  const result = JSON.parse(run(["verify-file", file, "--json"]));
  const warning = result.warnings.find((item) => item.code === "CLASSNAME_CONFLICT");

  assert.ok(warning);
  assert.equal(warning.group, "width");
  assert.equal(warning.element, "input");
  assert.deepEqual(warning.classes, ["w-full", "w-9"]);
  assert.ok(!result.warnings.some((item) => item.group === "text-color"));
});

test("className conflict guardrail splits text size and text color", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const okFile = join(dir, "TextOk.tsx");
  const conflictFile = join(dir, "TextConflict.tsx");
  writeFileSync(okFile, `export function TextOk() {
  return <>
    <span className="text-text-3 text-[10px]" />
    <span className="text-[14px] text-text-1" />
    <input className="text-[12px] text-primary" />
    <span className="text-[14px] text-[var(--text-color)]" />
  </>;
}
`);
  writeFileSync(conflictFile, `export function TextConflict() {
  return <>
    <span className="text-sm text-[14px]" />
    <span className="text-primary text-text-1" />
    <span className="text-[#fff] text-primary" />
  </>;
}
`);

  const ok = JSON.parse(run(["verify-file", okFile, "--json"]));
  const conflict = JSON.parse(run(["verify-file", conflictFile, "--json"]));

  assert.deepEqual(ok.warnings, []);
  assert.ok(conflict.warnings.some((item) => item.group === "text-size" && item.classes.includes("text-sm") && item.classes.includes("text-[14px]")));
  assert.ok(conflict.warnings.some((item) => item.group === "text-color" && item.classes.includes("text-primary") && item.classes.includes("text-text-1")));
  assert.ok(conflict.warnings.some((item) => item.group === "text-color" && item.classes.includes("text-[#fff]") && item.classes.includes("text-primary")));
});

test("className conflict guardrail uses axis overlap for spacing and positioning utilities", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const okFile = join(dir, "AxisOk.tsx");
  const conflictFile = join(dir, "AxisConflict.tsx");
  writeFileSync(okFile, `export function AxisOk() {
  return <div className="px-2 py-3 mt-2 mb-4 gap-x-2 gap-y-4 inset-x-0 top-2 border-x border-y rounded-t rounded-b" />;
}
`);
  writeFileSync(conflictFile, `export function AxisConflict() {
  return <div className="p-4 px-2 pr-6 gap-4 gap-x-2 inset-0 top-2 border border-x-2 rounded rounded-tl-lg" />;
}
`);

  const ok = JSON.parse(run(["verify-file", okFile, "--json"]));
  const conflict = JSON.parse(run(["verify-file", conflictFile, "--json"]));

  assert.deepEqual(ok.warnings, []);
  assert.ok(conflict.warnings.some((item) => item.group === "padding" && item.classes.includes("p-4") && item.classes.includes("px-2") && item.classes.includes("pr-6")));
  assert.ok(conflict.warnings.some((item) => item.group === "gap" && item.classes.includes("gap-4") && item.classes.includes("gap-x-2")));
  assert.ok(conflict.warnings.some((item) => item.group === "inset" && item.classes.includes("inset-0") && item.classes.includes("top-2")));
  assert.ok(conflict.warnings.some((item) => item.group === "border-width" && item.classes.includes("border") && item.classes.includes("border-x-2")));
  assert.ok(conflict.warnings.some((item) => item.group === "border-radius" && item.classes.includes("rounded") && item.classes.includes("rounded-tl-lg")));
});

test("className conflict guardrail does not flag mutually exclusive ternary branches", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, `export function Page({ selected }) {
  return <input className={selected ? "w-full" : "w-9"} />;
}
`);

  const result = JSON.parse(run(["verify-file", file, "--json"]));
  assert.deepEqual(result.warnings, []);
});

test("className conflict guardrail honors project config groups and disable flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const configDir = join(dir, ".tedit");
  const file = join(dir, "Page.tsx");
  mkdirp(configDir);
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    classNameConflicts: {
      groups: {
        area: ["area-"]
      }
    }
  }, null, 2));
  writeFileSync(file, `export function Page() {
  return <section className="area-main area-sidebar" />;
}
`);

  const configured = JSON.parse(run(["verify-file", file, "--json"]));
  assert.equal(configured.warnings.find((item) => item.group === "area").code, "CLASSNAME_CONFLICT");

  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    classNameConflicts: {
      enabled: false,
      groups: {
        area: ["area-"]
      }
    }
  }, null, 2));

  const disabled = JSON.parse(run(["verify-file", file, "--json"]));
  assert.deepEqual(disabled.warnings, []);
});

test("compact mutation output includes className conflict warnings", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, `export function Page() {
  return <input className="w-full" />;
}
`);

  const compact = JSON.parse(runRaw([
    "edit", file,
    "--find", 'className="w-full"',
    "--replace", 'className="w-full w-9"',
    "--dry-run"
  ]));

  assert.equal(compact.ok, true);
  assert.equal(compact.warnings[0].code, "CLASSNAME_CONFLICT");
  assert.equal(compact.warnings[0].group, "width");
  assert.equal(compact.files[0].warnings[0].code, "CLASSNAME_CONFLICT");
});

test("file length guardrail reports threshold crossings without blocking dry-run", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const configDir = join(dir, ".tedit");
  const file = join(dir, "notes.txt");
  mkdirp(configDir);
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    file_length_thresholds: { info: 3, warn: 5, urgent: 7 }
  }));
  writeFileSync(file, "one\ntwo");

  const result = JSON.parse(run(["edit", file, "--find", "two", "--replace", "two\nthree", "--json"]));

  assert.equal(result.success, true);
  assert.equal(result.written, false);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "FILE_LENGTH_INFO");
  assert.equal(readFileSync(file, "utf8"), "one\ntwo");
});

test("analyze-state groups co-used useState bindings", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, stateAnalysisFixture());

  const result = JSON.parse(run(["analyze-state", file, "--json"]));
  const crewCluster = result.clusters.find((cluster) => cluster.name === "crewImport");

  assert.equal(result.states_total, 3);
  assert.ok(crewCluster);
  assert.deepEqual(crewCluster.states, ["crewImportOpen", "crewImportDayId"]);
  assert.equal(crewCluster.recommendation, "custom-hook");
});

test("analyze-state warns when a giant cluster is likely over-clustered", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, giantStateClusterFixture());

  const result = JSON.parse(run(["analyze-state", file, "--json"]));
  const guidance = result.guidance?.[0];
  const cluster = result.clusters[0];

  assert.equal(cluster.recommendation, "context");
  assert.equal(cluster.confidence, "low");
  assert.ok(guidance);
  assert.equal(guidance.code, "STATE_CLUSTER_TOO_LARGE");
  assert.equal(guidance.states_count, 9);
  assert.ok(guidance.large_handlers.some((handler) => handler.name === "handleBootstrap"));
  assert.ok(guidance.suggested_subclusters.some((subcluster) => {
    return subcluster.name === "alpha" && subcluster.states.includes("alphaOpen") && subcluster.states.includes("alphaCount");
  }));
  assert.match(guidance.next_step_hint, /alpha|handleBootstrap|Page/);
});

test("refactor-state groups a selected cluster into object state", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  writeFileSync(file, refactorStateFixture());

  const result = JSON.parse(run(["refactor-state", file, "--cluster", "crewImport", "--write"]));
  const updated = readFileSync(file, "utf8");

  assert.equal(result.success, true);
  assert.equal(result.state_object, "crewImportState");
  assert.match(updated, /const \[crewImportState, setCrewImportState\] = useState\(\{/);
  assert.doesNotMatch(updated, /const \[crewImportOpen/);
  assert.match(updated, /crewImportState\.crewImportOpen/);
  assert.match(updated, /setCrewImportState\(previous => \(\{/);
  assert.match(updated, /crewImportOpen: true/);
});

test("refactor-state plan-out writes a validated custom hook plan and apply-plan applies it", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const hook = join(dir, "useCrewImport.ts");
  const planPath = join(dir, ".tedit", "plans", "crew-import.json");
  writeFileSync(file, refactorStateFixture());

  const planResult = JSON.parse(run(["refactor-state", file, "--cluster", "crewImport", "--to", hook, "--name", "useCrewImport", "--plan-out", planPath]));

  assert.equal(planResult.success, true);
  assert.equal(planResult.kind, "refactor-state-plan");
  assert.equal(planResult.mode, "custom-hook");
  assert.equal(planResult.source, file);
  assert.equal(planResult.target, hook);
  assert.deepEqual(planResult.steps.map((step) => step.id), ["create-hook-file", "update-source-hook-call"]);
  assert.equal(existsSync(hook), false);
  assert.doesNotMatch(readFileSync(file, "utf8"), /useCrewImport/);

  const inspect = JSON.parse(run(["plan", "inspect", planPath, "--json"]));
  assert.equal(inspect.success, true);
  assert.equal(inspect.kind, "refactor-state-plan");
  assert.equal(inspect.mode, "custom-hook");
  assert.equal(inspect.stale, false);
  assert.equal(inspect.steps_total, 2);
  assert.match(run(["plan", "inspect", planPath]), /refactor-state-plan \(custom-hook\): 2 steps, 0 high risk, ready/);

  const dryRun = JSON.parse(run(["apply-plan", planPath, "--dry-run"]));
  assert.equal(dryRun.success, true);
  assert.equal(dryRun.written, false);
  assert.match(dryRun.files.find((entry) => entry.step === "update-source-hook-call").diff, /useCrewImport/);
  assert.match(dryRun.files.find((entry) => entry.step === "create-hook-file").diff, /export function useCrewImport/);
  assert.equal(existsSync(hook), false);

  const partial = runFail(["apply-plan", planPath, "--skip", "create-hook-file", "--write"]);
  assert.equal(partial.status, 1);
  assert.equal(partial.body.code, "PLAN_PARTIAL_UNSUPPORTED");
  assert.equal(existsSync(hook), false);

  const applied = JSON.parse(run(["apply-plan", planPath, "--write"]));
  assert.equal(applied.written, true);
  assert.ok(readFileSync(file, "utf8").includes("const crewImport = useCrewImport();"));
  assert.ok(readFileSync(hook, "utf8").includes("export function useCrewImport()"));
});

test("refactor-state extracts a selected cluster into a custom hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const hook = join(dir, "useCrewImport.ts");
  writeFileSync(file, refactorStateFixture());

  const result = JSON.parse(run(["refactor-state", file, "--cluster", "crewImport", "--to", hook, "--name", "useCrewImport", "--write"]));
  const updated = readFileSync(file, "utf8");
  const created = readFileSync(hook, "utf8");

  assert.equal(result.success, true);
  assert.equal(result.mode, "custom-hook");
  assert.equal(result.hook_name, "useCrewImport");
  assert.match(updated, /import \{ useCrewImport \} from "\.\/useCrewImport";/);
  assert.match(updated, /const crewImport = useCrewImport\(\);/);
  assert.doesNotMatch(updated, /const openImport =/);
  assert.match(updated, /crewImport\.openImport\("d1"\)/);
  assert.match(updated, /crewImport\.crewImportOpen/);
  assert.match(created, /import \{ useState \} from "react";/);
  assert.match(created, /export function useCrewImport\(\)/);
  assert.match(created, /const \[crewImportState, setCrewImportState\] = useState\(\{/);
  assert.match(created, /const openImport = \(dayId: string\) =>/);
  assert.match(created, /return \{\n\s+\.\.\.crewImportState,\n\s+openImport\n\s+\};/);
});

test("refactor-state custom hook extraction fails atomically on external handler dependencies", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const hook = join(dir, "useCrewImport.ts");
  const original = refactorStateWithExternalDependencyFixture();
  writeFileSync(file, original);

  const failed = runFail(["refactor-state", file, "--cluster", "crewImport", "--to", hook, "--name", "useCrewImport", "--write"]);

  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "STATE_REFACTOR_EXTERNAL_DEPENDENCY");
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(existsSync(hook), false);
});


test("refactor-state can pass external handler dependencies as hook params", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const hook = join(dir, "useCrewImport.ts");
  writeFileSync(file, refactorStateWithExternalDependencyFixture());

  const result = JSON.parse(run(["refactor-state", file, "--cluster", "crewImport", "--to", hook, "--name", "useCrewImport", "--external-deps", "params", "--write"]));
  const updated = readFileSync(file, "utf8");
  const created = readFileSync(hook, "utf8");

  assert.deepEqual(result.external_dependencies, ["defaultDayId"]);
  assert.match(updated, /const crewImport = useCrewImport\(defaultDayId\);/);
  assert.match(created, /export function useCrewImport\(defaultDayId\)/);
  assert.match(created, /crewImportDayId: defaultDayId/);
});
test("extract refuses prop overflow by default and allows explicit override", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "Page.tsx");
  const out = join(dir, "PageCard.tsx");
  writeFileSync(file, propOverflowExtractFixture());

  const failed = runFail(["extract", file, "section", "--to", out, "--name", "PageCard", "--max-props", "2"]);
  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "EXTRACT_PROPS_OVERFLOW");
  assert.equal(failed.body.details.props_count, 3);
  assert.equal(existsSync(out), false);

  const result = JSON.parse(run(["extract", file, "section", "--to", out, "--name", "PageCard", "--max-props", "2", "--accept-large-props", "--write"]));
  assert.equal(result.success, true);
  assert.equal(result.props.length, 3);
  assert.equal(existsSync(out), true);
});

test("git-aware default stays dry-run outside git and explains why", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "old\n");

  const result = JSON.parse(run(["edit", file, "--find", "old", "--replace", "new", "--json"]));

  assert.equal(result.written, false);
  assert.equal(result.write_policy.mode, "auto-dry-run");
  assert.match(result.write_policy.notes[0], /no git repository/);
  assert.equal(readFileSync(file, "utf8"), "old\n");
});

test("explicit write outside git creates a manifest-backed backup before mutating", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "old\n");

  const result = JSON.parse(run(["edit", file, "--find", "old", "--replace", "new", "--write", "--json"]));

  assert.equal(result.written, true);
  assert.match(result.write_policy.backup, /\.tedit-cache\/backups\//);
  assert.ok(result.write_policy.backup_id);
  assert.equal(existsSync(file + ".tedit.bak"), false);
  assert.equal(readFileSync(result.write_policy.backup, "utf8"), "old\n");
  assert.equal(readFileSync(file, "utf8"), "new\n");

  const list = JSON.parse(runInCwd(["backups", "list"], dir));
  assert.equal(list.backups.length, 1);
  assert.equal(list.backups[0].id, result.write_policy.backup_id);
  assert.equal(list.backups[0].original, realpathSync(file));
  assert.ok(list.backups[0].replacement_hash);

  writeFileSync(file, "changed again\n");
  const dryRestore = JSON.parse(runInCwd(["backups", "restore", result.write_policy.backup_id], dir));
  assert.equal(dryRestore.restored, false);
  assert.equal(readFileSync(file, "utf8"), "changed again\n");

  const restore = JSON.parse(runInCwd(["backups", "restore", result.write_policy.backup_id, "--write"], dir));
  assert.equal(restore.restored, true);
  assert.equal(readFileSync(file, "utf8"), "old\n");

  const cleanDryRun = JSON.parse(runInCwd(["backups", "clean", "--older-than", "0ms"], dir));
  assert.equal(cleanDryRun.deleted, 0);
  assert.equal(cleanDryRun.cleaned.length, 1);
  assert.equal(existsSync(result.write_policy.backup), true);

  const clean = JSON.parse(runInCwd(["backups", "clean", "--older-than", "0ms", "--write"], dir));
  assert.equal(clean.deleted, 1);
  assert.equal(existsSync(result.write_policy.backup), false);
  assert.equal(JSON.parse(runInCwd(["backups", "list"], dir)).backups.length, 0);
});

test("git tracked files default to write without an explicit --write", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "tracked.txt");
  writeFileSync(file, "old\n");
  git(["init"], dir);
  git(["config", "user.email", "tedit@example.test"], dir);
  git(["config", "user.name", "tedit"], dir);
  git(["add", "tracked.txt"], dir);
  git(["commit", "-m", "initial"], dir);

  const result = JSON.parse(run(["edit", file, "--find", "old", "--replace", "new", "--json"]));

  assert.equal(result.written, true);
  assert.equal(result.write_policy.mode, "auto-write");
  assert.equal(result.write_policy.git.tracked, true);
  assert.equal(result.write_policy.backup, undefined);
  assert.equal(readFileSync(file, "utf8"), "new\n");
});

test("git ignored files default to dry-run unless write is explicit", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "ignored.txt");
  git(["init"], dir);
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  writeFileSync(file, "old\n");

  const result = JSON.parse(run(["edit", file, "--find", "old", "--replace", "new", "--json"]));

  assert.equal(result.written, false);
  assert.equal(result.write_policy.mode, "auto-dry-run");
  assert.equal(result.write_policy.git.ignored, true);
  assert.equal(readFileSync(file, "utf8"), "old\n");
});

function run(args) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: detailedEnv(),
  });
}

function runWithInput(args, input) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    input,
    env: detailedEnv(),
  });
}

function runRaw(args, input) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    env: rawEnv(),
  });
}

function runRawInCwd(args, cwd, input) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd,
    ...(input === undefined ? {} : { input }),
    env: rawEnv(),
  });
}

function runInCwd(args, cwd) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd,
    env: detailedEnv(),
  });
}

function runFail(args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    input,
    env: detailedEnv(),
  });
  return {
    status: result.status,
    body: JSON.parse(result.stderr || result.stdout),
  };
}

function detailedEnv() {
  return { ...process.env, FORCE_COLOR: "0", TEDIT_OUTPUT: "detailed" };
}

function rawEnv() {
  const env = { ...process.env, FORCE_COLOR: "0" };
  delete env.TEDIT_OUTPUT;
  return env;
}

function mkdirp(path) {
  execFileSync("mkdir", ["-p", path]);
}

function git(args, cwd) {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function giantStateClusterFixture() {
  return `import { useState } from "react";

export function Page() {
  const [alphaOpen, setAlphaOpen] = useState(false);
  const [alphaCount, setAlphaCount] = useState(0);
  const [betaOpen, setBetaOpen] = useState(false);
  const [betaCount, setBetaCount] = useState(0);
  const [gammaOpen, setGammaOpen] = useState(false);
  const [gammaCount, setGammaCount] = useState(0);
  const [deltaOpen, setDeltaOpen] = useState(false);
  const [deltaCount, setDeltaCount] = useState(0);
  const [epsilonOpen, setEpsilonOpen] = useState(false);

  const handleBootstrap = () => {
    setAlphaOpen(true);
    setAlphaCount(alphaCount + 1);
    setBetaOpen(true);
    setBetaCount(betaCount + 1);
    setGammaOpen(true);
    setGammaCount(gammaCount + 1);
    setDeltaOpen(true);
    setDeltaCount(deltaCount + 1);
    setEpsilonOpen(true);
  };

  return <main>{alphaOpen}{betaOpen}{gammaOpen}{deltaOpen}{epsilonOpen}{alphaCount}{betaCount}{gammaCount}{deltaCount}</main>;
}
`;
}

function refactorStateFixture() {
  return `import { useState } from "react";

export function Page() {
  const [crewImportOpen, setCrewImportOpen] = useState(false);
  const [crewImportDayId, setCrewImportDayId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const openImport = (dayId: string) => {
    setCrewImportOpen(true);
    setCrewImportDayId(dayId);
  };

  return (
    <main>
      <button onClick={() => openImport("d1")}>Open</button>
      <span>{crewImportOpen ? crewImportDayId : "closed"}</span>
    </main>
  );
}
`;
}

function refactorStateWithExternalDependencyFixture() {
  return `import { useState } from "react";

export function Page({ defaultDayId }: { defaultDayId: string }) {
  const [crewImportOpen, setCrewImportOpen] = useState(false);
  const [crewImportDayId, setCrewImportDayId] = useState<string | null>(null);

  const openImport = () => {
    setCrewImportOpen(true);
    setCrewImportDayId(defaultDayId);
  };

  return (
    <main>
      <button onClick={openImport}>Open</button>
      <span>{crewImportOpen ? crewImportDayId : "closed"}</span>
    </main>
  );
}
`;
}

function stateAnalysisFixture() {
  return `import { useState } from "react";

export function Page() {
  const [crewImportOpen, setCrewImportOpen] = useState(false);
  const [crewImportDayId, setCrewImportDayId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleCrewImport = (dayId: string) => {
    setCrewImportOpen(true);
    setCrewImportDayId(dayId);
    console.log(crewImportOpen, crewImportDayId);
  };

  return <button onClick={() => handleCrewImport("day-1")}>{isLoading ? "Loading" : "Import"}</button>;
}
`;
}

function propOverflowExtractFixture() {
  return `export function Page() {
  const title: string = "Title";
  const description: string = "Description";
  const count: number = 3;

  return (
    <section>
      <h1>{title}</h1>
      <p>{description}</p>
      <span>{count}</span>
    </section>
  );
}
`;
}

function conditionalConsequentFixture() {
  return `export function Page() {
  return (
    <Shell
      mainHeader={
        showHeader ? (
          // keep this comment
          <PageHead title="hello" />
        ) : undefined
      }
    >
      <ScrollArea className="x" viewportClassName="gap-4">
        <Body />
      </ScrollArea>
    </Shell>
  );
}
`;
}

function assertUnchangedConditionalConsequent(source) {
  assert.match(source, /showHeader \? \(\n          \/\/ keep this comment\n          <PageHead title="hello" \/>\n        \) : undefined/);
  assert.doesNotMatch(source, /\(<PageHead title="hello" \/>\)/);
}

function structuralSelectorFixture() {
  return `export function Selectors({ cond }) {
  return (
    <ContentView>
      <ScrollArea data-area="body" />
      <DialogFooter>
        <Button variant="secondary" />
        <Button variant="primary" />
      </DialogFooter>
      <Card data-card="with-image">
        <Image />
      </Card>
      <Card data-card="without-image">
        <Text />
      </Card>
      <RadioGroup>
        <>
          <Radio value="a" />
        </>
        <Radio value="b" />
      </RadioGroup>
      {cond && <InlinePanel />}
    </ContentView>
  );
}
`;
}

function expressionHelpersFixture() {
  return `export function ExpressionHelpers({ cond, ready, open, label }) {
  return (
    <Panel>
      {cond && <InlinePanel />}
      {ready ? <ReadyPanel /> : null}
      {open ? <OpenPanel /> : null}
      <Label value={label} />
    </Panel>
  );
}
`;
}

function chainFixture() {
  return `export function Page() {
  return (
    <main>
      <ScrollArea viewportClassName="px-7">
        <DailyPlanBody />
      </ScrollArea>
    </main>
  );
}
`;
}

function extractFixture() {
  return `import { Card, CardHeader, CardBody } from "@/ui/card";
import { Button } from "@/ui/button";

export function Page({ pageTitle, description, handleEdit }) {
  return (
    <main>
      <Card className="p-4 rounded-xl border">
        <CardHeader title={pageTitle} />
        <CardBody>
          <p>{description}</p>
          <Button onClick={handleEdit}>Edit</Button>
        </CardBody>
      </Card>
    </main>
  );
}
`;
}

function typedExtractFixture() {
  return `import { Card, CardHeader, CardBody } from "@/ui/card";
import { Button } from "@/ui/button";

type PageProps = {
  pageTitle: string;
  description?: string;
  handleEdit: (status: "draft" | "done") => void;
};

export function Page({ pageTitle, description, handleEdit }: PageProps) {
  const status: "draft" | "done" = "draft";
  return (
    <main>
      <Card className="p-4 rounded-xl border">
        <CardHeader title={pageTitle} />
        <CardBody>
          <p>{description}</p>
          <Button onClick={() => handleEdit(status)}>Edit</Button>
        </CardBody>
      </Card>
    </main>
  );
}
`;
}

function expressionInferenceExtractFixture() {
  return `import { Card } from "@/ui/card";

export function Page() {
  const label = "Launch";
  const count = 3;
  const enabled = true;
  const staticMessage = \`Ready\`;
  const tags = ["alpha", "beta"];
  const meta = { id: 1, active: false };
  return (
    <main>
      <Card>
        <p>{label}</p>
        <span>{count}</span>
        <span>{enabled}</span>
        <span>{staticMessage}</span>
        <span>{tags.join(",")}</span>
        <span>{meta.id}</span>
      </Card>
    </main>
  );
}
`;
}

function useStateInferenceExtractFixture() {
  return `import { useState } from "react";
import { Card } from "@/ui/card";

export function Page() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <main>
      <Card>
        <button onClick={() => setSelectedId(selectedId)}>Pick</button>
        <span>{selectedId}</span>
      </Card>
    </main>
  );
}
`;
}

function checkerExtractFixture() {
  return `import { Card } from "@/ui/card";

export function Page({ pageTitle }: { pageTitle: string }) {
  const inferredCount = pageTitle.length;
  const isLong = inferredCount > 4;
  return (
    <main>
      <Card>
        <p>{pageTitle}</p>
        <span>{inferredCount}</span>
        <span>{isLong}</span>
      </Card>
    </main>
  );
}
`;
}

function namedSlotExtractFixture() {
  return `import { Card, CardHeader, CardBody } from "@/ui/card";

export function Page({ icon, description }) {
  return (
    <Card>
      <CardHeader>
        <Title icon={icon} />
      </CardHeader>
      <CardBody>
        <p>{description}</p>
      </CardBody>
    </Card>
  );
}
`;
}

function helperExtractFixture() {
  return `import { Card, CardHeader } from "@/ui/card";

function formatTitle(value) {
  return value.toUpperCase();
}

function sharedLabel(value) {
  return value.trim();
}

export function Page({ pageTitle }) {
  const footer = sharedLabel("footer");
  return (
    <main>
      <Card>
        <CardHeader title={formatTitle(pageTitle)} />
        <p>{sharedLabel(pageTitle)}</p>
      </Card>
      <span>{footer}</span>
    </main>
  );
}
`;
}

function helperDependencyExtractFixture() {
  return `import { Card, CardHeader } from "@/ui/card";
import { titleCase } from "@/text";

function normalizeTitle(value) {
  return value.trim();
}

function formatTitle(value) {
  return titleCase(normalizeTitle(value));
}

export function Page({ pageTitle }) {
  return (
    <main>
      <Card>
        <CardHeader title={formatTitle(pageTitle)} />
      </Card>
    </main>
  );
}
`;
}

function multiSharedHelperExtractFixture() {
  return `import { Card, CardHeader } from "@/ui/card";

function formatTitle(value) {
  return value.toUpperCase();
}

function formatStatus(value) {
  return value.trim();
}

export function Page({ pageTitle, status }) {
  const outsideTitle = formatTitle("outside");
  const outsideStatus = formatStatus("outside");
  return (
    <main>
      <Card>
        <CardHeader title={formatTitle(pageTitle)} />
        <p>{formatStatus(status)}</p>
      </Card>
      <span>{outsideTitle}</span>
      <span>{outsideStatus}</span>
    </main>
  );
}
`;
}

function fixture() {
  return `import React from "react";

export function Page({ items }) {
  return (
    <main>
      <section className="today-card">
        <TodoList items={items} />
      </section>
    </main>
  );
}
`;
}
