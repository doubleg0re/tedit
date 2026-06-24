# Feature: mutate JSX text content (`text.set` / `text.replace`)

## Summary

There is currently no first-class way to change the **text content** of a JSX
element. All existing actions operate on the element itself (`rename`,
`prop.*`, `wrap`, `append`, `prepend`) or on the tree structure
(`insertComment`). Replacing the *body text* of `<Button>저장</Button>` requires
falling back to a plain string editor, which defeats the value of having an
AST-aware tool in the first place.

This is one of the most common JSX-edit cases in real codebases — copy
changes, i18n key swaps (`{t('save')}` → `{t('confirm')}`), label tweaks — so
the gap is felt quickly.

## Motivation

Concrete repeating scenarios from a real Next.js + next-intl project:

1. **Copy/label changes** across many components.
   ```tsx
   <Button>저장</Button>          →   <Button>확인</Button>
   <h1>인물관계도</h1>            →   <h1>인물 관계</h1>
   ```
2. **i18n key migrations** when a key is renamed or split.
   ```tsx
   <Button>{t("save")}</Button>           →   <Button>{t("confirm")}</Button>
   <p>{tDomain("characters.empty")}</p>   →   <p>{tDomain("characters.emptyTitle")}</p>
   ```
3. **Hardcoded → i18n** migration (string literal becomes a call expression).
   ```tsx
   <Button>저장</Button>          →   <Button>{t("save")}</Button>
   ```
4. **i18n → hardcoded** rollback (rare but happens during debugging).
   ```tsx
   <Button>{t("save")}</Button>   →   <Button>저장</Button>
   ```

All four are doable today with `grep + Edit`, but that's exactly what `tedit`
is supposed to replace for JSX — and selector-based targeting is much safer
than text matching when the same literal appears in many places (e.g. `저장`
on a dozen buttons across a feature, but you only want to change the one in
`<DialogFooter>`).

## Status — 2026-05-27

Implemented:

- `tedit text set <file> <selector> --value <text>`.
- `tedit text set <file> <selector> --expr <expr>`.
- `tedit text replace <file> <selector> --match-text <text> --with-text <text>`.
- `tedit text replace <file> <selector> --match-expr <expr> --with-expr <expr>`.
- Flow and chain actions: `text.set`, `text.replace`.
- Surgical source patches for direct JSX child text/expression edits.
- Self-closing element conversion for `text.set`.
- Whitespace-trimmed matching for JSXText while preserving surrounding
  whitespace on text-to-text replacement.

Still follow-up:

- `match.kind = "any"` exists in the document/flow API, but the CLI
  only exposes `--match-any` for raw child-source matching; richer
  structural child matching is intentionally deferred.
- Multiple overlapping text edits against the same original source
  range in one single-file chain still trip the general
  `OVERLAPPING_PATCHES` guard. Separate target ranges work.

## Resolution — 2026-05-28

`text.set` and `text.replace` are implemented across CLI, flow, and chain.
Text replacement preserves sibling nodes and surrounding whitespace, supports
expression replacement, and now reports trim-aware candidates when padded
`--match-text` input misses. Remaining items are broader structural matching
and overlapping same-range chain edits.

## Proposed shape

Two related actions, parallel to `prop.set` / `prop.remove`:

### `text.set`

Replace **all** children of the target element with a single value.

```json
{ "action": "text.set", "target": "{{btn}}", "value": "확인" }
```

```json
{ "action": "text.set", "target": "{{btn}}", "expr": "t(\"confirm\")" }
```

- `value` (string) → emits a `JSXText` child.
- `expr` (string of code) → parses as expression and emits
  `{ <expr> }` (a `JSXExpressionContainer`).
- Exactly one of `value` / `expr` is required (mirrors existing `prop.set`
  with `value` vs `--expr`).
- Replaces the entire children array. If the user only wants surgical
  text-node replacement, use `text.replace` (below).

### `text.replace` (more conservative)

Replace only matching text/expression children, leaving siblings (icons,
nested elements) intact.

```json
{
  "action": "text.replace",
  "target": "{{btn}}",
  "match": { "kind": "text", "value": "저장" },
  "with":  { "kind": "text", "value": "확인" }
}
```

```json
{
  "action": "text.replace",
  "target": "{{btn}}",
  "match": { "kind": "expr", "code": "t(\"save\")" },
  "with":  { "kind": "expr", "code": "t(\"confirm\")" }
}
```

`match.kind`:
- `"text"` → match `JSXText` children by trimmed string value.
- `"expr"` → match `JSXExpressionContainer` children whose printed inner
  expression equals the provided code (parsed to AST, compared structurally
  or by canonical source).
- `"any"` → match any child whose printed source equals the provided string.

`with.kind`: same options. This gives all four migration directions above
without special-casing.

## Why not just use `append` / `prepend` + manual removal?

- No existing action removes a single child by index or by match.
- `append` then trying to "delete the old text" leaves you stranded.
- A round-trip through a formatter would be needed anyway to clean up.

A dedicated `text.set` / `text.replace` pair keeps the mental model symmetric
with `prop.set` / `prop.remove` and lets flows express the intent declaratively.

## Edge cases worth specifying

- Whitespace-only `JSXText` children (typical when JSX is pretty-printed):
  `<Button>\n  저장\n</Button>` should match `value: "저장"` after `.trim()`.
  Document this explicitly so users don't have to guess.
- Self-closing elements (`<Button />`): `text.set` should be allowed and
  convert the element to non-self-closing with the new children.
- Mixed children (e.g. `<Button><Icon/> 저장</Button>`):
  - `text.set` replaces everything (including `<Icon/>`) — make this loud in
    docs or require an explicit `--force` style flag.
  - `text.replace` only swaps the matched text node, leaving `<Icon/>` intact
    — this is the safer default and the main reason for splitting the two
    actions.

## Surgical-patch path (related to the open recast issue)

If implemented via the same source-range patching approach that `rename`
just got, both `text.set` and `text.replace` would be byte-perfect outside
the touched span — important because text edits are exactly the case where
unrelated diff noise hurts review the most (every PR with a label change
would otherwise re-format some unrelated `mainHeader` conditional somewhere
in the same file).

## CLI sketch

```bash
tedit text set src/Button.tsx 'Button[variant="primary"]' --value "확인" --write
tedit text set src/Button.tsx 'Button' --expr 't("confirm")' --write
tedit text replace src/Page.tsx 'h1' \
  --match-text "인물관계도" --with-text "인물 관계" --write
tedit text replace src/Page.tsx 'p' \
  --match-expr 't("characters.empty")' \
  --with-expr  't("characters.emptyTitle")' --write
```

Flow form already shown above.

## Priority signal

In a single design-renewal pass on this project I'd estimate ~40–60 text
edits across components (copy tweaks + i18n key renames). Today every one of
those bypasses `tedit` and goes through string-search Edit, which is exactly
the workflow the tool is supposed to absorb. This is probably the single
highest-impact missing action for a real React/Next codebase.
