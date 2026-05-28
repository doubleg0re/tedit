# Chain ergonomics: named outputs, JSON shorthand, file/heredoc input

## Summary

`tedit chain` already expresses the "find X :: do Y :: do Z" intent
beautifully — it reads like a sentence and matches how users actually
think about JSX refactors. With three small additions it becomes good
enough that ~90% of real flows don't need a `flow.json` file at all,
and the heavier "macro/preset" layer becomes unnecessary.

The three additions:

1. **Named outputs** (`as <name>`) — multiple `find`s in the same chain
2. **JSON-value shorthand** (`tag.attr="value"`) — escape shell quoting hell
3. **File / heredoc input** (`--from-file`, `--from-stdin`) — multi-line
   chains stay readable

## Resolution

Implemented:

- `as <name>` on any chain step; this maps directly to flow `out`.
- `@name` and `@name.path` references; `$ret` and `$ret.path` continue to work.
- Element shorthand for `append`, `prepend`, and `wrap`.
- `--from-file <path>` and `--from-stdin` chain input.
- Line-based chain tokenization with blank lines ignored, `#` comments, and implicit `::` between non-empty lines.

Covered examples:

```bash
tedit chain page.tsx \
  find 'ScrollArea[viewportClassName="px-7"]' as sa \
  :: rename '@sa' div \
  :: find DailyPlanBody as body \
  :: wrap '@body' 'div.className="flex gap-4"' \
  :: prop.set '@sa' data-testid scroll-body
```

```text
# edit.chain
find ScrollArea[viewportClassName="px-7"] as sa
rename @sa div
prop.remove @sa viewportClassName
find DailyPlanBody as body
wrap @body div.className="flex gap-4"
```

```bash
tedit chain page.tsx --from-file edit.chain --write
```

Element shorthand currently supports:

| Shorthand | Meaning |
|---|---|
| `div` | `{ "tag": "div" }` |
| `div.className="flex gap-2"` | string attribute |
| `Button.variant="primary".disabled` | string plus boolean attribute |
| `Button.onClick={handleClick}` | expression attribute |
| `Button.children="Save"` | single text child |

Regression coverage includes named outputs, `@refs`, shorthand boolean/expression/text children, `--from-file`, and `--from-stdin`.

Known limits:

- Shorthand is intentionally shallow; use JSON for nested children or complex object props.
- `children={expr}` is not supported by shorthand yet because `TreeNodeSpec` does not model JSX expression children.
- Chain text has no templating or control flow by design.

## Motivation

The dogfood flow we wrote (7 atomic ops, 2 finds) maps to chain like
this today:

```bash
tedit chain page.tsx \
  find 'ScrollArea[viewportClassName="px-7 pb-20 pt-1"]' \
  :: rename '$ret' div \
  :: prop.remove '$ret' viewportClassName \
  :: prop.remove '$ret' verticalScrollbarStyle \
  :: prop.set '$ret' className 'flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pb-20 pt-1 [scrollbar-gutter:stable]' \
  :: find DailyPlanBody \
  :: wrap '$ret' '{"tag":"div","attributes":{"className":"flex flex-1 flex-col gap-4"}}'
```

Three pain points:

1. **`$ret` is the previous step only.** Once we hit `find DailyPlanBody`
   we lose the reference to the original `ScrollArea`-now-`div`. If we
   need to come back to it later (e.g. add a `data-testid` after the
   wrap), we'd have to re-find it. Brittle.
2. **JSON shell quoting.** The `wrap` argument
   `'{"tag":"div","attributes":{"className":"flex ..."}}'` is fragile —
   one nested double-quote inside a tailwind arbitrary value (e.g.
   `bg-[url("x.png")]`) and the whole chain explodes. Real className
   strings hit this constantly.
3. **One-line shell command** gets unreadable past ~5 steps. Backslash
   continuation helps a little but lookups across "what did `$ret`
   point to at step 4?" are mental gymnastics.

Fix the three and `chain` covers the same surface as a hand-written
flow.json for almost every case.

## Proposed additions

### (1) `as <name>` — named outputs

Bind any step's result to a name and reference it later:

```bash
tedit chain page.tsx \
  find 'ScrollArea[viewportClassName="px-7 pb-20 pt-1"]' as sa \
  :: rename '@sa' div \
  :: prop.remove '@sa' viewportClassName \
  :: prop.remove '@sa' verticalScrollbarStyle \
  :: prop.set '@sa' className 'flex min-h-0 ...' \
  :: find DailyPlanBody as body \
  :: wrap '@body' div.className="flex flex-1 flex-col gap-4"
```

Notes:
- `@<name>` for explicit references; `$ret` keeps working as the
  implicit "previous step" for short chains.
- Names live for the duration of the chain. No scoping rules needed.
- In flow.json the same role is already played by `out` — chain just
  needs the surface syntax.

### (2) JSON-value shorthand — `tag.attr="value"`

Wherever a step takes a JSON element/object today, accept a dotted
shorthand:

| Shorthand | Equivalent JSON |
|---|---|
| `div` | `{"tag":"div"}` |
| `div.className="flex gap-2"` | `{"tag":"div","attributes":{"className":"flex gap-2"}}` |
| `Button.variant="primary".disabled` | `{"tag":"Button","attributes":{"variant":"primary","disabled":true}}` |
| `Button.onClick={handleClick}` | `{"tag":"Button","attributes":{"onClick":{"type":"expr","code":"handleClick"}}}` |
| `Button.children="확인"` | `{"tag":"Button","children":[{"type":"text","value":"확인"}]}` |

Rules:
- Tag name comes first, then `.attr=value` pairs.
- Bare `.attr` (no `=`) means `attr={true}` (JSX boolean shorthand).
- `={expr}` syntax for expressions; `="..."` for string literals.
- For values that contain shell-hostile characters, fall back to JSON
  in single quotes — the shorthand is opt-in, not exclusive.

This single change kills 90% of shell quoting pain. The remaining 10%
(complex objects, deeply nested children) are exactly the cases where
heredoc/file input takes over.

### (3) `--from-file <path>` and `--from-stdin`

When a chain is too long for one shell line, write it as plain text
with one step per line:

```text
# page-revert.chain
find ScrollArea[viewportClassName="px-7 pb-20 pt-1"] as sa
rename @sa div
prop.remove @sa viewportClassName
prop.remove @sa verticalScrollbarStyle
prop.set @sa className "flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pb-20 pt-1 [scrollbar-gutter:stable]"
find DailyPlanBody as body
wrap @body div.className="flex flex-1 flex-col gap-4"
```

```bash
tedit chain page.tsx --from-file page-revert.chain --write
```

Or via heredoc:

```bash
tedit chain page.tsx --from-stdin --write <<'CHAIN'
find ScrollArea[...] as sa
rename @sa div
...
CHAIN
```

`#` is comment. `::` is implicit between lines (so users don't have to
type it). This is the same flow.json semantics in a friendlier
notation — and because it's plain text, it diffs and reviews well in
PRs when checked in.

## Why this is enough (and macros aren't needed in v1)

Once chains can:
- name multiple finds (`as`),
- express JSX elements without shell-escaped JSON (shorthand), and
- live in a file or heredoc (multi-line),

writing a chain becomes as light as writing a shell pipeline. The
"semantic chaining" goal from the macro discussion is met by the chain
itself reading like a sentence — no template/preset layer required.

Reuse across files is then a plain shell concern:

```bash
for f in apps/web/src/components/**/*.tsx; do
  tedit chain "$f" --from-file presets/swap-scrollarea.chain --write
done
```

If a team later finds itself running the same chain hundreds of times
across files, *then* a parameterized preset layer might be worth
building. But that's a follow-up driven by real demand, not a
prerequisite.

## Non-goals

- No variable substitution / templating in chain text yet. If you need
  parameters, write a tiny shell wrapper. Add templating only when N
  real users ask for it.
- No control flow (`if`, loops). Use shell `for` / `if` around the
  chain command. Keep the chain itself linear and dumb.
- No new actions. This is purely surface ergonomics over the existing
  atomic op set.

## Suggested implementation order

1. `as <name>` parsing in chain + `@<name>` resolution. Cheapest, biggest
   immediate payoff (unlocks multi-find chains).
2. `--from-file` / `--from-stdin` with `#` comments and implicit `::`
   between non-blank lines.
3. JSON-value shorthand parser. Most engineering of the three, but it's
   the one that makes one-line chains actually usable in real shells.

## Related issues

- Replaces the previously drafted "macro/preset system" idea — chain
  ergonomics covers the same need with far less surface area.
- Composes with the other open issues unchanged: every additional atomic
  op (`text.set`, `imports.*`, `expr.*`) and every selector improvement
  (`A > B`, `:has`) automatically becomes usable from chain.
