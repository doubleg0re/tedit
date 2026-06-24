# Add atomic `multiedit` for universal base edits

## Status

Implemented in v1.

Landed:

- `tedit multiedit <edits-json>` and `--from-stdin`.
- Same-file edits apply sequentially against in-memory content.
- Any edit, count, or final parse failure prevents all writes.
- Output includes per-edit results, file diffs, write policy, and final parse verification.

## Priority

P1.

## Problem

`tedit edit` is strong enough to act as a safer replacement for a basic
agent `Edit` primitive, but agents often need to make several ordinary
file edits as one logical change.

Today the agent must run several `tedit edit` commands sequentially or
encode a `workspace-flow` by hand. That works, but it is too verbose for
the common "apply these N exact/anchor/regex edits" case, and partial
success is still an ergonomics risk if the caller does not use
`workspace-flow` correctly.

The most important missing primitive is an atomic batch layer over the
existing universal base edit engine.

## Goal

Add `tedit multiedit` as an agent-facing batch edit command:

```bash
tedit multiedit ./edits.json --dry-run
tedit multiedit ./edits.json --write
tedit multiedit --from-stdin --write < ./edits.json
```

The command should let an agent express many ordinary edits with the same
match strategies and diagnostics as `tedit edit`, while guaranteeing that
no file is written if any edit fails.

## Proposed JSON shape

```json
{
  "edits": [
    {
      "file": "README.md",
      "find": "Status: draft",
      "replace": "Status: reviewed"
    },
    {
      "file": "src/config.ts",
      "findAnchorAfter": "const config =",
      "find": "timeout: 3000",
      "replace": "timeout: 5000"
    },
    {
      "file": "styles.css",
      "findRegex": "\\bred\\b",
      "replace": "blue",
      "replaceAll": true,
      "expectCount": 2
    },
    {
      "file": "notes.txt",
      "findLines": "10:12",
      "delete": true
    }
  ]
}
```

Naming should accept the same kebab/camel variants as workspace flow
where practical:

- `find` / `findExact`
- `findFuzzy`
- `findAnchorAfter`
- `findRegex`
- `findLines`
- `replace`
- `insertBefore`
- `insertAfter`
- `delete`
- `replaceAll`
- `expectCount`

## Semantics

- Supports same-file and multi-file batches.
- Applies edits in order against each file's in-memory next source.
- If any edit fails, no file is written.
- Returns per-edit results and per-file diffs.
- Uses the same write policy, backup behavior, and file-length warnings
  as existing mutation commands.
- Runs final parse verification before writing for registered language
  rules plus JSON and Markdown files.
- For unknown file types, performs bytes-only edits with no parse
  verification, same as `tedit edit`.

## Failure contract

Each failed edit should preserve the base edit diagnostic quality:

- `MATCH_NONE`
- `MATCH_FUZZY_ONLY`
- `MATCH_NOT_UNIQUE`
- `MATCH_COUNT_MISMATCH`
- `INVALID_REGEX`
- `LINE_RANGE_OUT_OF_BOUNDS`

The result should include enough context for an agent to recover without
re-reading the whole file.

## Implementation notes

- Do not create a second edit engine.
- Reuse `planBaseEdit` for each edit.
- Reuse `workspace-flow` transaction behavior where possible.
- Consider translating `multiedit` input to workspace `edit` steps
  internally.
- Same-file batches must not suffer from last-writer-wins races; they
  should apply edits to the current in-memory source for that file.

## Tests

Add coverage for:

- Two edits in one file both apply.
- Two edits in two files both apply.
- Later edit failure prevents all writes.
- Same-file sequential edits see earlier in-memory results.
- `expectCount` failure prevents all writes.
- Registered TSX file parse failure prevents write.
- JSON output includes per-edit diagnostics and per-file diffs.

## Related

- `RFC-agent-edit-primitives.md`
- `ISSUE-base-rule-universal-edit.md`
- `RFC-multifile-flow-extract.md`
