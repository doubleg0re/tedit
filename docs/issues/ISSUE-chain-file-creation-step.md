# Allow file creation as the first step inside `chain`

## Status

Implemented for `create --source` as the first single-file `chain` step.

## Priority

P2.

## Problem

File creation is available through `create`, `write`, `scaffold`, and `new`,
but single-file `chain` still assumes the target file already exists. That
prevents flows like "create this file, then run structural or base edits"
from being expressed as one compact chain.

## Goal

Allow creation as the first operation in a chain when the command explicitly
provides source content or a scaffold/new-file spec.

## Proposed shape

```bash
tedit chain src/New.tsx create --source 'export function New() { return <main />; }' :: find main as root :: prop.set @root data-new true --write
```

Alternative workspace form may be preferred if single-file chain remains too
file-bound.

## Tests

- `chain <file> create --source ... :: edit ...` creates and edits a file.
- Existing file creation without `--overwrite` fails.
- Later chain failure prevents creation.

## Related

- `ISSUE-scaffold-and-new-file-creation.md`
- `ISSUE-chain-ergonomics.md`
