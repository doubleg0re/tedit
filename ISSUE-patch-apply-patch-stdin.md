# Support Codex apply_patch format in `tedit patch`

## Status

Implemented in v1.

Landed:

- `tedit patch --stdin` as an alias for stdin patch input.
- Auto-detection for unified diff vs Codex apply-patch input.
- apply-patch `*** Add File` support.
- apply-patch `*** Update File` support.
- Atomic failure behavior for apply-patch hunk mismatch.

Follow-up resolved:

- Safe file deletion and rename support were added in the patch delete/rename pass.

## Priority

P1.

## Problem

`tedit patch` currently applies unified diffs. That is useful for
standard tooling, but Codex's native patch tool uses a different
action-oriented format:

```text
*** Begin Patch
*** Add File: notes.txt
+hello
*** Update File: README.md
@@
-old
+new
*** End Patch
```

If `tedit patch` can consume that format from stdin, agents can use the
same authored patch shape while gaining `tedit` write policy, atomic
multi-file commits, and final parse verification.

## Goal

Add apply-patch format support to `tedit patch`:

```bash
tedit patch --stdin --write <<'PATCH'
*** Begin Patch
*** Add File: notes.txt
+hello
*** Update File: README.md
@@
-old
+new
*** End Patch
PATCH
```

`--stdin` should be accepted as an alias for `--from-stdin`, and patch
format should be auto-detected:

- `*** Begin Patch` -> Codex apply-patch format.
- `--- ` or `diff --git ` -> unified diff.

## Semantics

- Support `*** Add File`.
- Support `*** Update File`.
- Support `*** Delete File` only if the existing patch transaction can
  delete files safely; otherwise reject explicitly.
- Keep all writes atomic.
- Keep parse verification on final file contents.

## Tests

Add coverage for:

- `patch --stdin` alias.
- apply-patch update.
- apply-patch add file.
- mixed add + update atomic output.
- apply-patch hunk failure prevents all writes.

## Related

- `RFC-agent-edit-primitives.md`
- `ISSUE-multiedit-atomic-base-edits.md`
