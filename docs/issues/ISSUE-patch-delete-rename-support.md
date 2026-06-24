# Support delete and rename in `tedit patch`

## Status

Implemented.

## Priority

P1.

## Problem

`tedit patch` supports file updates and additions, but delete and rename
patches are still rejected. That keeps the patch primitive from covering
ordinary cleanup diffs and file moves.

## Goal

Support safe atomic delete and rename operations in `tedit patch` for both
unified diff and Codex apply-patch input where the format can express the
operation clearly.

## Semantics

- Deletes remove files only after every patch operation and parse check has
  succeeded.
- Renames move the source path to the destination path atomically with other
  patch updates.
- Refuse to overwrite an existing rename destination unless the patch also
  clearly updates that destination as part of the same operation.
- Preserve write policy, backup behavior, and final parse verification for
  all surviving changed files.

## Tests

- apply-patch `*** Delete File` removes a file.
- unified diff delete removes a file.
- unified diff rename moves a file and applies hunks.
- delete/rename failure prevents all writes.

## Related

- `ISSUE-patch-apply-patch-stdin.md`
- `RFC-agent-edit-primitives.md`
