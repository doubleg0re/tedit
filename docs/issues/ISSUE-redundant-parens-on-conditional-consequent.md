# Mutations re-print conditional-consequent JSXElement with redundant parentheses

## Summary

When `flow --write` mutates **any** JSX subtree inside a file, the printer (recast)
re-serializes ancestor branches it didn't intend to touch. In particular, a
`JSXElement` that sits as the *consequent* of a `ConditionalExpression` inside a
JSX attribute value gets wrapped with an extra `(...)` parenthesis pair on output
— even though the source already wraps the whole consequent in parens.

The transform is semantically a no-op (parens are idempotent), but it produces
unwanted diff noise on every mutation run that happens to live anywhere in the
same file.

## Environment

- tedit `0.1.0` (built `dist/cli.js`)
- Node `>=20`
- recast `^0.23.11`
- @babel/parser `^7.26.10`

## Minimal repro

`page.tsx`:

```tsx
export function Page() {
  return (
    <Shell
      mainHeader={
        showHeader ? (
          // keep this comment
          <PageHead title="hello" />
        ) : undefined
      }
    >
      <ScrollArea className="x">
        <Body />
      </ScrollArea>
    </Shell>
  );
}
```

`flow.json` — touches only `ScrollArea`, never the `mainHeader` attribute:

```json
{
  "info": { "name": "swap-scrollarea-to-div" },
  "flow": [
    { "action": "find", "selector": "ScrollArea", "out": "sa" },
    { "action": "rename", "target": "{{sa}}", "name": "div" }
  ]
}
```

Run:

```bash
tedit flow page.tsx flow.json --write
```

## Expected

`mainHeader` attribute is untouched byte-for-byte. Only the `ScrollArea` →
`div` rename appears in the diff.

## Actual

The `mainHeader` consequent gets an extra paren pair around the `JSXElement`:

```diff
   mainHeader={
     showHeader ? (
       // keep this comment
-      <PageHead title="hello" />
+      (<PageHead title="hello" />)
     ) : undefined
   }
```

Comments and other formatting in the same expression are preserved correctly.
The only delta is the redundant `(` / `)` around the consequent JSX element.

## Notes

- Reproduced in a real project file
  (`apps/web/src/app/(app)/projects/[id]/daily-plan/page.tsx`) while doing an
  unrelated `ScrollArea → div` rewrite via a flow. The flow targeted *only* the
  `ScrollArea` subtree (selected with
  `ScrollArea[viewportClassName="px-7 pb-20 pt-1"]`), yet the
  unrelated `mainHeader` attribute several hundred lines above was re-printed.
- Likely cause: when a mutated node's ancestor `JSXAttribute` value (a
  `JSXExpressionContainer` wrapping a `ConditionalExpression`) is re-serialized,
  recast falls back to its generic printer for the consequent `JSXElement` and
  emits it parenthesized regardless of the original source spans.
- Workaround for end users: run a formatter (prettier) after `--write` to
  collapse the extra parens. But that defeats the "surgical edits, no churn"
  promise of `tedit`.

## Suggested investigation

- Check whether `jsx-document.ts` / the `recast.print` call path is preserving
  the original `loc`/`range`/`tokens` for nodes that weren't structurally
  changed.
- Compare the AST node identity for the consequent `JSXElement` before vs.
  after mutation — if recast sees it as "new" (no original loc), it picks its
  own formatting and adds the parens defensively.
- Possible fix: after a `rename` / `prop.*` mutation, mark only the mutated
  node as dirty (`delete node.original` or equivalent) and leave sibling /
  ancestor subtrees untouched so recast keeps their original source slices.

## Severity

Low for correctness (semantics unchanged), but **medium for the tool's UX**
because every successful mutation now risks polluting the diff with paren
churn in unrelated JSX conditionals — and these are very common in React/Next
codebases (`{cond ? (<X/>) : null}` everywhere).

## Resolution

Fixed the common mechanical-refactor path by making `rename`, `prop.set`,
`prop.remove`, and `wrap` use surgical source-range patch paths instead of
falling back to full-file `recast.print` output.

The JSX AST is still updated so flow state remains coherent, but if all
mutations in a command are source-patchable, `print()` applies only those
patches to the original source. This leaves unrelated JSX attributes and
conditional consequents byte-for-byte untouched.

Regression coverage:

- `tests/tedit.test.mjs`: `rename does not reprint unrelated conditional JSX attribute consequents`
- `tests/tedit.test.mjs`: `prop.remove does not reprint unrelated conditional JSX attribute consequents`
- `tests/tedit.test.mjs`: `prop.set does not reprint unrelated conditional JSX attribute consequents`
- `tests/tedit.test.mjs`: `wrap does not reprint unrelated conditional JSX attribute consequents`
- `tests/tedit.test.mjs`: `mixed rename prop and wrap flow stays surgical for unrelated conditional JSX`

Current limitation:

- The surgical patch path now covers `rename`, `prop.set`, `prop.remove`,
  `wrap`, `append`, `prepend`, `unwrap`, `remove`, `insertComment`, and
  direct text child edits for original source nodes. Mutations targeting nodes
  created earlier in the same in-memory flow can still fall back to recast
  because generated nodes have no original source span.
