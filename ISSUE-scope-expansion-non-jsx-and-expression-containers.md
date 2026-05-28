# Scope: extend reach beyond pure JSX (imports, top-level statements, expression-container JSX)

## Summary

Today `tedit`'s `jsx` rule only sees JSX elements that sit in plain JSX
context. Two practical blind spots:

1. **Outside JSX (module-level code).** `import` declarations, `export`s,
   top-level `const` / `function` bodies — invisible to selectors. So the
   most common companion edit to any JSX change (adding/removing an import
   when you swap a component) falls back to string-based Edit.
2. **JSX inside expression containers.** When JSX is wrapped in
   `{ ... }` — conditional consequent, `.map(...)`, ternary alternate,
   short-circuit (`cond && <X/>`) — the inner elements are technically still
   selectable, but you can't address the *container itself* or restructure
   the expression. Common refactors like "turn this `cond && <X/>` into
   `cond ? <X/> : <Y/>`" or "extract this `.map` callback into a separate
   variable" have no flow primitive.

The combined effect: a single conceptual change (e.g. "replace `ScrollArea`
with `ShellScrollArea` everywhere") usually needs `tedit` for the JSX swap
**and** a plain Edit for the import change. That defeats the safety
guarantee of selector-driven mutation — half the change is back to string
matching.

## Resolution

Implemented in the JSX rule:

- `imports.add`
- `imports.remove`
- `imports.rename`
- `imports.move`
- `expr.replace`
- `expr.wrap`
- `expr.unwrap`
- `expr.toTernary`
- `expr.toShortCircuit`
- `:expr` selector support for matching `JSXExpressionContainer` nodes

CLI examples now work:

```bash
tedit imports add src/Page.tsx --from "@/components/ui/button" --named Button,IconButton --write
tedit imports remove src/Page.tsx --from "@/components/ui/scroll-area" --named ScrollArea --write
tedit imports rename src/Page.tsx --from "@/components/ui/button" --name Button --to IconButton --write
tedit imports move src/Page.tsx --named Button --from "@/old" --to "@/new" --write
tedit expr replace src/Page.tsx 'ContentView :expr' --code 'cond ? <X /> : <Y />' --write
tedit expr wrap src/Page.tsx 'Label :expr' --code 'String($expr)' --write
tedit expr toTernary src/Page.tsx 'Panel :expr:has(X)' --alternate '<Y />' --write
tedit expr toShortCircuit src/Page.tsx 'Panel :expr:has(X)' --write
```

Flow/CLI coverage now verifies import add/remove/rename/move plus expression replacement, wrapping, ternary conversion, and short-circuit conversion. These actions use source-range patches rather than a whole-file recast print.

Known remaining limits:

- Import declaration rewrites may normalize complex multi-line import formatting to one line.
- More complex import transactions are not modeled as a dedicated import AST transaction yet; simple same-declaration add/remove flows are covered by source patch tests.
- `expr.toShortCircuit` and `expr.unwrap` only support ternaries whose alternate is `null`, `false`, or `undefined`.

## Motivation — concrete cases

### (1) Import companion edits

Every JSX rename usually drags an import edit:

```tsx
- import { ScrollArea } from "@/components/ui/scroll-area";
+ // (removed)
```

or

```tsx
- import { Button } from "@/components/ui/button";
+ import { Button, IconButton } from "@/components/ui/button";
```

Today there's no `tedit import add|remove|replace` action. So a "rename
component everywhere" flow can't actually finish — it leaves orphaned
imports that the user has to clean up out-of-band.

### (2) Conditional / map JSX restructuring

Patterns we hit all the time:

```tsx
{cond && <X/>}                         →  {cond ? <X/> : <Y/>}
{cond ? <A/> : null}                   →  {cond && <A/>}
{arr.map(x => <Item key={x.id}/>)}     →  {arr.map(renderItem)}   // hoist
{children}                             →  {Array.isArray(children) ? ... : children}
```

These are JSX-adjacent but not pure JSX — they live in `JSXExpressionContainer`
nodes whose child is an arbitrary expression. The current rule can find
`<X/>` inside, but can't say "the conditional wrapping `<X/>`" or "turn
this `&&` into a ternary".

Even something as ordinary as "select the consequent JSX of *that* ternary
that lives in *that* attribute" has no selector form today — and recast's
re-printing of those containers is exactly what produced the
redundant-parens bug we already filed.

## Proposed shape — two complementary directions

### A. New `imports` rule (or sub-namespace of `jsx`)

Even kept small, this absorbs most of the missing companion edits:

```bash
tedit imports add    src/Page.tsx --from "@/components/ui/button" --named Button,IconButton --write
tedit imports remove src/Page.tsx --from "@/components/ui/scroll-area" --named ScrollArea --write
tedit imports rename src/Page.tsx --from "@/components/ui/button" --renameDefault MyButton --write
tedit imports move   src/Page.tsx --named Button --from "@/old" --to "@/new" --write
```

Flow form:

```json
{ "action": "imports.remove", "from": "@/components/ui/scroll-area", "named": ["ScrollArea"] }
```

Behaviors:
- `add` merges into an existing `import { ... } from "X"` if one exists,
  otherwise inserts a new declaration in sorted order.
- `remove` deletes a name; if it's the last named import and there's no
  default/namespace, removes the whole declaration.
- All of the above are pure source-range patches — no recast roundtrip
  needed — so they should be byte-clean by construction.

This alone closes the most painful gap: companion import edits during
component renames / wraps.

### B. Expression-container actions inside JSX

Smaller set, but high leverage when you need it:

| Action | Effect |
|---|---|
| `expr.wrap`     | Wrap an inner expression: `{x}` → `{cond ? x : null}` |
| `expr.unwrap`   | Strip the wrapper: `{cond ? <A/> : null}` → `{cond && <A/>}` |
| `expr.toTernary`| `{cond && X}` → `{cond ? X : null}` (and vice versa with `toShortCircuit`) |
| `expr.replace`  | Replace whole expression by parsed code: `{t("a")}` → `{t("b")}` |

Targeting:
- A new selector pseudo: `:expr` — match the `JSXExpressionContainer` itself
  rather than its inner JSX. e.g. `mainHeader :expr` = the `{ ... }` around
  the conditional in `mainHeader={...}`. Pairs with the tree-combinator
  proposal in the sibling issue.
- Or address via the inner node's parent through a relation like
  `find` → `parent.expressionContainer`.

`expr.replace` overlaps with the text-content issue when the expression
sits as a JSX child (`<Button>{t("save")}</Button>`). The two should agree
on shape — probably `text.set --expr` is the JSX-child convenience, and
`expr.replace` is the general form for any `JSXExpressionContainer`.

## Why not "just use Edit for these"

For one-off edits, fine. But:

1. **Safety.** The whole pitch of `tedit` is "AST-aware, can't put the
   change in the wrong place." String matching for imports is fragile
   (alias re-ordering, trailing commas, multi-line imports). String
   matching for ternaries is worse.
2. **Flow reuse.** A flow that does "swap `<ScrollArea>` for `<div>`
   everywhere it appears" should also be able to clean up the import.
   Splitting that into "flow + post-flow shell script" breaks the
   declarative model.
3. **Agent dispatch.** If an agent emits a flow.json describing the whole
   change, the runtime can validate selectors and reject impossible ops
   before any write. With raw post-flow shell, the agent leaks string-edit
   risk back in.

## Suggested priority

1. **Imports rule** — biggest single-day pain reduction, easiest to scope.
2. **`expr.replace`** — natural extension of the `text.set --expr` direction
   in the text-content issue.
3. `expr.toTernary` / `expr.toShortCircuit` / `expr.wrap` / `expr.unwrap` —
   nice to have, lower frequency.
4. `:expr` selector pseudo — gated on (1) and (3) actually being needed
   from selectors.

## Related issues

- `ISSUE-text-content-mutation.md` — `text.set` / `text.replace` overlap
  with `expr.replace` when targeting JSX children.
- `ISSUE-selector-tree-combinators.md` — `:has`/descendant selectors make
  the `:expr` targeting story coherent.
- `ISSUE-redundant-parens-on-conditional-consequent.md` — the conditional
  re-print bug is exactly the symptom of not having first-class
  expression-container handling.
