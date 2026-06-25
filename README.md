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
tedit search-text "삭제" src --glob "**/*.tsx" --context 2 --multiedit-spec --replace "Delete" --json
tedit inspect-range src/Page.tsx --lines 42:42 --context 3 --json
tedit history-trace src/Page.tsx --lines 42:60 --json
tedit scan-strings src/Page.tsx --contains "삭제" --json
tedit ast-select src/Page.tsx 'ObjectProperty[key.name="label"] > StringLiteral' --json
tedit ast-edit src/Page.tsx --string "삭제" --replace "Delete" --dry-run
tedit ast-edit src/Page.tsx --call toast.error --replace "Failed" --dry-run
tedit templates --json
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

## Install And Agent Setup

Install from npm for normal CLI and MCP usage:

```bash
npm install -g tedit
tedit --version
tedit actions --json
```

For MCP hosts, register the installed bin:

```json
{
  "mcpServers": {
    "tedit": {
      "command": "tedit-mcp"
    }
  }
}
```

Without a global install, use `npx`:

```json
{
  "mcpServers": {
    "tedit": {
      "command": "npx",
      "args": ["-y", "--package", "tedit@latest", "tedit-mcp"]
    }
  }
}
```

For copyable AGENTS/CLAUDE instructions and optional skill text, see
`docs/agent-setup.md`.

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
server without a source checkout. `npm run release:smoke` (also available as
`npm run pack:check`) packs the artifact and smoke-checks the installed bins
before publish: package metadata, required `dist` and docs files, bin shebang and
executable mode, package size, backup/postinstall exclusions,
`npx -y --package <tgz> tedit --version`, installed `tedit actions --json`,
and packed `tedit-mcp` stdio startup:

```json
{
  "mcpServers": {
    "tedit": {
      "command": "tedit-mcp"
    }
  }
}
```

For agent-adoption regression checks, `npm run dogfood:benchmark` runs a fixed
set of local scenarios and emits compact JSON with scenario count, pass count,
compact response count, retry-hint count, max compact-response bytes, and parse
guardrail count.

For rough tedit-vs-plain workload comparison, `npm run dogfood:compare` runs
the same small, medium, large, and guardrail edits through a tedit lane and a
plain file-operation lane. It reports wall time, operation count, input/output
bytes, and a proxy token estimate. The token estimate is not model usage; exact
model tokens require API or agent runtime usage logs.

Compact `search_text` output is intentionally terse: it returns a unique
`files` map, up to 20 slim `results` with `fileId` and `lineRange`, and the
optional `multiedit` handoff. Use CLI `--json` or MCP `output: "detailed"`
when full per-result context and edit suggestions are worth the extra output.

The MCP server keeps tool schemas stable for the life of the stdio connection,
but each tool call runs through a small `mcp-runner` subprocess that imports
the current `dist` files. Replacing `dist` therefore updates edit/multiedit/
patch/output behavior on the next MCP call without reconnecting. Tool name or
input-schema changes still require the client to reconnect or refresh tools.

Start with the MCP `actions` tool when an agent needs to choose an edit
strategy. It returns the current MCP profile, registered default tools,
advanced tools, file-specific rules, normalized `action` names for flow-style
aliases, and an agent-oriented `guidance` section. `tedit` intentionally does
not expose a plain `read_file` MCP tool yet: host/native Read remains better
for full file contents. Use `verify_file` for parser coverage and validity,
and use `select` when a file-type-aware TS/JS/Python/JSX/TSX target hint is
more useful than raw text.

The default MCP profile is `agent`, which keeps the callable tool list small
and intent-oriented:

`actions`, `select`, `edit`, `multiedit`, `patch`, `flow`, `delete_file`,
`rename_file`, `ts_select`, `ts_edit`, `ts_move`, `file_write`,
`inspect_range`, `search_text`, `read_detail`, `verify_file`, and `refactor`.

`select` is the common facade for TS/JS declarations, Python functions/classes,
JSX/TSX elements, and text fallback hints. `inspect_range` and `search_text`
bridge `sed`/`rg` style workflows into tedit's edit-ready structured results.
`verify_file` accepts either `file` or `files` and gives parser coverage plus
validity checks without trying to replace native Read.

`flow` runs ordered workflow steps from either JSON `steps` or CLI-style `chain` text; use it when a find-then-mutate sequence should stay in one transaction.

Use `file_write` with a required `mode` for whole-file writes:
`mode: "write"` for complete source replacement, `mode: "scaffold"` for
scaffold specs, and `mode: "template"` for built-in or project templates.

The `actions` response includes an agent workflow guide. The intended default
loop is:

- `select` for file-type-aware TS/JS/Python/JSX/TSX target discovery.
- `search_text` or `inspect_range` when the target is not certain yet.
- `read_detail` only when a compact response returns a `$detail` descriptor and its inline `preview` is not enough.
- `edit` for one localized replacement, insertion, deletion, regex, fuzzy, or
  line-range change.
- `multiedit` after `search_text` when the same change spans several places or
  files.
- `delete_file` or `rename_file` for one-file cleanup or moves without
  hand-authoring a patch envelope.
- `patch` only when the change already exists as a unified diff or apply-patch
  envelope.
- `file_write` for whole-file generation through `mode: "write"`,
  `mode: "scaffold"`, or `mode: "template"`.
- `verify_file` before or after edits when parser coverage matters; pass
  `files` to check several related files in one call. `.py` receives a
  syntax-only guard (`parser: "python-syntax"`), not structural Python rewriting.
- `refactor` for existing CLI refactor workflows from the default MCP profile:
  `kind: "state"`, `kind: "extract"`, or `kind: "apply-plan"`.
- `TEDIT_MCP_PROFILE=all` for AST, JSX/markup structural actions, templates,
  history, and fine-grained extract/refactor helpers.

Failure responses are part of the workflow: `MATCH_NONE`,
`MATCH_NOT_UNIQUE`, `PARSE_BROKEN_AFTER_EDIT`, `AST_MATCH_NONE`, and
`PATCH_HUNK_FAILED` include bounded `suggestions` so an agent can inspect,
narrow, or retry without guessing.

If `actions` lists a tool but the MCP host does not expose it as callable,
restart or refresh the MCP host. Running code changes are picked up by the
runner subprocess, but tool schema/name changes require the host to reload the
server.

Set `TEDIT_MCP_PROFILE=all` (or `TEDIT_MCP_EXPOSE_ADVANCED=true`) to expose
the advanced and legacy fine-grained tools as MCP tools too, including
`create_file`, `templates`, `history_trace`, `scan_strings`, `ast_select`,
`ast_edit`, `ts_select`, `ts_edit`, `ts_move`, `jsx_select`, `jsx_node`,
`jsx_attr`, `jsx_content`, `imports`, `extract_component`, `analyze_state`,
`refactor_state`, `apply_plan`, `chain_workspace`, `write_file`,
`scaffold_file`, `new_file`, `find`,
`inspect`, `append`, `prepend`, `wrap`, `unwrap`, `remove`, `rename`,
`prop_set`, `prop_remove`, `class_add`, `class_remove`, `class_replace`,
`text_set`, `text_replace`, `insert_comment`, `imports_add`,
`imports_remove`, `imports_rename`, `imports_move`, `expr_replace`,
`expr_wrap`, `expr_unwrap`, `expr_to_ternary`, `expr_to_short_circuit`,
`extract`, `extract_plan`, and `refactor_state_plan`.

In the `all` profile, `create_file` stays separate because no-overwrite
creation is a safety boundary. Use `extract_component` with `mode: "direct"`
for small confident extracts or `mode: "plan"` plus `apply_plan` for
reviewable refactors. Use `scan_strings` for hardcoded text audits before i18n
work, then narrow with `ast_select` and apply one safe string replacement with
`ast_edit`.

Mutating MCP tools are described as safer replacements for routine Edit, Write,
MultiEdit, and Patch calls when parser guardrails, dry-runs, git-aware write
policy, or deterministic retry hints are useful.

Mutating MCP tools also accept an optional post-write `verify` command. It is
off by default because every repository has different validation costs and
commands. Prefer argv arrays over shell strings when possible:

```json
{
  "file": "apps/web/src/app/book/layout.tsx",
  "find": "<LoginButtons variant=\"inline\" />",
  "replace": "<button onClick={() => startLogin()}>로그인</button>",
  "write": true,
  "verify": {
    "cmd": ["npx", "tsc", "-p", "apps/web/tsconfig.json", "--noEmit"],
    "timeoutMs": 30000,
    "rollbackOnFail": false
  }
}
```

`verify` may be a shell command string, an argv array, or an object with
`cmd`, optional `args`, `cwd`, `timeoutMs`, and `rollbackOnFail`. Verification
runs only after files are written. A failed verify returns the edit result with
`verify.passed: false`; recognized TypeScript compiler output also adds
`verify.diagnostics[]` entries with file, line, column, code, and message. When
`rollbackOnFail` is true, tedit restores the changed files from the pre-edit
snapshot.

Mutating MCP tools default to compact machine-readable results for agent loops:
`ok`, `kind`, `summary`, `changedCount`, `writtenCount`, `files[].path`,
`files[].change`, `files[].persisted`, parser verification fields, and a
`files[].diff` payload when a diff exists, plus a `next` array only when there
is a deterministic follow-up such as applying a dry-run. Compact discovery
output preserves primary payloads such as
`matches`, `node`, `actions`, `rules`, and parse verification fields. Pass
`diffMode: "off" | "stats" | "auto" | "full"` to control compact diff
verbosity; the default is `auto`, which inlines small diffs so agents can see
what changed without another round trip. `stats` keeps counts only. `auto`
returns a truncated preview for
large dry-runs; large writes also save the full diff under `.tedit-cache/diffs`
and return `files[].diff.path`. Compact output stores individual non-core fields
larger than `detailFieldMaxBytes` (default 4096 JSON bytes) under
`.tedit-cache/details` and returns a `$detail` descriptor with a bounded
`preview`. For arrays, use the descriptor's `readNext` or call `read_detail`
with `id`/`file`, optional `path`, `offset`, `limit`, `grep`, `lines`, or
`limitBytes` to fetch only the needed slice. Pass `output: "detailed"` or
`includeDetails: true` to retrieve legacy full results and write-policy
diagnostics. Failures use the same structured tedit fields where possible,
including `ok: false`, `kind: "error"`, `code`, `error`, and actionable
`suggestions`. Verbose failure details remain available through detailed output.

## Best Fit

Use `tedit` when the edit is structural or repetitive enough that line-based editing is brittle:

- Mechanical JSX refactors such as `ScrollArea` to `div`.
- Adding or removing props across matched components.
- Multi-step AI-agent edits where selectors, actions, and diffs are easier to validate than raw generated code.

For one-off local edits, a normal editor or patch is usually faster.

## Search And Inspect

`search-text` and `inspect-range` cover the common `rg`/`sed` workflow while
returning structured follow-ups for tedit edits:

```bash
tedit search-text "삭제" src --glob "**/*.tsx" --context 2 --multiedit-spec --replace "Delete" --json
tedit search-text --query 'alert\\(".*"\\)' src --regex --json
tedit inspect-range src/Page.tsx --lines 42:42 --context 3 --json
printf '  const label = "Delete";\n' | tedit edit src/Page.tsx --find-lines 42 --replace-stdin --write
```

`search-text` is intentionally a small built-in search bridge, not a full `rg`
replacement. It searches text files under the given paths, skips common noisy
directories such as `.git`, `node_modules`, `dist`, and `.tedit-cache`, accepts
a simple `--glob` filter (`*`, `**`, `?`, and comma braces such as
`**/*.{ts,tsx}`; spaces around brace alternatives are ignored), can include
nearby lines with `--context`, and returns candidates with `file`, `path`,
`match`, `range.line`, `range.column`, `preview`, `context`, `suggested`, and
`suggestions` fields. `suggestions[].tool` uses MCP tool names such as
`inspect_range`; when the CLI spelling differs, `suggestions[].cliCommand`
provides the matching CLI command such as `inspect-range`. Use `rg` for broad
exploratory search, and use `search-text` when the next step is likely a tedit
edit.

Pass `--multiedit-spec` to include a file-grouped `multiedit` draft. With
`--replace`, each searched file gets one `findExact` or `findRegex` edit with
`replaceAll` and `expectCount` filled from the search result count:

```bash
tedit search-text "삭제" src --glob "**/*.tsx" --multiedit-spec --replace "Delete" --json \
  | jq '.multiedit' \
  | tedit multiedit --from-stdin --dry-run
```

`inspect-range` shows line context, byte range, parser status, and a suggested
`edit --find-lines` follow-up for the requested range. `find-lines` replaces
whole lines; when a non-final line replacement omits the trailing newline, tedit
preserves the original line ending so the following line does not join onto it.

## History Trace

`history-trace` wraps the git commands agents usually hand-assemble before
risky edits:

```bash
tedit history-trace src/Page.tsx --lines 120:160 --json
tedit history-trace src/Page.tsx --contains "삭제" --json
tedit history-trace src/Page.tsx --regex 't\\(".*"\\)' --json
```

Line ranges use `git blame` plus `git log -L`. Literal text uses `git log -S`,
and regex uses `git log -G`. Results include the target, latest event, commit
list, blame groups for line ranges, and the exact git commands for deeper
manual inspection.

## AST String Scan

`tedit find` stays a JSX/markup structural selector. It is intentionally not a
project-wide string scanner. For hardcoded user-facing text in code, use the
AST tools:

```bash
tedit scan-strings src/Page.tsx --json
tedit scan-strings src/Page.tsx --contains "삭제" --json
tedit ast-select src/Page.tsx 'StringLiteral[value*="삭제"]' --json
tedit ast-select src/Page.tsx 'CallExpression[callee.name="alert"]' --json
tedit ast-select src/Page.tsx 'ObjectProperty[key.name="label"] > StringLiteral' --json
tedit ast-edit src/Page.tsx 'ObjectProperty[key.name="label"]' --replace "Delete" --write
tedit ast-edit src/Page.tsx --string "삭제" --replace "Delete" --write
tedit ast-edit src/Page.tsx --call alert --replace "Error" --write
tedit ast-edit src/Page.tsx --jsx-attr placeholder --replace "Search" --write
tedit ast-edit src/Page.tsx --jsx-text "저장" --replace "Save" --write
tedit ast-edit src/Page.tsx --object-key label --replace "Delete" --write
```

`scan-strings` covers JSX text, string JSX attributes, JS/TS string literals,
object values, call arguments, and no-expression template literals. It excludes
obvious technical strings by default, including import/export module paths,
`className`/`class`, ids/test ids, URLs, and file paths. Pass
`--include-excluded` to audit those skipped candidates with an `excludeReason`.

`ast-edit` is deliberately narrow: the selector or shortcut must match exactly
one editable string target, and writes still run through the same dry-run/write
policy, backup, diff, parse verification, and quality warnings as other tedit
mutations. Shortcuts include `--string`, `--contains`, `--jsx-text`,
`--jsx-attr`, `--object-key`, and `--call`. Dotted calls such as
`--call toast.error` target string arguments under that member call.

## TS Declaration Targeting

For large plain TS/JS modules, use declaration selectors when raw `old_string`
matching is too brittle:

```bash
tedit ts-select src/server.ts
tedit ts-select src/server.ts fn:apiGateMetadata --json
tedit ts-edit src/server.ts fn:apiGateMetadata --body $'\n  return buildMetadata();\n' --write
tedit ts-edit src/server.ts fn:startServer --insert-before $'function setup() {}\n' --write
tedit ts-move src/server.ts fn:apiGateMetadata --before fn:startServer --dry-run
tedit ts-move src/server.ts fn:apiGateMetadata --before fn:startServer --confirm-trivia --write
```

Selectors are intentionally narrow: `fn:name`, `class:Name`,
`method:Owner.name`, `prop:name`, `prop:Owner.name`, and `var:name`.
`ts-edit --body` replaces only the inside of the target block body; tedit owns
the outer braces and parse-verifies the result. `ts-move` is dry-run-first in
practice: write calls require `--confirm-trivia` after reviewing the carried
comment hints, with optional `--take trivia_id` / `--drop trivia_id` overrides.

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
tedit verify-file src/config.json README.md
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
guard for mass edits. Regex replacement text is literal: `$&`, `$1`, and
named backreferences are written as text rather than expanded like JavaScript
`String.replace` templates.

```bash
tedit edit styles.css --find-regex '\bred\b' --replace blue --replace-all --expect-count 2 --write
```

When exact matching fails, `tedit` tries a whitespace-insensitive fuzzy
fallback only for diagnostics. A single fuzzy candidate returns
`MATCH_FUZZY_ONLY` instead of guessing; the JSON error includes structured
`retry_hints` and top-level `suggestions` such as `--find-fuzzy` or
`--find-lines` so agents can retry deterministically. Opt in with
`--find-fuzzy`:

```bash
tedit edit src/file.ts --find-fuzzy 'const answer = 42;' --replace 'const answer = 43;' --write
```

Use anchors or line ranges when text is not globally unique. Ambiguous
base edits include candidate line ranges, and ambiguous structural selectors
include stable selector candidates such as `#id`, `.class`, or
`[data-testid=...]` when those selectors uniquely identify a candidate:

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
quality warnings, and final parse verification used by the rest of
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
separate step. `extract` and `refactor-state` can both write plan files.
`apply-plan` revalidates source and target hashes, re-runs the refactor
planner, and defaults to dry-run unless `--write` is passed:

```bash
tedit extract src/Page.tsx Card \
  --to src/components/PageCard.tsx \
  --name PageCard \
  --plan-out .tedit/plans/extract-card.json

tedit refactor-state src/Page.tsx \
  --cluster crewImport \
  --to src/useCrewImport.ts \
  --name useCrewImport \
  --plan-out .tedit/plans/crew-import-hook.json

tedit plan inspect .tedit/plans/extract-card.json
tedit plan inspect .tedit/plans/extract-card.json --json

tedit apply-plan .tedit/plans/extract-card.json --dry-run --diff-out extract.diff
tedit apply-plan .tedit/plans/extract-card.json --write
```

Extract plan steps can be filtered when reviewing high-risk helper movement.
Skipping a `move-helper-*` step passes that helper as a prop instead of moving
it. `refactor-state-plan` steps are applied as a whole because the source and
hook changes are coupled:

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

Every mutation result can include quality warnings. Warnings are passive:
they do not block writes. File-length warnings fire only when an edit crosses
a configured threshold. JSX/TSX className conflict warnings also surface from
single-file and multi-file `verify-file`, edit/mutation results, and compact
MCP output when static Tailwind-like utilities in the same element target the
same configured class group or overlapping box axis, such as `w-full w-9`,
`p-4 px-2`, or `inset-0 top-2`. Non-overlapping axes such as `px-2 py-3`,
`gap-x-2 gap-y-4`, and `rounded-t rounded-b` are allowed. Text size and text
color are split, so normal combinations like `text-[10px] text-primary` do
not warn. Deliberate overrides can use Tailwind's `!` prefix, for example
`w-full !w-9`, or project config can add or disable groups.

Project config lives at `.tedit/config.json` and is discovered by
walking upward from the target/spec path, falling back to the current
directory. `output.defaultMode` controls the CLI default when `--output`,
`TEDIT_OUTPUT`, and `--json` are not set. Use `compact` for agent-first
loops, `detailed` for legacy full-diff terminal output, or `auto` to keep
the built-in TTY/non-TTY behavior. `output.diffMode` controls compact diff
payloads: `off` omits them, `auto` inlines small diffs and spills large write
diffs to artifacts (the default), `stats` keeps counts only, and `full`
includes full inline text.

```json
{
  "file_length_thresholds": {
    "info": 500,
    "warn": 1000,
    "urgent": 2000
  },
  "max_extract_props": 12,
  "classNameConflicts": {
    "enabled": true,
    "groups": {
      "area": ["area-"]
    }
  },
  "defaultWrite": "auto",
  "output": {
    "defaultMode": "compact",
    "diffMode": "auto",
    "inlineDiffMaxBytes": 8000,
    "inlineDiffMaxHunks": 10,
    "diffArtifactDir": ".tedit-cache/diffs"
  }
}
```

Set `output.diffArtifacts` to `false` to disable artifact writes, or `true` to
allow large dry-run diffs to write diagnostic artifacts. By default, `auto`
only writes diff artifacts after real file writes.

Class group entries are merged with the built-in JSX groups. Built-in spacing,
gap, inset, border-width, and border-radius groups use axis-overlap checks;
custom groups use whole-group conflict checks. A pattern ending in `-`, `[`,
or `*` is treated as a prefix; other patterns are exact utility matches. Set
`"classNameConflicts": false` or
`"classNameConflicts": { "enabled": false }` to turn the guardrail off for a
project.

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
tedit refactor-state src/Page.tsx --cluster crewImport --to src/useCrewImport.ts --name useCrewImport --plan-out .tedit/plans/crew-import-hook.json
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

`new` resolves templates from `./.tedit/templates`, `~/.tedit/templates`, then built-in starters. Templates are scaffold specs with `{{param}}` substitution. Use `tedit templates --json` or the MCP `templates` tool to list built-in, global, and project-local templates before generating a file. It is most useful for boilerplate-heavy shells where the skeleton is most of the file: create the convention-correct shell, fill the body with a normal edit/write step, then add imports with `imports add` or `imports_add`.

```bash
tedit new react-component src/Card.tsx --param name=Card --write
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
- Quality guardrails currently cover file-length threshold warnings, JSX/TSX className conflict warnings, `analyze-state` over-cluster guidance with suggested subclusters, extract prop overflow, and conservative `refactor-state` application for simple clusters. Custom hook extraction keeps failing by default on external handler dependencies, but `--external-deps params` can explicitly thread those values into the generated hook.
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

MCP uses the default-profile `flow` tool for the same syntax. Pass `file` plus
`chain` for single-file chains, or omit `file` and use workspace-chain text:

```json
{
  "file": "src/Page.tsx",
  "chain": "find main as root :: wrap @root div.flex.gap-4",
  "dryRun": true
}
```

Quote `$ret` in the shell so it reaches `tedit` unchanged. `@name` does not need shell quoting in normal shells.
