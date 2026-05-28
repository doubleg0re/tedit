# Refactor: extract component — full mode and slot mode

## Summary

A first-class **extract** refactor: pick a JSX subtree, move it to a
new file as a component, and replace the original site with an import
+ usage. The mechanical part (write new file, rewrite call site, add
import, infer props from outer-scope references) is exactly the kind
of structural work `tedit` should own — it's where human IDEs already
have a button (VS Code "Extract Component", JetBrains "Extract React
Component") and where AI agents currently fall back to manual
multi-file `Edit` choreography.

The novel bit, and the one that earns this issue its own RFC instead
of a routine port of an IDE feature, is **slot mode** — extract only
up to a chosen depth and leave the inner subtree at the call site as
`children` (or named slots). This is how layout / wrapper / provider
components are actually built in real codebases, and no mainstream
refactor tool ships it as a first-class operation.

## Why this matters

Real-world wrapper patterns this enables:

- A repeated `<Card className="…"><CardHeader/><CardBody>…</CardBody></Card>`
  shell becomes a `<MyCard title="…">…</MyCard>` reusable wrapper —
  call sites keep their unique inner content as `children`.
- A `<Modal>...<ModalFooter><Button>Save</Button><Button>Cancel</Button></ModalFooter></Modal>`
  shell becomes `<ConfirmModal onConfirm={…} onCancel={…}>{body}</ConfirmModal>`.
- Provider stacks: `<ThemeProvider><I18nProvider><AuthProvider>…</AuthProvider></I18nProvider></ThemeProvider>`
  becomes `<AppProviders>…</AppProviders>` while the inner tree stays
  at the call site.

Full-extract handles the first half ("turn this into a component").
Slot-extract handles the *whole intent* ("turn this shell into a
component but keep the variable content where it is"). Without
slot-extract, the agent either inlines too much (losing reuse) or
extracts too much (losing per-callsite variation).

## The two modes

### (A) Full extract

The selected node and everything inside becomes the new component.
Call site becomes a single self-closing element with inferred props.

**Before** (`src/page.tsx`):

```tsx
<Card className="p-4 rounded-xl border">
  <CardHeader title={pageTitle} />
  <CardBody>
    <p>{description}</p>
  </CardBody>
</Card>
```

**After call site** (`src/page.tsx`):

```tsx
<PageCard pageTitle={pageTitle} description={description} />
```

**After new file** (`src/components/PageCard.tsx`):

```tsx
interface PageCardProps {
  pageTitle: string;
  description: string;
}

export function PageCard({ pageTitle, description }: PageCardProps) {
  return (
    <Card className="p-4 rounded-xl border">
      <CardHeader title={pageTitle} />
      <CardBody>
        <p>{description}</p>
      </CardBody>
    </Card>
  );
}
```

### (B) Slot extract (the differentiator)

Extract the outer shell up to a depth boundary; inner subtree stays
at the call site as `children` (default) or as a named slot prop.

**Before** (same source):

```tsx
<Card className="p-4 rounded-xl border">
  <CardHeader title={pageTitle} />
  <CardBody>
    <p>{description}</p>
    <Button onClick={handleEdit}>Edit</Button>
  </CardBody>
</Card>
```

**Extract with `--depth 1 --slot CardBody.children`:**

After call site:

```tsx
<PageCard pageTitle={pageTitle}>
  <p>{description}</p>
  <Button onClick={handleEdit}>Edit</Button>
</PageCard>
```

After new file:

```tsx
interface PageCardProps {
  pageTitle: string;
  children: React.ReactNode;
}

export function PageCard({ pageTitle, children }: PageCardProps) {
  return (
    <Card className="p-4 rounded-xl border">
      <CardHeader title={pageTitle} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}
```

Note what happened:
- `pageTitle` (used in shell) became a prop.
- `description` and `handleEdit` (used only inside the slot) **stayed
  at the call site** — they are no longer the component's concern.
- `CardBody` is part of the shell because it sits above the slot
  boundary; its children become `{children}`.

### Named slots (multiple slot points)

Extend with `--slot <selector>=<propName>` repeated:

```bash
tedit extract page.tsx 'Card' \
  --to src/components/PageCard.tsx \
  --name PageCard \
  --slot 'CardHeader.children=header' \
  --slot 'CardBody.children=children'
```

Call site:

```tsx
<PageCard header={<HeaderBits/>}>
  <p>{description}</p>
</PageCard>
```

New file:

```tsx
export function PageCard({ header, children }: PageCardProps) {
  return (
    <Card className="p-4 rounded-xl border">
      <CardHeader>{header}</CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}
```

The unnamed `children` is implicit when only one slot exists. Named
slots are explicit props (`header`, `footer`, `actions`, …).

## CLI shape

```bash
# Full extract
tedit extract <file> <selector> \
  --to <new-file> \
  --name <ComponentName> \
  [--export default|named] \
  [--write]

# Slot extract (depth + named slots)
tedit extract <file> <selector> \
  --to <new-file> \
  --name <ComponentName> \
  --depth N                              # default: deep / full
  --slot '<inner-selector>=<propName>'   # repeatable; one without =name uses `children`
  [--write]
```

Flow form (same shape, structured):

```json
{
  "action": "extract",
  "from": "src/page.tsx",
  "selector": "Card",
  "to": "src/components/PageCard.tsx",
  "name": "PageCard",
  "export": "named",
  "slots": [
    { "selector": "CardHeader.children", "prop": "header" },
    { "selector": "CardBody.children",   "prop": "children" }
  ]
}
```

## What the runtime needs to do

1. **Resolve the source subtree** via selector (uses the existing
   selector engine, including tree combinators).
2. **Identify free variables** — identifiers referenced in the shell
   that resolve to bindings in the enclosing scope. These become
   props. (Symbol resolution = the hardest part. Initial cut: lexical
   scope walk over the surrounding function body; flag anything that
   isn't a local binding or a module import.)
3. **Classify variables by slot membership** — variables used *only*
   inside slot regions don't become props; they remain at the call
   site, inside the slot content.
4. **Generate the new file** via the same `scaffold` machinery —
   directives, imports (transferred and de-duped from the source
   file), the component function, the JSX with `{children}` /
   `{namedSlot}` substituted at slot boundaries.
5. **Rewrite the call site** — replace the original subtree with
   `<NewName ...inferredProps>{slotChildren}</NewName>` and add an
   import for the new component (uses `imports.add`).
6. **Transfer required imports** from source to new file — any
   component or value the extracted shell references that came from
   an import. Remove from source if no longer used there
   (uses `imports.remove`).
7. **All as source-range patches** — same trust contract as
   everything else; no recast roundtrip on either file.

Steps 2 and 3 are the genuinely hard ones; steps 1, 4–6 are
composition of existing primitives.

## Helper handling (file-level helpers and references)

Beyond hooks/imports/free closure variables, an extract often pulls in
**file-level helpers** — local function declarations, constants, type
aliases, sub-components defined alongside the main component in the
same file. These need a deterministic policy and a transparent result,
or the extract leaves orphans behind (helper sitting in the source
file that nothing else uses) or silently breaks the source
(helper moved out but still referenced elsewhere in the source).

### Classification

For each file-level identifier referenced by the extracted shell or
its props, the runtime classifies it by **remaining-reference count
in the source file after extraction**:

| Class | Remaining refs in source after extract | Default action |
|---|---|---|
| `shell-only` | 0 (only the extracted shell used it) | **move** to new file |
| `shared`     | ≥1 (other code in source also uses it) | **leave** in source, **import** into new file |
| `extract-internal` | identifier defined inside the shell itself | move with shell, no decision |
| `unresolved` | not a file-level binding (param, hook, import) | already handled by free-variable / import logic |

This is "no silent guess" applied to helpers: each one gets a class
with a recorded justification, and the result is reported.

### CLI flags

```bash
tedit extract <file> <selector> --to <new-file> --name <Name> \
  [--helpers move|share|ask]      # global default policy (default: move shell-only, share rest)
  [--helper <name>=move|share|leave]  # per-helper override, repeatable
  [--write]
```

- `--helpers move`: try to move every referenced helper; refuse the
  extract with an error if any helper is `shared` (forces user
  decision).
- `--helpers share`: never move helpers; always leave in source and
  add an `import` from source → new file.
- `--helpers ask` (default for `shell-only`-mixed cases): move
  `shell-only`, share `shared`, surface the breakdown in the result
  for review.

### JSON result

Every extract — dry-run or write — returns a structured result on
stdout so the caller (agent or human) can verify what happened
without re-reading the files:

```json
{
  "success": true,
  "from": "src/page.tsx",
  "to": "src/components/PageCard.tsx",
  "name": "PageCard",
  "props": [
    { "name": "pageTitle", "type": "string", "source": "free-variable" },
    { "name": "children",  "type": "React.ReactNode", "source": "slot" }
  ],
  "imports": {
    "transferred": [
      { "from": "@/components/ui/card", "named": ["Card", "CardHeader", "CardBody"] }
    ],
    "removed_from_source": [
      { "from": "@/components/ui/card", "named": ["CardHeader", "CardBody"] }
    ],
    "added_to_source": [
      { "from": "./components/PageCard", "named": ["PageCard"] }
    ]
  },
  "helpers": [
    {
      "name": "formatTitle",
      "kind": "function",
      "class": "shell-only",
      "action": "moved",
      "source_refs_remaining": 0
    },
    {
      "name": "DEFAULT_DESCRIPTION",
      "kind": "const",
      "class": "shared",
      "action": "shared-via-import",
      "source_refs_remaining": 3,
      "import_added_to_new_file": { "from": "../page", "named": ["DEFAULT_DESCRIPTION"] }
    },
    {
      "name": "PageCardProps",
      "kind": "type",
      "class": "shell-only",
      "action": "moved",
      "source_refs_remaining": 0
    }
  ],
  "diagnostics": []
}
```

Key contract points:

- **Every helper appears in the result.** No silent drops. If a
  helper was considered and not touched, it still shows with
  `action: "left"` and the count.
- **`source_refs_remaining` is the audit number.** Caller can verify
  invariants: `shell-only` should have `0`; `shared` should have
  `≥1`; any `moved` with `>0` is a bug.
- **`shared-via-import` records the new import** added to the
  extracted file, so the caller sees the dependency edge that was
  introduced (and can decide later to refactor the helper out to a
  proper shared module).
- **`diagnostics` carries ambiguity.** If two helpers have the same
  name, or a helper has a cyclic reference back into the shell, or a
  type alias depends on a value not being moved, it appears here
  with a stable code (`HELPER_NAME_COLLISION`, `HELPER_CYCLE`, etc.)
  and the extract refuses to write until resolved.

### Implementation notes

1. Walk file-level declarations once, build an identifier → location
   index.
2. For each referenced identifier in the shell, compute total
   file-level references via the same identifier resolver used by
   `imports.remove` (which already has to count usages to know
   whether an import is now unused).
3. Subtract shell references → `source_refs_remaining`.
4. Apply `--helpers` policy + per-helper overrides to derive the
   `action` for each.
5. Mutate (move / leave / share-via-import) with source-range
   patches on both files, in one transaction. If any step fails,
   nothing writes.

### Why JSON result, always

Both halves of the audience need it:

- **Humans** doing PR review get a one-glance summary of what moved,
  what stayed, and which dependency edges were introduced — without
  reading two diffs.
- **Agents** chain extract with downstream actions ("if helper X
  moved, also update its tests"). Stable JSON keys make the agent's
  follow-up reliable; parsing a human-readable diff is what got us
  here in the first place.

Even on dry-run, the JSON result reflects the planned outcome —
making it the canonical preview format, not the diff.

## Edge cases worth nailing down

- **Hook calls in the shell** (`useState`, `useEffect`, etc.). Must
  move with the shell into the new component — they can't be passed
  as props. Detect them by identifier name (`use[A-Z]…`) plus
  React-rules heuristics; surface ambiguous ones in the diagnostic.
- **Closures / handlers defined locally** (`const handleSave = () => {…}`)
  that the shell uses. Decision per-handler: pass as prop (most
  flexible), or move into the new component (most self-contained).
  Recommend prop-by-default with a `--inline-handlers` flag.
- **Generic components / TS generics.** Out of scope for v1; document
  as a known limit and emit a `// TODO: tighten types` placeholder.
- **JSX-in-attribute props (`leading={<Icon/>}`).** Treated as values;
  promote to a prop with `React.ReactNode` type.
- **Fragment shell** (`<>…</>`). The new component returns the
  fragment as-is; no `<div>` wrapper invented automatically.
- **Name conflicts in the destination file** — if the file exists,
  refuse by default (matches `create` semantics); `--append` mode
  could add the new component alongside existing exports, but that's
  follow-up.
- **CSS / `className` handling.** Unchanged — `className` strings
  travel with the shell. No automatic css-module extraction.

## Trust contract (per DESIGN-PRINCIPLES)

- **Selector precision** — extract operates on the exact node the
  selector resolves to; slot selectors must also resolve uniquely
  within the extracted subtree, else error.
- **Byte-cleanness** — call site and new file are both source-range
  patches. Imports added/removed via existing `imports.*` machinery.
  Untouched regions of either file remain byte-identical (modulo the
  unavoidable insertion span).
- **Failure diagnostics** — every free variable that the runtime
  can't confidently classify as "prop", "hook", or "import" must be
  surfaced as a structured diagnostic, not silently dropped or
  guessed. Example:

  ```
  extract: cannot classify identifier 'analytics' (used at line 142).
    Candidates:
      - inferred prop (default if it appears in the surrounding function signature)
      - hoisted from an outer closure (declare as prop or move binding)
    Pass --as-prop analytics or --inline analytics to disambiguate.
  ```

This is the kind of operation where silent wrong-guessing is the
worst possible failure mode. Better to ask than to extract a broken
component.

## Why this fits the vision

Extends the VISION.md IDE-affordance table by one of the highest-
leverage rows:

| Human IDE affordance | Agent equivalent in `tedit` |
|---|---|
| Extract Component (full) | `tedit extract … --to …` |
| Extract Component (slot/children) | `tedit extract … --depth N --slot …` |

`Extract Component (slot)` is the row that doesn't really exist in
mainstream IDEs as a clean operation. Shipping it is `tedit`'s chance
to leapfrog — give AI agents an affordance humans don't have yet,
because the agent operates structurally and can reason about slot
boundaries explicitly.

## Priority signal

Every design-system migration, every "this card pattern repeats 8
times" cleanup, every "extract this provider stack" refactor is this
operation. In one session I'd estimate 1–3 extract operations on
average; in a sustained refactor sprint, 10+. Today every one of
those is "agent reads source, agent writes new file, agent rewrites
call site, agent adds import, agent removes unused import, agent
re-checks both files." Five+ steps that should be one tool call.

## Suggested build order

1. **Full extract** (no slots). Lands the symbol-resolution machinery
   and the call-site rewriting; depends on `scaffold` and
   `imports.*`.
2. **`children` slot** (single, unnamed slot). Adds the
   slot-boundary cut and variable-classification-by-slot-membership.
3. **Named slots** (`--slot inner=propName`). Generalizes step 2.
4. **Diagnostics for ambiguous identifiers** — the "ask, don't
   guess" path. Most important polish for trust.

## Related

- `VISION.md` — extends the IDE affordance table; also the clearest
  case of "give agents something humans don't have" (slot extract).
- `DESIGN-PRINCIPLES.md` — symbol classification is the canonical
  application of pillar 3 (diagnostics over silent guessing).
- `ISSUE-scaffold-and-new-file-creation.md` — `scaffold` is the
  engine for writing the new file.
- `ISSUE-scope-expansion-non-jsx-and-expression-containers.md` —
  `imports.add` / `imports.remove` are the engine for the import
  transfer.
- `ISSUE-selector-tree-combinators.md` — slot selectors rely on
  precise descendant targeting.

## Resolution

Implemented v1.

Landed:

- `tedit extract <file> <selector> --to <new-file> --name <Name>`
  for full JSX component extraction.
- Explicit slot mode with repeated
  `--slot '<selector>.children[=<propName>]'`.
- Named slots as `ReactNode` props; unnamed slot defaults to
  `children`.
- Free-variable prop inference for identifiers referenced by the
  extracted shell.
- Import transfer into the new component file for imported bindings
  referenced by the shell.
- Source call-site import insertion and source-range replacement.
- Source unused import cleanup for imports transferred into the
  extracted component when the source no longer references them.
- Destination overwrite refusal by default, with `--overwrite` escape.
- Always-JSON extract result with `props`, `imports`, `helpers`,
  `slots`, `diagnostics`, and both source/new-file diffs.
- `--depth N` without explicit `--slot` now fails with
  `EXTRACT_SLOT_REQUIRED` and structured suggested slots.
- `--auto-slot` intentionally accepts the suggested slots for
  `--depth N`.
- Helper policy landed with `ask` default: `shell-only` helpers move
  into the new file. Shell-only helper dependencies and their imports
  are pulled into the extracted file as a closure.
- `shared` helpers now fail with `SHARED_HELPER_CYCLE` because source
  imports the extracted component, so importing source helpers back into
  the extracted file would create a module cycle. Explicit workaround:
  `--helper name=as-prop`, or move the helper to a separate module first.
- Helper overrides landed through `--helpers ask|move|share|as-prop`
  and repeated `--helper name=move|share|leave|as-prop`.
- Free-variable props are inferred from clear TypeScript annotations;
  unresolved props are emitted as `unknown` with
  `// TODO(tedit): infer type` markers. `--typecheck` can ask the
  TypeScript checker for local inferred expression types.
- Workspace flow and `chain-workspace` extract steps landed for
  multi-file extract followed by mutations in the created file.
- Extract prop-overflow guardrail landed via `--max-props` /
  `--accept-large-props`.

Deliberately left as follow-ups:

- Single-file `chain` cannot run extract because extract is inherently
  multi-file; use `workspace-flow` / `chain-workspace`.
- Type inference remains conservative when neither AST annotations nor
  the optional local TypeScript checker provide a reliable type.
- Moving shared helpers into a new shared module automatically.

Regression coverage:

- `extract creates a component file and replaces the call site`
- `extract slot mode leaves slot content at the call site`
- `extract supports named slots`
- `extract rejects depth without explicit slot and suggests candidates`
- `extract moves shell-only helper dependency closure`
- `extract detects shared helper cycles`
- `extract can pass a shared helper as a prop by explicit override`
- `extract refuses to move shared helpers under move policy`
- `extract auto-slot uses depth suggestions when explicitly requested`
- `extract dry-run returns JSON and does not write files`
- `workspace-flow extracts and mutates the created file in one transaction`
- `chain-workspace runs extract and file-scoped chain steps`

Verification:

- `npm test` passed: 74/74 tests.
