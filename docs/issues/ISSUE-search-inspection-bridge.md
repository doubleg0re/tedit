# Search and Inspection Bridge

## Goal

Make `tedit` useful in the place where agents currently fall back to `rg`,
`grep`, and `sed`: quick discovery, small context inspection, and turning a
search hit into a safe edit input.

This does not try to replace `rg`. The goal is to bridge raw search results to
tedit's safer edit tools.

## Milestone 1: `inspect_range`

Read-only range inspection for `sed -n '120,160p' file` style workflows.

CLI:

```bash
tedit inspect-range src/Page.tsx --lines 120:160 --context 5 --json
```

MCP:

```json
{ "file": "src/Page.tsx", "lines": "120:160", "context": 5 }
```

Expected output:

- file path
- requested and expanded line ranges
- line objects with numbers and text
- byte range for the expanded span
- parse verification fields
- compact edit suggestion using `edit` + `findLines`
- replacement hint that `findLines` replaces whole lines and should preserve a
  trailing newline for non-final line replacements
- optional hints for AST/JSX follow-up when feasible

## Milestone 2: `search_text`

Read-only text search that returns edit-ready candidates rather than plain
grep output.

CLI:

```bash
tedit search-text "삭제" src --glob "**/*.tsx" --json
tedit search-text "삭제" src --glob "**/*.tsx" --context 2 --json
tedit search-text --regex "t\\(\"[^\"]+\"" src --json
```

MCP:

```json
{ "query": "삭제", "paths": ["src"], "glob": "**/*.tsx" }
```

Expected output:

- file, line, column, byte range, preview
- match text
- candidate id
- suggested `edit` call with `findLines`
- optional `inspect_range` follow-up

## Milestone 3: Tool Choice Guidance

Update CLI help, README, and MCP `actions` guidance with clear boundaries:

- `search_text`: raw text search across files
- Optional `context` on `search_text` returns nearby lines with each result
- `inspect_range`: line/context inspection
- `scan_strings`: semantic JS/TS/JSX string audit
- `ast_select`: code AST discovery
- `jsx_select`: JSX/markup structural discovery

## Milestone 4: Smoke Criteria

The feature is good enough when:

- `inspect_range` is comfortable enough to replace simple `sed -n` context
  reads in agent workflows.
- `search_text` is not a full `rg` replacement, but is better than `rg` for
  “find then edit” because it returns structured candidates and suggestions.
- MCP tools expose compact read-only results without verbose noise.
- Tests cover CLI and MCP happy paths plus at least one regex search.
- Final smoke manually runs `search_text -> inspect_range -> edit` on a temp
  file and confirms the result is parse-verified where applicable.
