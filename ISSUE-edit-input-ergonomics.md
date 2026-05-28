# Improve `tedit edit` input ergonomics

## Status

Implemented in v1.

Landed:

- `--find-file`, `--find-stdin`, and matching explicit strategy file/stdin variants.
- `--replace-file`, `--replace-stdin`, `--insert-before-file`,
  `--insert-before-stdin`, `--insert-after-file`, and `--insert-after-stdin`.
- `--spec` for a single base-edit JSON object, single-item array, or
  `{ "edits": [oneEdit] }` shape.
- Conflicting stdin-backed inputs fail before reading/writing.
- File/stdin text is used verbatim.

## Priority

P1.

## Problem

`tedit edit` is now a viable replacement for a basic agent `Edit`
primitive, but long or multiline find/replace strings are still awkward
because they must be passed through shell quoting:

```bash
tedit edit file.ts --find '...' --replace $'multi\nline\ntext' --write
```

That is exactly where agents most often make quoting mistakes. `write`,
`multiedit`, and `patch` already support file/stdin input; `edit` should
have the same ergonomics.

## Goal

Add file/stdin/spec input forms to `tedit edit` without changing the
existing inline flags:

```bash
tedit edit file.ts --find-file old.txt --replace-file new.txt --write
tedit edit file.ts --find "old" --replace-stdin --write < new.txt
tedit edit file.ts --find-stdin --replace "new" --write < old.txt
tedit edit file.ts --spec edit.json --write
```

`--spec` should accept the same base-edit shape as `multiedit` for one
edit, including camel/kebab variants where practical.

## Semantics

- Exactly one find source is allowed per command.
- Exactly one mutation source is allowed per command.
- `--find-stdin` and `--replace-stdin` cannot both be used in the same
  invocation because there is only one stdin stream.
- File and stdin values are used verbatim; no automatic trailing newline
  is appended.
- Existing `--find`, `--replace`, `--insert-before`,
  `--insert-after`, `--delete`, `--replace-all`, and `--expect-count`
  behavior remains compatible.

## Tests

Add coverage for:

- `--find-file` + `--replace-file`.
- `--replace-stdin`.
- `--find-stdin`.
- `--spec` JSON input.
- invalid conflicting stdin sources.

## Related

- `RFC-agent-edit-primitives.md`
- `ISSUE-base-rule-universal-edit.md`
- `ISSUE-multiedit-atomic-base-edits.md`
