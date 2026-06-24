# RFC: Agent edit primitives

## Status

Partially implemented.

Implemented:

- `write` as an agent-facing whole-file command over existing creation/write policy.
- `multiedit` as an atomic targeted-edit batch.
- `patch` v1 for unified diff and Codex apply-patch updates and file additions.

Still later:

- Broader patch semantics such as deletes/renames and richer hunk recovery.

## Context

`tedit edit` now covers the universal "find this span and mutate it"
case for every file. That makes it a plausible replacement for the
basic exact-string edit primitive available to coding agents.

Other agent environments expose adjacent primitives:

- `Edit`: targeted exact string replacement.
- `Write`: create a file or overwrite an existing file with complete
  content.
- `MultiEdit`: apply multiple targeted string replacements as one
  logical operation where available.
- Patch application: apply an already-decided diff or hunk set. Codex
  exposes this as a structured `apply_patch` tool; Claude Code does not
  currently expose an equivalent built-in structured patch tool in its
  official tool surface.

This RFC records whether `tedit` should expose these primitives itself,
without diluting the structural-editing core.

## Goal

Make `tedit` a safer agent editing layer for ordinary file changes,
not only JSX structural mutations.

The agent should be able to choose among:

- `edit`: one targeted mutation with rich match diagnostics.
- `write`: whole-file create or overwrite with `tedit` write policy.
- `multiedit`: an atomic batch of targeted edits.
- `patch`: diff/hunk application with `tedit` diagnostics and
  verification.

## Proposed surface

### `write`

```bash
tedit write src/file.ts --source 'export const x = 1;' --write
tedit write src/file.ts --from-file ./generated.ts --write
tedit write src/file.ts --from-stdin --write < ./generated.ts
```

Semantics:

- Creates a new file or overwrites an existing file with complete
  content.
- Refuses to overwrite an existing file unless `--overwrite` is present,
  or uses an explicit policy if the final design chooses to mirror
  Claude Code `Write`.
- Runs registered rule parse verification before writing.
- Uses the same write policy, backup behavior, warnings, and JSON output
  shape as the rest of `tedit`.

Relationship to current implementation:

- `create --overwrite` already covers much of this behavior.
- `write` can initially be an alias or a clearer agent-facing command.

### `multiedit`

```bash
tedit multiedit ./edits.json --dry-run
tedit multiedit ./edits.json --write
```

Example:

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
    }
  ]
}
```

Semantics:

- Runs multiple base-edit operations as one atomic operation.
- Supports same-file and multi-file batches.
- Applies each edit in order against the in-memory result for that file.
- If any edit fails, no file is written.
- Each failed edit returns the same rich diagnostics as `tedit edit`
  (`MATCH_NONE`, `MATCH_NOT_UNIQUE`, `MATCH_COUNT_MISMATCH`,
  fuzzy-only suggestions, candidate contexts).
- Registered language rules parse-verify final file contents before
  writing.

Relationship to current implementation:

- This can be implemented as a thin agent-friendly layer over
  `workspace-flow` + base `edit` steps.
- It should not introduce a separate mutation engine.

### `patch`

```bash
tedit patch ./change.patch --dry-run
tedit patch ./change.patch --write
tedit patch --from-stdin --dry-run < ./change.patch
tedit patch --stdin --write < ./change.patch
```

Semantics:

- Applies a diff/hunk based change to one or more files. Current v1
  auto-detects unified diff input and Codex apply-patch input.
- Intended for already-decided diffs, not structural intent.
- Should use `tedit` transaction behavior, write policy, backup behavior,
  and registered-rule parse verification.
- Should report hunk failures with agent-friendly diagnostics instead of
  a raw patch failure where feasible.

Open format questions:

- Allow file add/delete/rename in v1 or limit v1 to file updates.
- Whether to implement a native parser or delegate to `git apply
  --check`/`git apply` behind the scenes.

## Non-goals

- Replace structural JSX/HTML/XML/Markdown actions.
- Become a general-purpose `git apply` clone.
- Hide broad patch writes behind the same trust level as selector-based
  structural edits.
- Add new dependencies solely for patch parsing unless clearly justified.

## Priority

Recommended order:

1. `write` as an agent-facing alias or clarified command for whole-file
   create/overwrite.
2. `multiedit` as an atomic batch wrapper over existing base edit and
   workspace transaction machinery.
3. `patch` as a later extension once edit/write/multiedit semantics are
   stable.

`patch` is valuable, especially in environments that lack a structured
patch tool, but it is broader and less central to `tedit`'s structural
editing identity than `edit`, `write`, and `multiedit`.
