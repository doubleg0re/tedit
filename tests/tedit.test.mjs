import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const mcp = new URL("../dist/mcp.js", import.meta.url).pathname;

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
      <section />
      <section />
    </main>
  );
}
`);

  const failed = runFail(["wrap", file, "section", "--with", "Card", "--write"]);
  assert.equal(failed.status, 1);
  assert.equal(failed.body.code, "AMBIGUOUS_SELECTOR");
  assert.match(failed.body.error, /matched 2 nodes/);
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
  assert.match(cardSource, /function Card\(props\)/);
  assert.equal(JSON.parse(run(["find", builtIn, "div", "--json"])).matches.length, 1);

  const templateDir = join(dir, ".tedit", "templates");
  const templatePath = join(templateDir, "named.tedit-template.json");
  mkdirp(templateDir);
  writeFileSync(templatePath, JSON.stringify({
    exports: [
      { kind: "function", name: "{{name}}", body: { tag: "section", attributes: { "data-name": "{{name}}" } } }
    ]
  }));

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

test("rules command exposes the jsx rule", () => {
  const result = JSON.parse(run(["rules", "--json"]));
  assert.equal(result.success, true);
  assert.equal(result.rules[0].name, "jsx");
  assert.deepEqual(result.rules[0].extensions, [".js", ".jsx", ".ts", ".tsx"]);
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
  writeFileSync(file, "# Title\nold value\n");
  writeFileSync(jsxFile, chainFixture());
  writeFileSync(jsonFile, "{\"enabled\":true}\n");
  writeFileSync(extractFile, extractFixture());

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcp],
    stderr: "pipe",
  });
  const client = new Client({ name: "tedit-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "edit"));
    assert.ok(tools.tools.some((tool) => tool.name === "chain_workspace"));
    assert.ok(tools.tools.some((tool) => tool.name === "verify_file"));
    assert.ok(tools.tools.some((tool) => tool.name === "extract_plan"));
    assert.ok(tools.tools.some((tool) => tool.name === "apply_plan"));
    assert.ok(tools.tools.some((tool) => tool.name === "write_file"));
    assert.ok(tools.tools.some((tool) => tool.name === "create_file"));
    assert.ok(tools.tools.some((tool) => tool.name === "scaffold_file"));
    assert.ok(tools.tools.some((tool) => tool.name === "new_file"));

    const actionsDiscovery = await client.callTool({
      name: "actions",
      arguments: {},
    });
    assert.equal(actionsDiscovery.isError, undefined);
    assert.ok(actionsDiscovery.structuredContent.actions.includes("multiedit"));
    assert.ok(actionsDiscovery.structuredContent.actions.includes("patch"));
    assert.ok(actionsDiscovery.structuredContent.actions.includes("create_file"));
    assert.ok(actionsDiscovery.structuredContent.actions.includes("verify_file"));
    assert.ok(actionsDiscovery.structuredContent.tools.some((tool) => tool.name === "multiedit"));

    const result = await client.callTool({
      name: "edit",
      arguments: { file, find: "old value", replace: "new value", write: true },
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.success, true);
    assert.equal(result.structuredContent.written, true);
    assert.equal(result.structuredContent.ok, true);
    assert.match(result.structuredContent.summary, /1 file written/);
    assert.equal(result.structuredContent.files[0].path, file);
    assert.equal(result.structuredContent.files[0].diffAvailable, true);
    assert.equal(result.structuredContent.diff, undefined);
    assert.equal(result.structuredContent.write_policy, undefined);
    assert.equal(result.structuredContent.next, undefined);
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
    assert.ok(Array.isArray(failedEdit.structuredContent.next));
    assert.ok(failedEdit.structuredContent.next.length > 0);

    const writeFileResult = await client.callTool({
      name: "write_file",
      arguments: { file: mcpWriteFile, source: "{\"ok\":true}\n", write: true },
    });
    assert.equal(writeFileResult.isError, undefined);
    assert.equal(writeFileResult.structuredContent.parser, "json");
    assert.equal(writeFileResult.structuredContent.files[0].change, "create");
    assert.match(writeFileResult.structuredContent.summary, /1 file written; parse verified with json/);
    assert.equal(readFileSync(mcpWriteFile, "utf8"), "{\"ok\":true}\n");

    const createFileResult = await client.callTool({
      name: "create_file",
      arguments: { file: mcpCreateFile, source: "# Created\n", write: true },
    });
    assert.equal(createFileResult.isError, undefined);
    assert.equal(createFileResult.structuredContent.parser, "markdown-lite");
    assert.equal(createFileResult.structuredContent.files[0].change, "create");
    assert.equal(readFileSync(mcpCreateFile, "utf8"), "# Created\n");

    const scaffoldResult = await client.callTool({
      name: "scaffold_file",
      arguments: {
        file: mcpScaffoldFile,
        spec: { exports: [{ kind: "function", name: "Scaffolded", body: { tag: "section" } }] },
        write: true,
      },
    });
    assert.equal(scaffoldResult.isError, undefined);
    assert.equal(scaffoldResult.structuredContent.parser, "jsx");
    assert.match(readFileSync(mcpScaffoldFile, "utf8"), /export function Scaffolded/);

    const newFileResult = await client.callTool({
      name: "new_file",
      arguments: { file: mcpNewFile, template: "react-client-component", params: { name: "ClientCard" }, write: true },
    });
    assert.equal(newFileResult.isError, undefined);
    assert.equal(newFileResult.structuredContent.parser, "jsx");
    assert.match(readFileSync(mcpNewFile, "utf8"), /export function ClientCard/);

    const wrapResult = await client.callTool({
      name: "wrap",
      arguments: { file: jsxFile, selector: "DailyPlanBody", with: 'div.flex.gap-4', write: true },
    });

    assert.equal(wrapResult.isError, undefined);
    assert.equal(wrapResult.structuredContent.success, true);
    assert.match(readFileSync(jsxFile, "utf8"), /<div className="flex gap-4"><DailyPlanBody \/><\/div>/);

    const verifyResult = await client.callTool({
      name: "verify_file",
      arguments: { file: jsonFile },
    });
    assert.equal(verifyResult.isError, undefined);
    assert.equal(verifyResult.structuredContent.parse_verified, true);
    assert.equal(verifyResult.structuredContent.parser, "json");

    const planResult = await client.callTool({
      name: "extract_plan",
      arguments: { from: extractFile, selector: "Card", to: extractOut, name: "PageCard", planOut: extractPlan },
    });
    assert.equal(planResult.isError, undefined);
    assert.equal(planResult.structuredContent.kind, "extract-component-plan");
    assert.equal(existsSync(extractOut), false);

    const applyResult = await client.callTool({
      name: "apply_plan",
      arguments: { plan: extractPlan, write: true },
    });
    assert.equal(applyResult.isError, undefined);
    assert.equal(applyResult.structuredContent.written, true);
    assert.match(readFileSync(extractOut, "utf8"), /export function PageCard/);
  } finally {
    await client.close();
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
  assert.deepEqual(failed.body.details.fuzzy_candidates[0].whitespace_drift.requested_runs, [1, 1, 1]);
  assert.equal(readFileSync(file, "utf8"), original);
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

test("base edit line ranges can delete full lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "lines.txt");
  writeFileSync(file, "a\nb\nc\n");

  run(["edit", file, "--find-lines", "2:2", "--delete", "--write"]);

  assert.equal(readFileSync(file, "utf8"), "a\nc\n");
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
  const textFile = join(dir, "notes.txt");
  writeFileSync(jsonFile, "{\"enabled\":true}\n");
  writeFileSync(markdownFile, "# Notes\n\n```ts\nconst ok = true;\n```\n");
  writeFileSync(textFile, "plain\n");

  const json = JSON.parse(run(["verify-file", jsonFile, "--json"]));
  const markdown = JSON.parse(run(["verify-file", markdownFile, "--json"]));
  const text = JSON.parse(run(["verify-file", textFile, "--json"]));

  assert.equal(json.parse_verified, true);
  assert.equal(json.parser, "json");
  assert.equal(markdown.parse_verified, true);
  assert.equal(markdown.parser, "markdown-lite");
  assert.equal(text.parse_verified, false);
  assert.equal(text.parser, undefined);
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
  assert.equal(result.files.length, 2);
  assert.equal(jsonParse.parse_verified, true);
  assert.equal(jsonParse.parser, "json");
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
  assert.doesNotMatch(output, /^--- /m);
  assert.equal(readFileSync(file, "utf8"), "old\n");
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
    "edit", "multiedit", "verify", "verify-file", "patch", "actions", "analyze-state",
    "refactor-state", "find", "inspect", "append", "prepend", "wrap",
    "unwrap", "remove", "rename", "insertComment", "text", "prop",
    "imports", "expr", "extract", "apply-plan", "create", "write", "scaffold", "new",
    "flow", "workspace-flow", "wflow", "chain", "chain-workspace", "wchain",
    "rules", "backups"
  ];
  for (const topic of topics) {
    const topicHelp = run(["help", topic]);
    assert.match(topicHelp, /^tedit /, topic);
    assert.doesNotMatch(topicHelp, /Unknown help topic/, topic);
  }
});

test("cli non-tty defaults to compact output and detailed override keeps legacy diff text", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "old\n");

  const compact = JSON.parse(runRaw(["edit", file, "--find", "old", "--replace", "new", "--dry-run"]));

  assert.equal(compact.success, true);
  assert.equal(compact.ok, true);
  assert.equal(compact.changed, true);
  assert.equal(compact.written, false);
  assert.match(compact.summary, /1 file would change/);
  assert.equal(compact.files[0].path, file);
  assert.equal(compact.files[0].diffAvailable, true);
  assert.equal(compact.diff, undefined);
  assert.deepEqual(compact.next, ["rerun with write=true to apply"]);
  assert.equal(readFileSync(file, "utf8"), "old\n");

  const detailed = runRaw(["edit", file, "--find", "old", "--replace", "new", "--dry-run", "--output", "detailed"]);
  assert.match(detailed, /^--- /m);
  assert.match(detailed, /\+new/);
});

test("cli non-tty failures use compact error output", () => {
  const dir = mkdtempSync(join(tmpdir(), "tedit-"));
  const file = join(dir, "notes.txt");
  writeFileSync(file, "old\n");

  const failed = spawnSync(process.execPath, [cli, "edit", file, "--find", "missing", "--replace", "new"], {
    encoding: "utf8",
    env: rawEnv(),
  });
  const body = JSON.parse(failed.stderr);

  assert.equal(failed.status, 1);
  assert.equal(body.success, false);
  assert.equal(body.ok, false);
  assert.equal(body.code, "MATCH_NONE");
  assert.match(body.summary, /No match found/);
  assert.equal(body.details, undefined);
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
