# Selector: support :scope plus sibling combinators (+, ~)

## Status

Implemented on 2026-05-28.

## Problem

`tedit` selector syntax already follows common CSS shapes for tag/id/class,
descendant, child, and `:has(...)` selectors. The remaining gap for everyday
CSS selector fluency was sibling navigation and an explicit scoped subject for
relative selectors:

- `Label + Input` for the input immediately after a label.
- `Label ~ Hint` for any following hint sibling.
- `h2:has(+ p)` for headings immediately followed by a paragraph.
- `main:has(:scope > h2 + p)` for relative selector chains anchored at the
  candidate node.

Without these, users had to fall back to less familiar attribute-heavy
selectors or manual inspection when sibling position was the stable signal.

## Resolution

Implemented in both selector matchers:

- Parser support for `:scope`, adjacent sibling `+`, and general sibling `~`.
- JSX document matcher support for top-level sibling combinators and scoped
  relative selectors inside `:has(...)`.
- Extract's lightweight selector matcher kept in sync so extract/slot flows use
  the same selector language.
- Regression coverage for `Label + Input`, `Label ~ Hint`, `h2:has(+ p)`,
  `main:has(:scope > h2 + p)`, and a negative adjacent-sibling case.

## Notes

Sibling calculations use the same flattened JSX sibling model as
`:first-child`, `:last-child`, and `:nth-of-type(n)`, so fragments are ignored
as structural wrappers for selector purposes.
