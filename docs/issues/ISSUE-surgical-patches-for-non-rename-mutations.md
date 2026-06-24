# Add surgical source patches for non-rename JSX mutations

## Summary

`rename`, `prop.set`, `prop.remove`, and `wrap` now avoid full-file
`recast.print` churn by applying source-range patches to the original source.
Other mutations still fall back to recast full-file printing:

- `append`
- `prepend`
- `unwrap`
- `remove`
- `insertComment`

This means `tedit` can still create unrelated diff noise for workflows that add
or remove full JSX subtrees.

## Why It Matters

The core product promise is surgical structural editing. If a mutation touches
one selected element but reprints unrelated JSX branches, users need a formatter
or manual cleanup before PRs. That weakens the main advantage over normal
LLM-generated patches.

## Proposed Direction

Implement source-range patch paths per mutation where feasible:

- `remove`: remove the selected node source span.
- `unwrap`: remove wrapper opening/closing tag spans while preserving children.
- `insertComment`: insert comment text at a calculated source offset.
- `append` / `prepend`: insert generated child source at a calculated child
  boundary.

Fallback to recast only when the mutation cannot be expressed safely as source
patches.

## Resolution

Implemented source-range patch paths for:

- `append`
- `prepend`
- `unwrap`
- `remove`
- `insertComment`

Regression coverage now verifies each mutation against the redundant-parens
conditional JSX fixture, so unrelated conditional JSX attribute consequents
remain byte-identical.

Known remaining limit:

- If a later mutation targets a node created earlier in the same in-memory
  document, that generated node has no original source span. In that case
  `tedit` still falls back to recast for safety. Direct mutations of original
  source nodes use source patches.
- `text.set` and `text.replace` also use source-range patches for original
  JSX child ranges. Overlapping patches against the same original source range
  in one single-file chain still fail loudly with `OVERLAPPING_PATCHES`.

## Acceptance Criteria

- Add regression fixtures with unrelated conditional JSX attribute consequents.
- Each implemented mutation changes only the intended source span in dry-run
  diff.
- Keep AST mutation in sync with source patches so flow state remains coherent.

Verification:

- `npm test` passed: 74/74 tests.
