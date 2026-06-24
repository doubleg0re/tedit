# JSON output compact profiles

## Status

Implemented from 2026-05-29 JSON output review and Claude TUI proxy dogfood.

## Problem

Compact output currently works well for mutating agent loops, but the formatter is too generic for read-only/discovery results. A command such as `find` can be reduced to:

```json
{
  "ok": true,
  "summary": "operation succeeded"
}
```

That is compact, but it loses the primary payload (`matches`). For agent-facing output, compact must mean smaller and easier to route, not payload-stripping.

The original schema clarity issue across output layers was:

- MCP/default compact mutation output used `changed` and `written` as file counts.
- CLI `--json` raw/detailed output still uses `changed` and `written` as booleans.
- Per-file compact output used `status` arrays such as `["changed", "written"]`.

The tool is not released yet, so this is still a reasonable time to remove avoidable ambiguity.

## Implemented Direction

Introduce explicit compact profiles by result type instead of applying one generic formatter to every successful object.

### Common Compact Fields

Every compact result should include:

```json
{
  "ok": true,
  "kind": "mutation",
  "summary": "1 file written"
}
```

Use one discriminator, `kind`, everywhere. Do not make agents infer the result type from the presence of fields such as `matches`, `node`, or `files`.

### Mutation Compact

Implemented mutation compact schema:

```json
{
  "ok": true,
  "kind": "mutation",
  "summary": "1 file written",
  "changedCount": 1,
  "writtenCount": 1,
  "path": "README.md",
  "parse_verified": true,
  "parser": "markdown-lite",
  "files": [
    {
      "path": "README.md",
      "change": "modified",
      "persisted": true,
      "diffAvailable": true,
      "hunks": 1,
      "bytesDelta": 32
    }
  ]
}
```

Rationale:

- `changedCount` and `writtenCount` avoid the same field names having boolean meaning in CLI raw output and numeric meaning in compact output.
- `change` describes the content effect: `created`, `modified`, `deleted`, or `unchanged`.
- `persisted` describes whether the change was actually written. This separates content state from dry-run/write state.

### Discovery Compact

Discovery/read-only compact output must preserve its primary payload:

```json
{
  "ok": true,
  "kind": "find",
  "summary": "1 match",
  "matches": []
}
```

```json
{
  "ok": true,
  "kind": "inspect",
  "summary": "node inspected",
  "node": {}
}
```

```json
{
  "ok": true,
  "kind": "verify-file",
  "summary": "parse verified with json",
  "path": "config.json",
  "parse_verified": true,
  "parser": "json"
}
```

`actions`, `rules`, and `analyze-state` should keep their core payloads in compact output as well.

### Error Compact

Errors should remain small by default:

```json
{
  "ok": false,
  "kind": "error",
  "summary": "No match found.",
  "code": "MATCH_NONE",
  "error": "No match found.",
  "next": ["Retry near candidate 1 with --find-lines 1."]
}
```

Keep verbose `details` behind `includeDetails` / detailed output unless a small detail is required for deterministic retry.

## Acceptance Criteria

1. Non-TTY compact `find` without `--json` returns `kind: "find"` and preserves `matches`.
2. Compact `inspect`, `actions`, `rules`, `analyze-state`, and `verify-file` preserve their primary payloads.
3. Every compact result, including errors, includes `kind`.
4. Mutation compact uses `changedCount` / `writtenCount`, plus `files[].change` and `files[].persisted`.
5. If counts are exposed, tests assert they match `files[]`.
6. Dry-run and written mutation results are distinguishable from compact output alone.
7. Detailed/raw CLI `--json` remains available and keeps full diffs and write-policy diagnostics.
8. README documents compact as payload-preserving, not merely terse.

## Claude Proxy Review Notes

Asked through `claude-tui-proxy` SDK Gate on 2026-05-29.

Claude agreed with the direction and called the discovery payload loss a correctness bug rather than a verbosity issue. Its strongest recommendations were:

- make `kind` globally required instead of optional;
- avoid same-name/different-type fields between compact and raw output;
- split per-file content effect from persistence state;
- add golden tests for find/inspect/actions/rules/verify/mutation/error compact results.

Proxy dogfood note: the first SDK request returned `completionStatus: "indeterminate_tui_busy"` with only an intermediate Claude sentence, so the second run used `no workflow, just chat` and tailed the JSONL transcript after the SDK result. That reinforces the proxy repo's existing finality/readiness concern.
