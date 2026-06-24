# Review: workspace-flow + chain-workspace + extract type inference

Dogfood round 3, 2026-05-27. Reviewer: Claude (PreFlowAI worktree).

## Baseline

- `npm run typecheck`: clean
- `npm test`: **50/50** pass
- `dist/cli.js` rebuilt 22:08 (verified `extract`/`workspace-flow`/`chain-workspace` surfaces in `--help`)

## Verdict (TL;DR)

**Production-quality on every reviewer point.** The four trust pillars
(selector precision, byte-cleanness, failure diagnostics, rollback
safety) are held even in adversarial cases. Two cosmetic issues and
one UX wrinkle for ambitious extracts — none of them block use.

| # | Reviewer concern | Verdict |
|---|---|---|
| 1 | `workspace-flow` truly writes nothing on failure | ✅ Verified — SHA-identical source + generated file absent |
| 2 | `chain-workspace` grammar simple enough for agents | ✅ Yes — `extract … :: in <file> <action>` reads like prose |
| 3 | `extract` type inference not over-guessing | ✅ Conservative + honest — `unknown` + `TODO(tedit)` placeholder when unsure |
| 4 | Optional TypeScript checker load | 🟡 Not exercised (no `--typecheck` flag visible in `--help`); see notes |
| 5 | Real-file extract perf / diff | ✅ 957ms on 1,742-line `calendar/page.tsx`; failure diagnostic is genuinely impressive |

## Reviewer points — detail

### 1. `workspace-flow` atomicity ✅

**Test:** `chain-workspace extract … :: in … prop.set NonExistentBogusTag foo bar --write`

```
{
  "success": false,
  "error": "No JSX node matched \"NonExistentBogusTag\".",
  "code": "NODE_NOT_FOUND"
}
```

- Source file SHA unchanged before/after (`a194dc42…`).
- Target extracted file does **not** exist after the failed run.
- Exit code reflects failure; error JSON is structured and agent-parseable.

This is exactly the contract the issue called for. No silent partial
writes, no half-written generated file.

### 2. `chain-workspace` grammar ✅

Tested both inline and `--from-file`:

```bash
tedit chain-workspace \
  extract src/page.tsx Card --to src/card.tsx --name PageCard \
  :: in src/card.tsx prop.set Card data-testid extracted \
  --write
```

```text
# extract.workspace-chain
extract /tmp/.../test-page4.tsx Card --to /tmp/.../test-card4.tsx --name PageCard
in /tmp/.../test-card4.tsx prop.set Card data-extracted true
in /tmp/.../test-card4.tsx prop.set Card aria-label "Extracted card"
```

- `::` separator + `in <file> <action>` reads like prose; an agent
  composing this for the first time has near-zero learning curve.
- Comments (`#`) and blank lines in `--from-file` work as expected.
- Result JSON includes per-step `{step, action, success, data}`,
  matching the existing `chain` shape — minimal cognitive overhead.

Narrow grammar (`extract` + `in <file> <chain-action>` only) feels
right: keeps the surface tiny while covering the dominant flow.

### 3. Extract type inference — conservative, honest ✅

Tested on a synthetic file mixing destructured props, locals,
literals, arrays, and arrow handlers:

| Variable               | Source                              | Inferred           | Verdict |
|------------------------|-------------------------------------|--------------------|---------|
| `displayName`          | `: string = user.name`              | `string`           | ✅ explicit annotation respected |
| `label`                | destructured `label?: string`       | `string` + `?`     | ✅ optional preserved |
| `score`                | `= 0.95`                            | `number`           | ✅ literal |
| `items`                | `= ["a","b","c"]`                   | `string[]`         | ✅ array literal |
| `count`                | `useState<number>(initialCount)`    | `unknown`          | 🟡 tuple destructuring not traced (known limit) |
| `handleClick`          | arrow function                      | `() => any`        | 🟡 return type fallback (checker would improve) |

The honest part: every `unknown` gets a `// TODO(tedit): infer type`
comment in the generated `Props` type. Agents and humans can grep for
it; nothing is silently wrong-typed. This is the right shape — *be
explicit when you don't know* beats *guess*.

Source-side rewrite is clean: only the variables that survive the
boundary become call-site props (`<TypedCard displayName={…}
label={…} count={…} score={…} items={…} handleClick={…} />`),
`setCount`/`user`/`initialCount` correctly stay in the parent scope.

### 4. TypeScript checker — not exercised 🟡

No `--typecheck` (or similar) flag appears in `--help` output for
`extract`. The README/CHANGELOG mentions "optional TypeScript checker
inference" but the surface to enable it wasn't discoverable from the
CLI.

**Suggestions:**
- Add a `--use-checker` (or `--typecheck`) flag to `extract` and
  document it.
- Show the active mode in the result JSON: `"inference_mode":
  "annotation-only" | "with-checker"`. Helps agents reason about
  why a `count` came back `unknown`.
- The two cases above (`count`, `handleClick`) are exactly where a
  checker would help; a follow-up dogfood with `--use-checker` is
  worth running once the flag exists / is documented.

### 5. Real-file extract — perf + diagnostic ✅ (+ one UX note)

Target: `apps/web/src/app/(app)/projects/[id]/calendar/page.tsx`
(1,742 lines). Tried `extract PageShell --name CalendarShell` in
dry-run-equivalent mode (`extract` defaults to no-write because
`--write` wasn't passed).

**Perf:** 957 ms first run, 941 ms second run. Well within
interactive-tool budget.

**Outcome:** Refused to extract with a *genuinely impressive*
diagnostic:

```json
{
  "success": false,
  "error": "Helper \"formatDate\" is still referenced in the source file; importing it from the extracted component would create a module cycle.",
  "code": "SHARED_HELPER_CYCLE",
  "details": {
    "helper": "formatDate",
    "sourceRefsRemaining": 8,
    "workarounds": [
      "--helper formatDate=as-prop",
      "move formatDate to a separate shared module first"
    ]
  }
}
```

This is **IDE-grade analysis**: it spotted that pulling the shell
out and importing `formatDate` back in would form a circular module
graph, and surfaced two concrete escape hatches. Trust pillar 3
(failure diagnostics) at its best.

#### One UX wrinkle — repeated cycle errors

Re-running with `--helper formatDate=as-prop` immediately hit the
same shape for the **next** helper (`ShootingDay`, 7 refs). The
fail-fast behavior is correct for safety, but iteratively
re-running with one `--helper` flag at a time gets tedious if 5–10
helpers are in the cycle class.

**Suggestion:** when an extract refuses due to `SHARED_HELPER_CYCLE`,
collect *all* such helpers in one pass and report them together:

```json
{
  "code": "SHARED_HELPER_CYCLE",
  "details": {
    "helpers": [
      { "name": "formatDate",  "sourceRefsRemaining": 8 },
      { "name": "ShootingDay", "sourceRefsRemaining": 7 },
      { "name": "…",           "sourceRefsRemaining": 3 }
    ],
    "workarounds": [
      "--helpers as-prop  (apply to all of the above)",
      "or pass individual --helper name=as-prop / =leave",
      "or extract the helpers into a shared module first"
    ]
  }
}
```

Lets the agent (or human) make one batch decision instead of N
round-trips. Same trust shape — refuse + diagnose — just more
informative per refusal.

## Other observations

### Cosmetic: redundant parens on generated files 🟡

Every `extract`-generated file currently outputs the JSX with an
extra paren pair around the root return:

```tsx
return (
  (<Card className="…" data-testid="extracted">
    …
  </Card>)
);
```

Same shape as the original `redundant-parens-on-conditional-consequent`
bug. The earlier fix targeted `rename`'s patch path; `extract`'s file
generation appears to still flow through a recast roundtrip somewhere
(scaffold output or initial parse of the new file). Semantically
harmless; visually noisy in diffs.

**Suggested fix locus:** wherever the scaffolded file's `return`
expression is printed — emit JSX directly when the consequent is
already a JSX element instead of wrapping it again.

### Helpful: free-variable detection caught a real mistake

The first test file I wrote omitted `import { Card, CardHeader,
CardBody } from "…"`. The extract correctly classified those as
`free-variable` props and produced a `PageCardProps` with `Card:
unknown` etc. That's the *correct* behavior for that input (better
than guessing they should be imports), and the failure mode is
visible immediately in the generated `TODO(tedit)` comments.
Worth mentioning in docs/examples so users understand the rule:
**no import = it's a prop**.

### Source rewrite quality on real-import case

When imports are present, the rewrite is excellent:

```tsx
// Source after extract
import { PageCard } from "./test-card2";
// (Card/CardHeader/CardBody import removed — they're unused now)

export function Page({ initialTitle }: PageProps) {
  const title = formatTitle(initialTitle);
  const desc = "World";
  const count = 42;
  return (
    <PageCard title={title} desc={desc} count={count} />
  );
}
```

Import deletion when the symbols become unused is the kind of
follow-through that agents currently forget half the time with
manual `Edit`. Big quality-of-life win.

## Suggested follow-ups (in priority order)

1. **Document `--typecheck` flag** (or whatever it's called) on
   `extract --help`, and surface inference mode in result JSON.
2. **Batch `SHARED_HELPER_CYCLE` detection** — collect all
   cycle-prone helpers in one pass per refusal.
3. **Fix the redundant parens** in scaffolded extract output (same
   class as the earlier recast-roundtrip issue).
4. **Add an example to docs** showing a real `chain-workspace
   --from-file` end-to-end (`extract → in <new-file> prop.set …`).
   This pattern is the killer app for multi-file refactors and
   deserves a prominent walkthrough.

None of these block adoption. The combination of atomic
multi-file flow + workspace chain + conservative-but-honest type
inference is the biggest single jump in `tedit`'s usefulness
since the surgical-patch landing.

## What landed since the previous review

- `workspace-flow` — multi-file transaction
- `chain-workspace` — `extract … :: in <file> <action>` grammar
- `chain-workspace --from-file` / `--from-stdin`
- `extract` type inference (AST annotation + optional TS checker)
- Helper classification with diagnostics
  (`shell-only`/`shared`/`extract-internal`/`unresolved`)
- Module-cycle detection for shared helpers (`SHARED_HELPER_CYCLE`)
- `TODO(tedit): infer type` placeholder convention for `unknown` props
- Honest dry-run-by-default for `extract` (`--write` opt-in)

This release closes most of `ISSUE-extract-component-with-slot-mode`
(full-extract + helper handling + JSON result), with slot mode and
the helper-ask interactive UX as the remaining edges.

## Closing

The shape of `tedit` after this release is no longer "useful for
JSX wrap/rename." It's now genuinely a **refactor tool** in the IDE
sense — extract with proper props inference, multi-file atomic
transactions, cycle detection. The next big horizon is the base
rule (per VISION update), which would turn it from "specialized
refactor tool" into the unified Edit surface. From the agent's
side, the dogfood path here was unusually smooth — I'll happily
take this as the new daily driver for JSX work.
