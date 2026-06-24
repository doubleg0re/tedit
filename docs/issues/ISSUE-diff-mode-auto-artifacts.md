# Diff output: `diffMode: auto` with full-diff artifacts

## Status

Implemented.

## Priority

P2. Agent ergonomics and context control. Not a mutation correctness blocker.

## Summary

Compact output is now the right default for MCP and non-TTY agent calls, but
diff payloads can still become too large when a change touches many hunks or
when `includeDiffs` is enabled for debugging. The tool should keep the agent
response small by default while preserving a reliable path to inspect the full
diff when needed.

Add `diffMode: "auto"` as an output policy:

- small diffs can stay inline,
- medium or large diffs return stats plus a small hunk preview,
- very large full diffs are written to a local artifact file,
- the response includes the artifact path so the agent can inspect it with
  `sed`, `rg`, `cat`, or a follow-up read.

This keeps the common edit loop concise without hiding the full evidence.

## Proposed modes

```text
diffMode:
  off    no diff payload
  stats  per-file hunk/byte counts only
  full   full inline diff
  auto   inline when small, artifact when large
```

`auto` should be the recommended agent-facing default once implemented. TTY CLI
can keep its current detailed behavior unless config says otherwise.

## Proposed config

```json
{
  "output": {
    "diffMode": "auto",
    "inlineDiffMaxBytes": 8000,
    "inlineDiffMaxHunks": 10,
    "diffArtifactDir": ".tedit-cache/diffs",
    "diffArtifacts": false
  }
}
```

Names are intentionally provisional. The important pieces are:

- a mode selector,
- an inline size threshold,
- inline hunk-count threshold,
- an artifact directory,
- a way to disable artifact writes.

## Proposed response shape

For a large diff:

```json
{
  "ok": true,
  "kind": "mutation",
  "summary": "1 file written; full diff saved as artifact",
  "files": [
    {
      "path": "src/Page.tsx",
      "status": ["changed", "written"],
      "diff": {
        "mode": "artifact",
        "hunks": 8,
        "bytes": 48291,
        "path": ".tedit-cache/diffs/20260529-abc123.diff",
        "preview": "@@ ..."
      }
    }
  ]
}
```

For a small diff:

```json
{
  "ok": true,
  "kind": "mutation",
  "files": [
    {
      "path": "src/Page.tsx",
      "status": ["changed", "written"],
      "diff": {
        "mode": "inline",
        "hunks": 1,
        "bytes": 421,
        "preview": "@@ ..."
      }
    }
  ]
}
```

The response should not require the agent to parse a full diff just to learn
whether the edit succeeded.

## Dry-run artifact behavior

`dry-run` creates a policy question: target files are not changed, but a diff
artifact may still be written. That is acceptable if it is explicit and
cleanable:

- they should live under `.tedit-cache/diffs`;
- callers can disable them with `diffArtifacts: false` or equivalent;
- responses should make artifact creation visible.

Decision: `auto` writes artifacts only for real writes by default. Dry-run
returns truncated previews unless `diffArtifacts: true` is explicitly set.

## Agent workflow

Expected common loop:

1. agent calls `edit`, `multiedit`, `patch`, or an MCP wrapper;
2. result returns compact success plus per-file stats;
3. if the diff is large, result includes `diff.path`;
4. agent inspects only what it needs:

```bash
sed -n '1,160p' .tedit-cache/diffs/20260529-abc123.diff
rg '^@@|className|import' .tedit-cache/diffs/20260529-abc123.diff
```

This is better than streaming a 40KB diff into the model context by default.

## Acceptance criteria

- MCP and non-TTY compact output support `diffMode: "auto"`.
- Large diffs are stored as artifacts when artifact writes are enabled.
- Compact responses include stable `diff.mode`, `diff.bytes`, `diff.hunks`, and
  `diff.path` when applicable.
- Small diffs can still be returned inline.
- `includeDiffs` remains available but does not force huge inline payloads when
  `diffMode: "auto"` is active.
- Config can disable artifact writes.
- Artifact files are excluded from package output and covered by cleanup.
- Tests cover small inline diff, large artifact diff, dry-run behavior, and
  artifact-disabled behavior.

## Non-goals

- Do not create a separate diff viewer.
- Do not replace normal git diff tooling.
- Do not require agents to call a tedit read tool to inspect artifacts; ordinary
  local file reads are enough.

## Open questions

- Should `auto` be the default for all MCP mutation tools, or only when
  `includeDiffs` is requested?
- Should TTY CLI use `auto` from config, or keep detailed inline output unless
  the user opts in?
- Should dry-run write artifact files by default?
- What is the right default threshold for inline diff bytes?
- Should artifact paths be absolute for MCP callers, or relative to cwd for
  readability?

## Related

- `ISSUE-mcp-diff-output-verbosity.md`
- `ISSUE-json-output-compact-profiles.md`
- `ISSUE-multiedit-summary-output.md`
- `DOGFOOD-2026-05-28-cashflow-renewal.md`
