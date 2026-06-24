# Selector: support tree combinators (`A B`, `A > B`, `:has`, `:nth-of-type`)

## Summary

The current selector grammar is single-node:

```
Tag[attr="value"][attr*="contains"]
```

There's no way to express a structural constraint across the tree. Once two
elements share the same tag (and the same attribute values you care about),
`find` returns both — and the only escape hatch is to `inspect` the whole
file, eyeball ids, and reference them manually in a `chain`. That's painful
in any real React/Next file where the same component appears many times
(`<Button>`, `<Dialog>`, `<Card>`, `<Image>`, …).

## Motivation

Real cases I hit in the same daily-plan page:

- **Two `<ScrollArea>` in the same file** — one inside the left rail
  (`viewportClassName="pl-3 pr-3 pt-1 pb-4"`), one wrapping the body
  (`viewportClassName="px-7 pb-20 pt-1"`). Today I had to disambiguate by
  attribute, which only works because the viewport class happened to differ.
  A descendant selector would let me say "the `ScrollArea` inside
  `ContentView`" without coupling to a string.
- **Buttons inside dialog footers** — `DialogFooter > Button` is the kind of
  thing every form has. Right now you can't write it.
- **First option in a group** — `RadioGroup > Radio:first-child`. No way.
- **Find an element only if it has a specific child** — `Card:has(Image)`.
  Useful for "wrap only the cards that already contain an image".

When selectors can't express structure, the workaround is
`inspect → grep id → chain`. That works for one-off scripts, but it's
**hostile to flow.json reuse** — the ids (`jsx_48`) are not stable across
file edits, so a flow written today against `jsx_48` breaks tomorrow.
Structural selectors give flows a stable, declarative way to address nodes.

## Resolution

Implemented in the JSX rule:

- Descendant combinator: `A B`
- Direct child combinator: `A > B`
- Adjacent sibling combinator: `A + B`
- General sibling combinator: `A ~ B`
- Structural pseudos: `:has(...)`, `:not(...)`, `:first-child`, `:last-child`, `:nth-of-type(n)`
- Scoped subject pseudo: `:scope` in relative selectors such as `:has(:scope > h2 + p)`
- Expression-container pseudo: `:expr`
- Member-expression component names still work, including selectors such as `Dialog.Footer > Button`

Regression coverage now exercises `ContentView ScrollArea`, `DialogFooter > Button[variant="primary"]`, `Label + Input`, `Label ~ Hint`, `h2:has(+ p)`, `main:has(:scope > h2 + p)`, `Card:has(Image)`, `Card:not(:has(Image))`, `Radio:nth-of-type(2)`, `ContentView :expr`, quoted and unquoted attribute selectors, and actionable diagnostics for unsupported pseudo-classes and pseudo-elements.

Known remaining limits:

- Fragment children are flattened for `:first-child`, `:last-child`, `:nth-of-type(n)`, `+`, and `~` sibling calculations.

## Proposed grammar

Borrow from CSS, scoped to what makes sense for JSX:

| Syntax | Meaning |
|---|---|
| `A B` | `B` is a descendant of `A` (any depth) |
| `A > B` | `B` is a direct child of `A` |
| `A + B` | `B` immediately follows sibling `A` |
| `A ~ B` | `B` follows sibling `A` |
| `:scope > B` | `B` is matched relative to the current scoped subject, mainly inside `:has(...)` |
| `A:first-child` | first JSX child of its parent |
| `A:last-child` | last JSX child |
| `A:nth-of-type(n)` | nth `A` among siblings of the same tag (1-indexed) |
| `A:has(B)` | `A` whose subtree contains a `B` (constraint, not the target) |
| `A:not([attr])` | negation by selector |

Notes:

- `A B` and `A > B` already cover ~80% of disambiguation needs.
- `:has(...)` is the most powerful — and the most novel for an AST tool,
  because it can take a full selector (`Card:has(Button[variant="primary"])`).
- `:not(...)` pairs naturally with `:has` for "the cards without a primary
  button".
- Skip CSS bits that don't translate cleanly yet: pseudo-elements (`::before`).
  Attribute operators `=`, `*=`, `^=`, `$=`, `~=`, and `|=` are implemented.

## Why this matters specifically for flows / agents

flow.json is most valuable when the **same flow runs on N files** (mass
mechanical refactor). For that, selectors must be stable and structural:

```json
{ "action": "find", "selector": "DialogFooter > Button[variant=\"primary\"]", "out": "btn" },
{ "action": "prop.set", "target": "{{btn}}", "name": "data-testid", "value": "dialog-primary" }
```

The id-based `chain` workflow doesn't generalize — every file has its own
id numbering. Structural selectors are the actual unit of reuse.

## Edge cases / questions

- Does `A B` cross `JSXExpressionContainer` boundaries
  (`<A>{cond && <B/>}</A>` — does `B` count as a descendant of `A`)?
  **Recommended:** yes, by default. JSX-in-expressions is still part of the
  tree as far as the user thinks. If you need the strict version, add a
  modifier like `A >> B` for "JSX-only descendant" later.
- `:nth-of-type` semantics with `<>...</>` fragments — recommend ignoring
  fragments in the count (Fragment children flatten into the parent for
  counting purposes).
- Conflict with existing `Foo.Bar` syntax in `parseSelector` (member
  expression component names like `Dialog.Footer`). The combinator parser
  needs to be careful: `Dialog.Footer > Button` should still recognize
  `Dialog.Footer` as one tag. Space-vs-dot disambiguation, basically.

## Suggested implementation order

1. `A B` (descendant) — biggest payoff, simplest semantics.
2. `A > B` (direct child) — small delta on top of (1).
3. `:has(...)` — powerful, well worth it, requires recursive matching.
4. `:not(...)`, `:first-child`, `:last-child`, `:nth-of-type(n)` — niceties,
   add when needed.

## Priority signal

Same project, same week, I hit the "two `ScrollArea` in one file" case
twice. In a codebase with hundreds of files this is constant. Structural
selectors are what make `tedit` viable as a long-term Edit alternative for
JSX, not a one-shot script tool.
