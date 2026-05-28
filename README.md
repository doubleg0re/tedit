# tedit

`tedit` is a tree-aware structural editor for source and document formats.

The first adapter edits JSX/TSX. The long-term target is JSX, HTML, XML, Markdown, and MDX through one CLI, JS API, and JSON flow format.

## Architecture

`tedit` is rule-based. The CLI resolves a file to a rule by extension, then runs actions through that rule's adapter.

Current rule:

- `base`: every file, universal `edit`, `write`, `multiedit`, and `patch` primitives with exact, fuzzy, anchor, regex, line-range matching, and lightweight JSON/Markdown verification
- `jsx`: `.js`, `.jsx`, `.ts`, `.tsx`

Planned rules:

- `fdx`: Final Draft XML
- `html`
- `xml`
- `markdown`
- `mdx`

The flow engine is intentionally format-agnostic. JSX-specific parsing, printing, selector matching, and AST mutation live under `src/rules/jsx`.

## Examples

```bash
tedit --version
tedit help verify
tedit edit README.md --find "old text" --replace "new text" --dry-run
tedit edit README.md --find-fuzzy "old text with spacing drift" --replace "new text" --write
tedit edit src/config.ts --find-anchor-after "const config =" --find "timeout: 3000" --replace "timeout: 5000" --write
tedit edit styles.css --find-regex '\bred\b' --replace blue --replace-all --expect-count 2 --write
tedit edit notes.txt --find-lines 10:12 --delete --write
tedit write package.json --from-file ./generated/package.json --overwrite --write
tedit multiedit ./edits.json --write
tedit verify ./edits.json --diff-out ./edits.diff
tedit patch ./change.patch --dry-run --quiet --diff-out ./patch.diff
tedit actions src/Page.tsx --json
tedit analyze-state src/Page.tsx --json
tedit refactor-state src/Page.tsx --cluster crewImport --to src/useCrewImport.ts --name useCrewImport --external-deps params --write
tedit find src/Page.tsx 'main' --json
tedit inspect src/Page.tsx --id jsx_1 --json
tedit append src/Page.tsx 'main' --element '{"tag":"PageHead"}' --dry-run
tedit rename src/Page.tsx 'ScrollArea[viewportClassName="px-7 pb-20 pt-1"]' --to div --dry-run
tedit prop set src/Page.tsx 'Button[variant="primary"]' disabled true --dry-run
tedit prop set src/Page.tsx 'Button[variant="primary"]' onClick --expr 'handleClick' --dry-run
tedit prop remove src/Page.tsx 'Dialog[open]' open --dry-run
tedit find src/Page.tsx 'ContentView ScrollArea' --json
tedit find src/Page.tsx 'DialogFooter > Button[variant="primary"]' --json
tedit find src/Page.tsx 'Card:has(Image)' --json
tedit imports add src/Page.tsx --from '@/components/ui/button' --named Button,IconButton --dry-run
tedit imports remove src/Page.tsx --from '@/components/ui/scroll-area' --named ScrollArea --dry-run
tedit expr replace src/Page.tsx 'ContentView :expr' --code 'cond ? <Panel /> : null' --dry-run
tedit expr wrap src/Page.tsx 'Label :expr' --code 'String($expr)' --dry-run
tedit expr toTernary src/Page.tsx 'Panel :expr:has(InlinePanel)' --alternate '<FallbackPanel />' --dry-run
tedit expr toShortCircuit src/Page.tsx 'Panel :expr:has(ReadyPanel)' --dry-run
tedit text set src/Page.tsx 'Button[variant="primary"]' --value "확인" --write
tedit text set src/Page.tsx 'Button[variant="primary"]' --expr 't("confirm")' --write
tedit text replace src/Page.tsx 'DialogFooter > Button' --match-text "저장" --with-text "확인" --write
tedit text replace src/Page.tsx 'Button' --match-expr 't("save")' --with-expr 't("confirm")' --write
tedit insertComment src/Page.tsx 'main' "Generated page controls" --position inside-start
tedit flow src/Page.tsx ./edit-flow.json --write
tedit chain src/Page.tsx find main as body :: append '@body' PageHead :: append '$ret.id' LeftPanel --write
tedit chain src/Page.tsx edit --find "DEFAULT_TIMEOUT = 3000" --replace "DEFAULT_TIMEOUT = 5000" :: find Button as btn :: prop.set '@btn' data-edited true --write
tedit chain src/Page.tsx find main as body :: append '@body' 'Button.variant="primary".disabled.children="Save"' --write
tedit chain src/Page.tsx --from-file ./edit.chain --write
tedit extract src/Page.tsx Card --to src/components/PageCard.tsx --name PageCard --slot 'CardBody.children' --write
tedit workspace-flow ./workspace-flow.json --write
tedit chain-workspace extract src/Page.tsx Card --to src/components/PageCard.tsx --name PageCard :: in src/components/PageCard.tsx prop.set Card data-extracted true --write
tedit create src/components/Button.tsx --source 'export function Button() { return <button />; }' --write
tedit scaffold src/components/Button.tsx --directives 'use client' --imports '@/lib/utils:cn' --export 'function:Button(props)' --body 'button.className={cn("btn")}.children="Save"' --write
tedit new react-client-component src/components/Card.tsx --param name=Card --write
```

## MCP Server

`tedit` also ships a stdio MCP server for agent hosts. The CLI remains
unchanged for humans, CI, and shell workflows; MCP is the lower-friction
agent surface over the same core edit, multiedit, patch, workspace-flow,
and JSX mutation engines.

```json
{
  "mcpServers": {
    "tedit": {
      "command": "node",
      "args": ["/path/to/tedit/dist/mcp.js"]
    }
  }
}
```

The package bin also exposes `tedit-mcp`, so installed packages can use the
server without a source checkout. `npm run pack:check` packs the artifact and
smoke-checks the installed bins before publish: required `dist` files, bin
shebang and executable mode, package size, backup/postinstall exclusions,
`npx -y --package <tgz> tedit --version`, and packed `tedit-mcp` stdio
startup:

```json
{
  "mcpServers": {
    "tedit": {
      "command": "tedit-mcp"
    }
  }
}
```

The MCP tool names are underscore-style equivalents of the CLI and flow
actions: `edit`, `multiedit`, `patch`, `write_file`, `create_file`,
`scaffold_file`, `new_file`, `actions`, `analyze_state`, `verify_file`,
`refactor_state`, `extract_plan`, `apply_plan`, `chain_workspace`, `find`,
`inspect`, `append`,
`prepend`, `wrap`, `unwrap`, `remove`, `rename`, `prop_set`,
`prop_remove`, `text_set`, `text_replace`, `insert_comment`,
`imports_add`, `imports_remove`, `imports_rename`, `imports_move`,
`expr_replace`, `expr_wrap`, `expr_unwrap`, `expr_to_ternary`,
`expr_to_short_circuit`, and `extract`.

Mutating MCP tools default to compact machine-readable results for agent loops:
`success`, `ok`, `summary`, `changed`, `written`, `files`, parser
verification fields, and a `next` array only when there is a deterministic
follow-up such as applying a dry-run. Pass `output: "detailed"`, `includeDiffs: true`, or
`includeDetails: true` to retrieve full diffs, matches, and write-policy
diagnostics. Failures use the same structured tedit fields where possible,
including `ok: false`, `code`, `error`, `details`, and actionable `next`
hints.

## Best Fit

Use `tedit` when the edit is structural or repetitive enough that line-based editing is brittle:

- Mechanical JSX refactors such as `ScrollArea` to `div`.
- Adding or removing props across matched components.
- Multi-step AI-agent edits where selectors, actions, and diffs are easier to validate than raw generated code.

For one-off local edits, a normal editor or patch is usually faster.

Flow files use a compact `action`/`out` shape:

```json
{
  "info": {
    "name": "add-page-head"
  },
  "flow": [
    { "comment": "Find the page body" },
    { "action": "find", "selector": "main", "out": "body" },
    {
      "action": "append",
      "target": "{{body}}",
      "element": { "tag": "PageHead" },
      "out": "head"
    },
    {
      "action": "insertComment",
      "target": "{{head}}",
      "position": "inside-start",
      "text": "Generated page controls"
    },
    {
      "action": "append",
      "target": "{{head}}",
      "element": { "tag": "LeftPanel" }
    }
  ]
}
```

Mechanical refactor example:

```json
{
  "info": { "name": "replace-scrollarea" },
  "flow": [
    {
      "action": "find",
      "selector": "ScrollArea[viewportClassName=\"px-7 pb-20 pt-1\"]",
      "out": "scrollArea"
    },
    {
      "action": "rename",
      "target": "{{scrollArea}}",
      "name": "div"
    },
    {
      "action": "prop.remove",
      "target": "{{scrollArea}}",
      "name": "viewportClassName"
    },
    {
      "action": "prop.set",
      "target": "{{scrollArea}}",
      "name": "className",
      "value": "px-7 pb-20 pt-1"
    }
  ]
}
```

Structural selectors support CSS-style tag/id/class syntax, descendant,
child, adjacent-sibling, and general-sibling constraints, JSX `className`
matching, quoted or unquoted attribute values, member-component names, scoped
relative `:has(...)`, and common pseudos:

```bash
tedit find src/Page.tsx 'ContentView ScrollArea'
tedit find src/Page.tsx 'DialogFooter > Button[variant="primary"]'
tedit find src/Page.tsx 'Label + Input'
tedit find src/Page.tsx 'Label ~ Hint'
tedit find src/Page.tsx 'main:has(:scope > h2 + p)'
tedit find src/Page.tsx 'a[href^="https://example.com"][rel~="help"]'
tedit find src/Page.tsx 'a[data-kind=docs-card]'
tedit find src/Page.tsx 'div#hero.card'
tedit find src/Page.tsx '.primary'
tedit find src/Page.tsx 'Card.Header.title'
tedit find src/Page.tsx 'Card:has(Image)'
tedit find src/Page.tsx 'div:has(> br)'
tedit find src/Page.tsx 'Card:not(:has(Image))'
tedit find src/Page.tsx 'Radio:nth-of-type(2)'
tedit find src/Page.tsx 'ContentView :expr'
```

Import and expression-container edits can live in the same flow as JSX edits:

```json
{
  "flow": [
    { "action": "imports.remove", "from": "@/components/ui/scroll-area", "named": ["ScrollArea"] },
    { "action": "imports.add", "from": "@/components/ui/button", "named": ["IconButton"] },
    { "action": "find", "selector": "ContentView :expr", "out": "condition" },
    { "action": "expr.replace", "target": "{{condition}}", "code": "cond ? <Panel /> : null" },
    { "action": "expr.wrap", "target": "{{condition}}", "code": "isReady ? $expr : null" }
  ]
}
```

Text edits are first-class JSX mutations. `text.set` replaces all
children of the target element, converting self-closing elements when
needed. `text.replace` only swaps matching direct text/expression
children, so siblings like icons stay intact. Text matches trim
whitespace-only JSX formatting around the label.

```bash
tedit text set src/Button.tsx 'Button[variant="primary"]' --value "확인" --write
tedit text set src/Button.tsx 'Button' --expr 't("confirm")' --write
tedit text replace src/Button.tsx 'Button' --match-text "저장" --with-text "확인" --write
tedit text replace src/Button.tsx 'Button' --match-expr 't("save")' --with-expr 't("confirm")' --write
```

When neither `--write` nor `--dry-run` is passed, mutation commands use
git-aware default write mode. Tracked files inside a git working tree
write immediately; ignored files or files outside git default to dry-run
with a warning. Explicit `--write` and `--dry-run` always win.

Set `TEDIT_DEFAULT_WRITE=true|false|auto` to force a default. Explicit
writes that overwrite files outside git create manifest-backed backups under
`.tedit-cache/backups/<id>/<relative-file>.bak` by default. Use
`tedit backups list`, `tedit backups restore <id> [--write]`, and
`tedit backups clean --older-than 7d [--write]` to inspect, restore, and
clean them; restore and clean are dry-run by default. Use `--backup` or
`TEDIT_BACKUP=always` to force backup creation, `--no-backup` or
`TEDIT_BACKUP=never` to disable it, and `TEDIT_BACKUP_STYLE=sidecar` for
the compatibility `<file>.tedit.bak` layout.

## Universal Base Edit

`tedit edit` works on every file, including extensions that do not have
a language rule yet. It patches only the matched source range. For
registered language rules such as JSX/TSX, JSON files, and Markdown
files, the edited result is parsed or lightly verified before writing;
parse failures return `PARSE_BROKEN_AFTER_EDIT` and leave the file
untouched. Unknown extensions remain bytes-only and report
`parse_verified: false`, `parse_skipped: true`, and
`parse_skip_reason: "unsupported_extension"` so agents can distinguish a
parser skip from a parse failure. Use `verify-file` to run the same parser
coverage against the current file without planning an edit.

```bash
tedit verify-file src/config.json --json
tedit verify-file README.md
```

```bash
tedit edit README.md --find "old text" --replace "new text"
tedit edit README.md --find "old text" --insert-before "prefix "
tedit edit README.md --find "old text" --insert-after " suffix"
tedit edit README.md --find "old text" --delete
tedit edit README.md --find-file old.txt --replace-file new.txt
tedit edit README.md --find "old text" --replace-stdin < new.txt
tedit edit README.md --find-stdin --replace "new text" < old.txt
tedit edit README.md --spec edit.json
```

Matching is strict by default: one match is required unless
`--replace-all` is present. `--expect-count N` adds an explicit count
guard for mass edits.

```bash
tedit edit styles.css --find-regex '\bred\b' --replace blue --replace-all --expect-count 2 --write
```

When exact matching fails, `tedit` tries a whitespace-insensitive fuzzy
fallback only for diagnostics. A single fuzzy candidate returns
`MATCH_FUZZY_ONLY` instead of guessing; opt in with `--find-fuzzy`:

```bash
tedit edit src/file.ts --find-fuzzy 'const answer = 42;' --replace 'const answer = 43;' --write
```

Use anchors or line ranges when text is not globally unique:

```bash
tedit edit src/config.ts --find-anchor-after "const config =" --find "timeout: 3000" --replace "timeout: 5000" --write
tedit edit notes.txt --find-lines 10:12 --delete --write
```

`--spec` accepts a single base-edit object, a single-item array, or
`{ "edits": [oneEdit] }`. That shape uses the same field names as
`multiedit`, so long or multiline edits can avoid shell quoting:

```json
{
  "find": "old\nblock",
  "replace": "new\nblock",
  "expectCount": 1
}
```

`tedit actions [file] --json` lists the base actions plus any actions
from the file's language rule. In workspace chains, base edits can run
inside an `in <file>` step:

```bash
tedit chain-workspace in src/config.ts edit --find "timeout: 3000" --replace "timeout: 5000" --write
```

## Agent Edit Primitives

`write`, `multiedit`, and `patch` expose ordinary agent editing
operations through the same write policy, backup behavior, JSON output,
file-length warnings, and final parse verification used by the rest of
`tedit`.

`write` is the whole-file primitive. It accepts the same source inputs as
`create`, refuses to overwrite existing files unless `--overwrite` is
explicit, and verifies JSON, Markdown, and registered language files
before writing:

```bash
tedit write src/config.json --source '{"timeout":5000}' --write
tedit write src/config.json --from-file generated/config.json --overwrite --write
tedit write src/config.json --from-stdin --overwrite --write < generated/config.json
tedit write src/config.json --from-file generated/config.json --dry-run --quiet --diff-out config.diff
```

`create`, `write`, `scaffold`, and `new` share the same quiet and diff side-file
behavior as edits, so agents can verify generated files without streaming the
full file body through stdout.

`multiedit` applies many universal base edits as one atomic operation.
Same-file edits see the in-memory result of earlier edits, and no file is
written if any later edit, count check, or final parse verification fails:

```json
{
  "edits": [
    { "file": "README.md", "find": "Status: draft", "replace": "Status: reviewed" },
    { "file": "src/config.ts", "findAnchorAfter": "const config =", "find": "timeout: 3000", "replace": "timeout: 5000" },
    { "file": "styles.css", "findRegex": "\\bred\\b", "replace": "blue", "replaceAll": true, "expectCount": 2 }
  ]
}
```

```bash
tedit multiedit ./edits.json --dry-run
tedit multiedit ./edits.json --dry-run --summary
tedit multiedit ./edits.json --dry-run --summary=edits
tedit multiedit ./edits.json --dry-run --quiet
tedit verify ./edits.json --diff-out ./edits.diff
tedit multiedit ./edits.json --write
tedit multiedit --from-stdin --write < ./edits.json
```

`--summary` keeps dry-run/write output terse: one status line per file by
default, or one status line per edit with `--summary=edits`, without diff,
file-content, or git-status payloads. `--quiet` emits nothing on success, and
`--diff-out <file>` writes the detailed diff to a side file. `verify` is an
explicit dry-run wrapper for multiedit specs.

`patch` applies unified diffs when the diff is already decided. It
supports file updates, additions, deletes, and renames, checks hunk
context before writing, and keeps the whole patch atomic on failure.
It auto-detects unified diff input and Codex apply-patch input:

```bash
tedit patch ./change.patch --dry-run
tedit patch ./change.patch --write
tedit patch --from-stdin --write < ./change.patch
tedit patch --stdin --write < ./change.patch
```

Codex apply-patch input can be sent directly through stdin:

```bash
tedit patch --stdin --write <<'PATCH'
*** Begin Patch
*** Add File: notes.txt
+hello
+world
*** Update File: README.md
@@
-Status: draft
+Status: reviewed
*** End Patch
PATCH
```

## Extract Component

`extract` moves a selected JSX subtree into a new component file, adds
an import at the call site, replaces the original subtree with the new
component usage, and returns a structured JSON result even on dry-run.

```bash
tedit extract src/Page.tsx Card \
  --to src/components/PageCard.tsx \
  --name PageCard \
  --write
```

Full extract turns every outer-scope reference used inside the selected
subtree into a prop:

```tsx
<PageCard pageTitle={pageTitle} description={description} />
```

Slot extract leaves chosen inner content at the call site while moving
the shell into the new component:

```bash
tedit extract src/Page.tsx Card \
  --to src/components/PageCard.tsx \
  --name PageCard \
  --slot 'CardBody.children' \
  --write
```

Named slots use `--slot '<selector>.children=<propName>'` and become
explicit `ReactNode` props in the extracted component:

```bash
tedit extract src/Page.tsx Card \
  --to src/components/PageCard.tsx \
  --name PageCard \
  --slot 'CardHeader.children=header' \
  --slot 'CardBody.children' \
  --write
```

`extract` refuses to overwrite the destination file unless
`--overwrite` is present. It transfers imports used by the extracted
shell into the new file and removes those imports from the source when
the source no longer references them.

If `--depth N` is passed without explicit slots, `extract` fails with
`EXTRACT_SLOT_REQUIRED` and returns suggested `--slot` candidates. This
keeps slot boundaries explicit. Add `--auto-slot` to accept those
suggestions intentionally:

```bash
tedit extract src/Page.tsx Card \
  --to src/components/PageCard.tsx \
  --name PageCard \
  --depth 1 \
  --auto-slot \
  --write
```

File-level helpers referenced by the shell use the default `ask` policy:
shell-only helpers move into the new file, including shell-only helper
dependencies and their imports. Helpers still referenced in the source
would create a module cycle if the extracted file imported them back
from the source, so `extract` fails with `SHARED_HELPER_CYCLE`. Use
`--helper name=as-prop` for an explicit prop fallback, or move that
helper to a separate shared module first. Use `--helpers
move|share|ask|as-prop` or repeated
`--helper name=move|share|leave|as-prop` for overrides.

For riskier refactors, generate a reviewable plan first and apply it as a
separate step. `apply-plan` revalidates source and target hashes, re-runs the
refactor planner, and defaults to dry-run unless `--write` is passed:

```bash
tedit extract src/Page.tsx Card \
  --to src/components/PageCard.tsx \
  --name PageCard \
  --plan-out .tedit/plans/extract-card.json

tedit plan inspect .tedit/plans/extract-card.json
tedit plan inspect .tedit/plans/extract-card.json --json

tedit apply-plan .tedit/plans/extract-card.json --dry-run --diff-out extract.diff
tedit apply-plan .tedit/plans/extract-card.json --write
```

Plan steps can be filtered when reviewing high-risk helper movement. Skipping a
`move-helper-*` step passes that helper as a prop instead of moving it:

```bash
tedit apply-plan .tedit/plans/extract-card.json --skip move-helper-formatTitle --write
```

Prop types are inferred from clear TypeScript annotations on
destructured component props, local variables, or function signatures.
Add `--typecheck` to ask the TypeScript checker for inferred expression
types such as `number` from `title.length`; if TypeScript is not
available, the result JSON reports `inference_mode:
"checker-unavailable"` and falls back to the AST-only path. Unresolved
types stay `unknown` with a `// TODO(tedit): infer type` marker.

`extract` refuses to create oversized prop surfaces by default. The
default max is 12 props, configurable through `.tedit/config.json` via
`max_extract_props`. If the predicted prop count is higher, it returns
`EXTRACT_PROPS_OVERFLOW` with prop names and `analyze-state` clusters.
Use `--max-props N` for a run-specific threshold, or
`--accept-large-props` to make the design tradeoff explicit.

```bash
tedit extract src/Page.tsx DailyPlanBody \
  --to src/DailyPlanBody.tsx \
  --name DailyPlanBody \
  --max-props 16
```

## Quality Guardrails

Every mutation result can include file-length warnings. Warnings are
passive: they do not block writes, and they fire only when an edit
crosses a configured threshold.

```json
{
  "file_length_thresholds": {
    "info": 500,
    "warn": 1000,
    "urgent": 2000
  },
  "max_extract_props": 12,
  "defaultWrite": "auto"
}
```

`analyze-state` inspects React `useState` bindings, the handlers that
read/write them, and connected clusters that may deserve a custom hook
before extraction:

```bash
tedit analyze-state src/Page.tsx --json
```

`refactor-state` can apply a conservative object-state refactor for one
selected cluster. Without `--to`, it keeps the refactor in the same component.
With `--to` and `--name`, it extracts simple local handlers and selected state
into a generated custom hook. Both modes fail rather than guessing on
functional setters or external handler dependencies:

```bash
tedit refactor-state src/Page.tsx --cluster crewImport --write
tedit refactor-state src/Page.tsx --cluster crewImport --to src/useCrewImport.ts --name useCrewImport --write
```

## Workspace Flow

Use `workspace-flow` when one operation needs to touch more than one
file, such as extracting a component and then mutating the created
component file. It keeps the original single-file `flow <file>` model
unchanged and runs multi-file edits through a transaction: dry-run is
the default, JSON output includes per-file diffs, and if any later step
fails no file is written.

```json
{
  "flow": [
    {
      "action": "extract",
      "from": "src/Page.tsx",
      "selector": "Card",
      "to": "src/components/PageCard.tsx",
      "name": "PageCard",
      "typecheck": true,
      "out": "extracted"
    },
    {
      "action": "chain",
      "file": "src/components/PageCard.tsx",
      "steps": [
        { "action": "find", "selector": "Card", "out": "card" },
        { "action": "prop.set", "target": "{{card}}", "name": "data-extracted", "value": true }
      ]
    }
  ]
}
```

```bash
tedit workspace-flow ./workspace-flow.json --write
```

`chain-workspace` is the compact form. `extract` creates or patches
files, and `in <file>` runs ordinary chain actions against that file:

```bash
tedit chain-workspace \
  extract src/Page.tsx Card --to src/components/PageCard.tsx --name PageCard --typecheck \
  :: in src/components/PageCard.tsx find Card as card \
  :: in src/components/PageCard.tsx prop.set '@card' data-extracted true \
  --write
```

Like single-file `chain`, `chain-workspace` can read line-based input:

```text
# workspace.chain
extract src/Page.tsx Card --to src/components/PageCard.tsx --name PageCard --typecheck
in src/components/PageCard.tsx find Card as card
in src/components/PageCard.tsx prop.set @card data-extracted true
```

```bash
tedit chain-workspace --from-file ./workspace.chain --write
tedit chain-workspace --from-stdin --write < ./workspace.chain
```

## File Creation

`create`, `scaffold`, and `new` apply the same dry-run and overwrite discipline to file genesis. They refuse to overwrite an existing file unless `--overwrite` is present, and they parse the generated source through the file's rule before writing.

```bash
tedit create src/Button.tsx --source 'export function Button() { return <button />; }' --write
tedit create src/Button.tsx --from-file templates/button.tsx --write
tedit create src/Button.tsx --from-stdin --write < templates/button.tsx
```

`scaffold` accepts either a JSON spec or compact CLI flags:

```bash
tedit scaffold src/Button.tsx \
  --directives 'use client' \
  --imports '@/lib/utils:cn' \
  --imports 'react:type ReactNode' \
  --export 'function:Button(props: { children: ReactNode })' \
  --body 'button.className={cn("btn")}.children="Save"' \
  --write
```

`new` resolves templates from `./.tedit/templates`, `~/.tedit/templates`, then built-in starters. Templates are scaffold specs with `{{param}}` substitution.

```bash
tedit new react-client-component src/Card.tsx --param name=Card --write
tedit new server-action src/actions/save.ts --param name=saveDraft --write
```

## Current Limitations

- Selector support covers tag/component selectors, CSS-style `#id` and `.class` shorthand, quoted or unquoted attributes including `=`, `*=`, `^=`, `$=`, `~=`, and `|=`, `A B`, `A > B`, `A + B`, `A ~ B`, `:scope`, scoped `:has(...)` including `:has(> B)` and `:has(+ B)`, `:not(...)`, `:first-child`, `:last-child`, `:nth-of-type(n)`, and `:expr`. Unsupported pseudo-classes and pseudo-elements fail with explicit diagnostics.
- JSX mutations use surgical source patch paths for original source nodes, including `rename`, `prop.set`, `prop.remove`, `wrap`, `append`, `prepend`, `unwrap`, `remove`, and `insertComment`.
- Mutations that target nodes created earlier in the same in-memory flow may still fall back to recast because generated nodes do not have original source spans.
- Import edits and expression-container edits use source patches, but complex multi-line import formatting is normalized to a one-line import declaration when the declaration itself is rewritten.
- `expr.toShortCircuit` and `expr.unwrap` only convert ternaries whose alternate is `null`, `false`, or `undefined`.
- `extract` supports full extract plus explicit `.children` slots. `--depth` without explicit slots deliberately fails with suggested slots; `--auto-slot` opts into the generated slots.
- Extracted prop type inference is conservative. It handles clear TypeScript annotations by default, simple literals/arrays/objects/template literals and explicit `useState<T>` generics, handles local checker inference with `--typecheck`, then falls back to `unknown` with `// TODO(tedit): infer type` markers when the source does not carry a reliable type.
- Quality guardrails currently cover file-length threshold warnings, `analyze-state` over-cluster guidance with suggested subclusters, extract prop overflow, and conservative `refactor-state` application for simple clusters. Custom hook extraction keeps failing by default on external handler dependencies, but `--external-deps params` can explicitly thread those values into the generated hook.
- File creation is available through `create`, `write`, `scaffold`, and `new`; single-file `chain` can also start with `create --source ...` before structural or base edits.
- Base `edit` is available as a standalone command, inside `workspace-flow` / `chain-workspace`, and mixed into single-file `chain` with JSX actions.
- `patch` supports unified diff and Codex apply-patch file updates, additions, deletes, and renames.
- Default write mode is git-aware. Outside git, commands still dry-run unless `--write` is explicit, and explicit overwrites create manifest-backed backups under `.tedit-cache/backups` by default. Sidecar `.tedit.bak` backups remain available with `TEDIT_BACKUP_STYLE=sidecar`.
- Scaffold shorthand is intentionally shallow. Use `--spec` JSON for nested children and complex props.
- For PR-quality diffs, inspect `--dry-run` output carefully until more mutation types get surgical patch implementations.

## Inline Chaining

`chain` is the compact CLI form of a flow file. It uses `::` between inline actions, supports `$ret` references to the previous action result, and supports `as <name>` plus `@name` for reusable named outputs.

```bash
tedit chain src/Page.tsx \
  find 'ScrollArea[viewportClassName="px-7"]' as sa \
  :: rename '@sa' --to div \
  :: find DailyPlanBody as body \
  :: wrap '@body' --with 'div.flex.gap-4' \
  :: prop.set '@sa' data-testid --expr testId \
  --write
```

Chain steps accept the same flag form as standalone commands. Element
arguments accept JSON, CSS-style shorthand (`div#id.class`), or the older
dot-attr shorthand for values such as `children`:

```bash
tedit chain src/Page.tsx find main as root :: wrap '@root' 'div#content.flex.gap-4[data-testid="body"]'
tedit chain src/Page.tsx find main as root :: append '@root' 'Button[variant="primary"][disabled]'
tedit chain src/Page.tsx find main as root :: append '@root' 'Button.variant="primary".disabled.onClick={handleClick}.children="Save"'
```

For longer chains, use line-based input. Blank lines are ignored, `#` starts a comment, and `::` is implicit between lines:

```text
find ScrollArea[viewportClassName="px-7"] as sa
rename @sa --to div
prop.remove @sa viewportClassName
find DailyPlanBody as body
wrap @body --with div.flex.gap-4
```

```bash
tedit chain src/Page.tsx --from-file ./edit.chain --write
tedit chain src/Page.tsx --from-stdin --write < ./edit.chain
```

Quote `$ret` in the shell so it reaches `tedit` unchanged. `@name` does not need shell quoting in normal shells.
