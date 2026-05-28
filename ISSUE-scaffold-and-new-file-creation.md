# Scaffold: structured file creation (`scaffold`, `new`, `create`)

## Summary

`tedit` is currently a mutate-existing tool. Every action assumes a
parsed AST already in front of it. But agents hit the same trust
failures *before* any AST exists — when creating a new file from
scratch. Boilerplate gets retyped, indentation drifts on line one,
and bad initial structure forces refactors later.

The same structural-editing affordances that make `tedit` valuable for
mutation should extend to **file genesis**: give the agent a way to
produce a well-formed starting AST, then continue the same chain to
fill it in.

This is **not** code generation from natural language. It's
structured scaffolding — the agent declares the structure it wants,
`tedit` writes it correctly. Same dignity argument as VISION.md, just
applied one step earlier in the file's lifecycle.

## Resolution

Implemented:

- `tedit create <file> --source <source>`
- `tedit create <file> --from-file <source-file>`
- `tedit create <file> --from-stdin`
- `tedit scaffold <file> --spec <json-or-file>`
- `tedit scaffold <file>` via compact flags:
  - `--directives`
  - repeated `--imports`
  - `--export`
  - `--body`
- `tedit new <template> <file> --param key=value`
- Template resolution:
  1. `./.tedit/templates/<name>.tedit-template.json`
  2. `~/.tedit/templates/<name>.tedit-template.json`
  3. built-in starters
- Built-in starters:
  - `react-client-component`
  - `next-page`
  - `server-action`
  - `custom-hook`
  - `vitest-component-test`

Creation commands default to dry-run, refuse to overwrite existing files, and
require `--overwrite` to bypass that refusal. Generated source is parsed through
the same adapter registry before writing, so syntax failures happen before any
file write.

Regression coverage verifies:

- `create --source`, `--from-file`, and `--from-stdin`
- overwrite refusal
- scaffold from CLI flags with directives, type imports, normal imports, export
  shape, body shorthand, and follow-up selector lookup
- `new` from built-in templates and project-local templates
- `.ts` server-action creation

Known remaining limits:

- Single-file `chain` can start with `create --source ...` before structural
  or base edits. `scaffold` / `new` as first-class flow actions are still not
  implemented because the current flow engine is document-bound and
  write/dry-run state lives in the CLI layer.
- Scaffold shorthand is shallow; use `--spec` JSON for nested children or
  complex object props.

## Problem

Today's agent workflow for "create a new React component":

1. Read 3 similar files to copy boilerplate style (`"use client"`
   placement, import order, export shape).
2. Write the whole file as one `Write` call.
3. Realize an import is missing or misplaced → `Edit`.
4. Realize the JSX structure has a wrong closing tag → `Edit`.
5. Realize a prop type was forgotten → `Edit`.

Steps 2–5 are exactly the failure modes `tedit` was built to prevent
for existing files. There's no reason genesis should be the exception.

Concrete pain a Claude agent hits constantly:

- **Boilerplate drift.** Two new components in the same session end
  up with different import order, different `"use client"` placement,
  different default-vs-named export style. The agent didn't intend
  inconsistency; it just doesn't have a single source of structural
  truth.
- **Initial-structure regret.** Agent picks a flat JSX tree on line
  one, then 200 lines later needs to introduce a wrapper. Now it's
  back to fragile string `Edit` on the file it just wrote.
- **Template re-discovery.** Every project has 3–5 file shapes (page,
  client component, server action, route handler, hook). Agent
  rediscovers them every time by reading examples, instead of calling
  them by name.

## Proposed shape

Three layered primitives, from low-level to high-level:

### (1) `create` — primitive, takes a source string

```bash
tedit create src/components/Button.tsx \
  --source 'export function Button() { return <button/>; }' \
  --write
```

Or via stdin / file:

```bash
tedit create src/Button.tsx --from-file templates/button.tsx --write
cat templates/button.tsx | tedit create src/Button.tsx --from-stdin --write
```

Behavior:
- Refuses to write if the target file exists (no surprise overwrite).
  Use `--overwrite` to bypass, dry-run by default like every other
  mutation.
- Parses the source through the same JSX rule, so the resulting AST
  is immediately addressable by selectors in a follow-up chain step.

This is the minimum primitive. It also makes the next two implementable
as thin layers.

### (2) `scaffold` — declarative element/file spec

For agents that want to express the file as structure, not as text:

```bash
tedit scaffold src/components/Button.tsx \
  --directives '"use client"' \
  --imports '@/lib/utils:cn' \
  --imports 'react:type ReactNode' \
  --export 'function:Button(props: ButtonProps)' \
  --body 'button.className={cn("btn")}.children={props.children}' \
  --write
```

Flow form (the same surface, with structure):

```json
{
  "action": "scaffold",
  "file": "src/components/Button.tsx",
  "directives": ["use client"],
  "imports": [
    { "from": "@/lib/utils", "named": ["cn"] },
    { "from": "react", "named": ["ReactNode"], "type": true }
  ],
  "exports": [
    {
      "kind": "function",
      "name": "Button",
      "params": "props: ButtonProps",
      "body": { "tag": "button", "attributes": { "className": { "type": "expr", "code": "cn(\"btn\")" } } }
    }
  ]
}
```

Behavior:
- Uses the same element shorthand as `wrap` (`tag.attr=value`), so
  there's one mental model.
- `imports` block is emitted in the project's canonical sort order
  (reuse the `imports.add` logic).
- `directives` (`"use client"`, `"use server"`) always at the top.
- Output is a complete, parse-clean file — never an in-between state.

### (3) `new <template>` — named templates

For repeated shapes:

```bash
tedit new react-client-component src/components/Button.tsx \
  --param name=Button \
  --param props='variant: "primary" | "secondary"' \
  --write

tedit new next-page src/app/dashboard/page.tsx --write
tedit new server-action src/app/actions/save.ts --param name=saveDraft --write
```

Templates resolve through the same search path proposed for any
preset-like thing:

1. `./.tedit/templates/<name>.tedit-template.json` — project local
2. `~/.tedit/templates/<name>.tedit-template.json` — user global
3. `<install>/templates/<name>.tedit-template.json` — built-in starters

A template is just a `scaffold` spec with `{{param}}` substitution.
This intentionally mirrors the chain-ergonomics issue's stance on
parameterization: keep it minimal, no control flow, file-based.

### Integration with `chain`

The big win: `create` / `scaffold` / `new` plug into chain as the
first step. Genesis and mutation become one stream of consciousness:

```bash
tedit chain src/components/Card.tsx \
  new react-client-component --param name=Card as root \
  :: find 'function:Card' as fn \
  :: append @fn.body 'div.className="card"' as card \
  :: wrap @card 'article.role="article"'
```

One chain, file goes from non-existent to "component with article
wrapper around a div.card". No `Write` + 3× `Edit` sequence. No
string matching anywhere.

## Why this fits the vision

VISION.md says `tedit` isn't a code-generation tool, and this issue
respects that exactly. The distinction:

| Code generation                       | Structured scaffolding                |
|---------------------------------------|----------------------------------------|
| "Write me a button component"         | "Create a file with this AST"          |
| Natural-language → arbitrary code     | Declared structure → known-good file   |
| Agent doesn't control the structure   | Agent owns the structure declaratively |
| Reasoning + invention                 | Mechanical translation                 |

Scaffolding is the file-genesis equivalent of `rename` or `wrap`. The
agent decides *what shape* (just as it decides *what to rename*);
`tedit` makes that shape land correctly.

IDE mapping (extends the table in VISION.md):

| Human IDE affordance              | Agent equivalent                |
|-----------------------------------|----------------------------------|
| New File from Template            | `tedit new <template>`           |
| Snippet expansion (`rfc → tab`)   | `tedit scaffold`                 |
| File template variables           | `--param key=value`              |
| "Move file → update imports"      | future: `tedit move src/A.tsx src/B.tsx --update-imports` |

## Trust contract (per DESIGN-PRINCIPLES)

Scaffolding must inherit the same three pillars:

1. **Selector precision** — N/A at genesis, but the *resulting AST*
   must be parseable by the same selector grammar so the next chain
   step can target it precisely.
2. **Byte-cleanness** — output formatting must be predictable and
   consistent (project's formatter optional). No "scaffold writes
   one style, chain rewrites to another" surprises.
3. **Failure diagnostics** — if a template param is missing or a
   scaffold spec is internally inconsistent (e.g. import for a name
   not used in the body), error message must say what and where.

## Edge cases / open questions

- **Existing-file refusal default.** `create`/`scaffold`/`new` should
  refuse to overwrite by default. `--overwrite` opt-in. This is the
  scaffold equivalent of dry-run-by-default.
- **Formatter integration.** Should output go through prettier
  automatically? Recommend **no by default** — keep `tedit` strictly
  structural. Project hooks can run prettier post-scaffold if desired.
- **TS type imports.** `import type { X }` vs `import { X }` — needs
  to be expressible in the imports block.
- **Default vs named export.** Express in the export spec
  (`{ kind: "function", default: true }`).
- **JSX children that are expressions.** Already a known limit in
  chain-ergonomics shorthand — same limit applies here. JSON fallback
  available.
- **Multi-export files.** `exports` is a list. Order is preserved.
- **Non-component files (hooks, utils, route handlers).** All
  expressible via `scaffold` with non-JSX `body`. Built-in templates
  cover the common ones.

## Priority signal

In a typical feature session I create 2–5 new files (component +
test + maybe a hook + maybe a route). Each one is currently
`Write` + 1–3 `Edit` corrections. Multiply by sessions per day. The
scaffold path turns each new file from "5 careful steps" into "1
declarative call" — and unlocks the chain-as-stream-of-consciousness
workflow the VISION doc describes for the **full file lifecycle**,
not just mutation.

Recommended order of build:

1. `create --source/--from-file/--from-stdin` — primitive, smallest
   to ship, immediately unblocks "scaffold via raw template text".
2. `scaffold` declarative spec — leverages existing shorthand parser
   and `imports.add` machinery.
3. `new <template>` with file-based template resolution.
4. Built-in template starter pack (react-client-component, next-page,
   server-action, custom-hook, vitest-component-test).

## Related

- `VISION.md` — extends the IDE affordance table; honors the
  "not code generation" non-goal by staying declarative.
- `DESIGN-PRINCIPLES.md` — same three pillars (selector precision
  applies to the *result*, byte-cleanness to output, diagnostics to
  spec validation).
- `ISSUE-chain-ergonomics.md` — scaffold as the first chain step is
  the unlock; reuses element shorthand and `--from-file` patterns.
- `ISSUE-scope-expansion-non-jsx-and-expression-containers.md` —
  `imports.add` is the engine for the scaffold imports block.
