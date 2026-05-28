# Selector: scoped relative selectors inside `:has(...)`

## Summary

`tedit` now follows CSS-style selector syntax for `div#id.class`, `A B`,
`A > B`, and `A:has(B)`, but `:has(> B)` is still not scoped correctly.
Today the parser records the leading child combinator, but the matcher treats
`:has(> br)` like `:has(br)` because it scans every descendant and ignores the
first part's combinator.

## Resolution

Implemented. The JSX document matcher and extract's lightweight selector matcher now evaluate `:has(...)` arguments as scoped relative selectors. A leading `>` inside `:has` is anchored to the node being tested, while existing `:has(B)` descendant behavior is preserved. Regression coverage was added for `main > div:has(> br)`, `main > div:has(br)`, `main > div:has(> span > br)`, `section:has(> div > br)`, and a negative `section:has(> br)` case.

## Desired behavior

Match CSS `:has()` relative-selector semantics:

| Selector | Target |
|---|---|
| `div > br` | `br` nodes that are direct children of `div` |
| `div:has(br)` | `div` nodes with a descendant `br` |
| `div:has(> br)` | `div` nodes with a direct child `br` |
| `section:has(> div > br)` | `section` nodes with a direct `div` child that has a direct `br` child |

The selected node should still be the outer selector subject (`div` or
`section`) for `:has(...)`; the child selector only constrains it.

## Implementation notes

- Keep top-level selector behavior unchanged.
- Add a relative selector matcher for `:has(...)` that anchors the first
  selector part against the node being tested.
- Preserve current descendant behavior for `:has(B)`.
- Honor a leading `>` as a direct-child relationship to the scoped node.
- Keep extract slot selector matching consistent with the main JSX document
  matcher, since extract has its own lightweight selector matcher.

## Acceptance criteria

- `find 'main > div:has(> br)'` matches only direct `div` children of `main`
  that have a direct `br` child.
- `find 'main > div:has(br)'` still matches direct `div` children of `main`
  with a `br` anywhere below them.
- `find 'section:has(> div > br)'` matches a `section` whose direct child `div`
  has a direct child `br`.
- Typecheck and the full test suite pass.
