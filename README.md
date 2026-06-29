# tedit

**Structure-aware JSX/TSX editing for coding agents.**

Has your agent ever broken a JSX tag, replaced the wrong repeated block, or pasted a full file when it only needed to change one line?

`tedit` starts with the painful React case: selector-based JSX/TSX edits for props, classes, text, wrappers, imports, and extraction without hand-balancing tags. It also includes the boring safe-edit base agents still need: search, inspect, edit, multiedit, patch, write, refactor, parser verification, compact diffs, and optional post-write commands.

## Why tedit exists

Agents should not be stuck editing code like they only have a notepad. `tedit` gives them a safer editing surface: find the target, change the smallest thing, show the diff, verify the result, and recover when the first attempt is wrong.

## Install for MCP

Most agent usage should go through MCP. Install the package, register the server, then restart or refresh your MCP host.

```bash
npm install -g tedit-tools
tedit setup mcp     # asks: claude, codex, or both; then user/project scope
tedit doctor
```

Non-interactive setup:

```bash
tedit setup mcp --target both --scope user --yes
tedit setup mcp --target claude --scope project --yes
```

The guide follows the same scope: `--scope user` writes to `~/.codex/AGENTS.md` and/or `~/.claude/CLAUDE.md`; `--scope project` writes to the current project's `AGENTS.md`/`CLAUDE.md`. Existing guide files are backed up next to the file with a timestamped `.bak` path before editing, and that backup path is printed. Codex currently supports user-scoped MCP setup only. Pass `--yes` to accept prompts or `--no-agent-guide` to skip the guide.

Manual MCP config after a global install:

```json
{
  "mcpServers": {
    "tedit": { "command": "tedit-mcp" }
  }
}
```

Without a global install:

```json
{
  "mcpServers": {
    "tedit": {
      "command": "npx",
      "args": ["-y", "--package", "tedit-tools@latest", "tedit-mcp"]
    }
  }
}
```

## 30-second MCP win

Ask your agent to make a structural JSX change instead of hand-editing the tag:

```jsonc
// tedit.mutate
{ "file": "src/Page.tsx", "target": "jsx:Button", "prop.set": { "name": "disabled", "value": true }, "dryRun": true }
```

If the preview is right, rerun without `dryRun:true` or use the returned `apply_dry_run` action when available.

## MCP quick start

Start with `tedit.actions` when unsure. It returns the current tool profile, file-specific capabilities, mutate examples, and recovery hints.

The default MCP profile is `agent`, which keeps the callable tool list small and intent-oriented:

`actions`, `select`, `search`, `edit`, `multiedit`, `mutate`, `apply_dry_run`, `patch`, `flow`,
`refactor`, `file_write`, `delete_file`, `rename_file`, `read_detail`, and `verify_file`.

`select` is the structural target finder for JSX/TSX, TS/JS declarations, and supported file-aware targets. `search` is for text/range discovery.

The `actions` response includes an agent workflow guide. The intended loop is:

- `search` when the target is not certain yet or line context is needed.
- `select` when a structural JSX/TSX or TS/JS target is available.
- `mutate` after `select` for one structural target, e.g. JSX props/classes/text/wrap or TS body changes.
- `edit` for one localized text replacement, insertion, deletion, regex, fuzzy, or line-range change.
- `multiedit` after `search` when the same change spans several places or files.
- `apply_dry_run` when a successful dry-run returns `suggestedActions`; it reapplies the reviewed change by id after source-hash checks.
- `delete_file` or `rename_file` for one-file cleanup or moves without hand-authoring a patch envelope.
- `patch` only when the change already exists as a unified diff or apply-patch envelope.
- `file_write` for whole-file generation through `mode: "write"`, `mode: "scaffold"`, or `mode: "template"`.
- `verify_file` before or after edits when parser coverage matters.

MCP `edit`, `multiedit`, `mutate`, and `flow` write by default; pass `dryRun:true` to preview. Add `verify` when typecheck/lint/test breakage matters.

Example MCP payloads:

```jsonc
// tedit.mutate: structural JSX/TSX edit
{ "file": "src/Page.tsx", "target": "jsx:Button", "prop.set": { "name": "disabled", "value": true }, "dryRun": true }

// tedit.edit: parser-checked text edit
{ "file": "src/config.ts", "find": "timeout: 3000", "replace": "timeout: 5000", "dryRun": true }

// tedit.multiedit: atomic repeated/cross-file text edits
{ "edits": [{ "file": "src/a.ts", "find": "Old", "replace": "New" }], "dryRun": true }

// tedit.patch: apply an existing unified diff
{ "patch": "--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
", "dryRun": true }
```

Failure responses are part of the workflow: `MATCH_NONE`, `MATCH_NOT_UNIQUE`, `PARSE_BROKEN_AFTER_EDIT`, `AST_MATCH_NONE`, and `PATCH_HUNK_FAILED` include bounded suggestions so an agent can inspect, narrow, or retry without guessing.

Use `TEDIT_MCP_PROFILE=all` for compat/advanced workflows. Set `TEDIT_MCP_PROFILE=all` (or `TEDIT_MCP_EXPOSE_ADVANCED=true`) to expose the advanced and legacy fine-grained tools as MCP tools too, including
`search_text`, `inspect_range`, `create_file`, `templates`, `history_trace`, `scan_strings`, `ast_select`,
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

In the `all` profile, use the fine-grained tools for compatibility or debugging. New agent workflows should prefer `actions`, `search`, `select`, `edit`, `multiedit`, `mutate`, `patch`, and `refactor`.

## CLI quick use

The CLI is still useful for humans, CI, scripts, and smoke checks:

```bash
tedit --version
tedit actions src/Page.tsx --json
tedit edit README.md --find "old text" --replace "new text" --dry-run
tedit patch ./change.patch --dry-run --quiet --diff-out ./patch.diff
tedit verify ./edits.json --diff-out ./edits.diff
```

CLI commands keep their conservative dry-run-by-default policy; pass `--write` when you want to persist changes.

## Current scope

- Primary wedge: `.js`, `.jsx`, `.ts`, `.tsx` structural JSX/TSX edits.
- Base safe edit layer: every file gets exact/fuzzy/anchor/regex/line-range edits, multiedit, patch, and write primitives.
- Parser coverage: JSON, YAML, Markdown, markup, JSX/TSX, TS/JS, plus Python syntax verification for safe string edits.
- Focused refactors: TS/JS declaration targeting, module split, React component extraction, and React state helpers.

## More docs

- `docs/REFERENCE.md` — long-form CLI/MCP examples and detailed tool notes.
- `docs/agent-setup.md` — copyable AGENTS/CLAUDE instructions and optional skill text.
- `docs/principles/VISION.md` — product direction and why JSX/TSX is the wedge.
- `docs/share-local-package.md` — sharing a local tarball before npm publish.

## Current limitations

- tedit is not trying to replace full IDE semantic tools such as LSP-backed reference search or cross-language rename.
- Broad JS, TS, CSS, Python, YAML, JSON, and Markdown expansion is follow-on work, not a release blocker.
- For tiny obvious one-line edits, native Edit is often enough.
