# Design quality guardrails: state clustering, props overflow, file length

## Summary

`tedit` today guarantees the **mechanical safety** of a refactor — the
right node, the right mutation, byte-clean output. That's necessary
but not sufficient. An AI agent (or a tired human) can still pick a
mechanically safe path that produces a **design-quality disaster** —
an 81-prop "extracted" component, a 2700-line file split into a
1700-line file plus a 1000-line body, a useState-pile-of-32 that
should have been three custom hooks.

The mechanical safety lets the agent move fast. The missing
guardrails would let the user *stay in control of design quality*
while the agent moves fast. This issue proposes three guardrails that
share one mechanism: **analyze before acting, emit diagnostics, ask
the user, never silently take the easy way out.**

## Status — 2026-05-27

Implemented:

- Passive file-length threshold warnings on mutation/create/base-edit
  outputs and workspace file changes.
- `.tedit/config.json` support for `file_length_thresholds` and
  `max_extract_props`.
- `tedit analyze-state <file> [--json]` with `useState` binding
  discovery, handler read/write usage, connected state clusters, and
  custom-hook / keep-local recommendations.
- Active extract prop overflow guardrail. `extract` now refuses by
  default when predicted props exceed the configured max (default 12)
  and returns `EXTRACT_PROPS_OVERFLOW` with prop details and state
  cluster diagnostics.
- Explicit overrides: `--max-props N` and `--accept-large-props`.
- Workspace extract and `chain-workspace extract` understand the same
  prop-overflow flags.

Still follow-up:

- Automatic shared-module movement for helpers remains a larger extract
  follow-up, because it changes module boundaries and import ownership.
- More advanced cluster boundary heuristics beyond the current name/domain
  subcluster suggestions, such as subtree containment and ambiguous cluster
  resolution.
- Frequency persistence for repeated file-length warnings across
  separate CLI invocations. Current behavior warns only when the edit
  crosses a threshold within the current run.

## Resolution — 2026-05-28

The guardrail core is implemented: file-length warnings, configurable
thresholds, extract prop-overflow blocking, `analyze-state`, conservative
`refactor-state`, and custom-hook extraction for simple local clusters.
Large-cluster guidance now flags likely over-clustering, marks giant clusters
as low-confidence context candidates, and includes suggested subclusters.
`refactor-state --external-deps params` can explicitly thread external handler
dependencies into generated hooks while preserving fail-by-default behavior.

## Origin (the embarrassing one)

Earlier this session I extracted `DailyPlanBody` from a 2700-line
`page.tsx`. The mechanics worked. The result was a component with an
**81-field props interface** and a call site with 81 prop assignments
stretched across 80 lines. I made that decision unilaterally — no
question to the user, no warning, no "this might be the wrong cut."
The user only realized the cost later.

In other words: I picked the safe-and-lazy path because no tool was
standing between me and that path. Mechanical safety alone enables
that mistake; it doesn't prevent it.

Guardrails turn "agent's lazy default" into "user's design choice."

## The three guardrails

All three follow the same pattern: **analyze-and-warn baked into the
mutation command by default; explicit override required to silence**.
No new burden on the agent (no separate command to remember) — the
warning shows up at exactly the moment the decision matters.

### (A) File length threshold (passive)

After any `--write` (or in dry-run preview), report file size in
lines and warn at configurable thresholds:

```
tedit: page.tsx is now 2,720 lines.
  - 500–1000 lines: 'consider splitting' (info)
  - 1000–2000 lines: 'splitting recommended' (warn)
  - >2000 lines: 'splitting urgent' (warn, with exit code 0 still)
  Suggested next step: tedit analyze-structure page.tsx
```

Configurable in `.tedit/config.json`:

```json
{
  "file_length_thresholds": {
    "info": 500,
    "warn": 1000,
    "urgent": 2000
  }
}
```

This is **passive** — never blocks the write, just nudges. Frequency
control: only warn when the file *crosses* a threshold this run
(don't spam every save).

### (B) Extract props overflow (active)

When `tedit extract` predicts the new component would have more than
N props (default: 12), refuse to write by default and emit a
structured suggestion:

```
extract: predicted 81 props on DailyPlanBody.
  This is usually a signal that source-side state should be
  reorganized before extraction.

  Detected clusters (heuristic, see below):
    timetableInteraction  (5 states)  → recommended: custom hook
    crewImport            (4 states)  → recommended: custom hook
    callTimeRows          (3 states)  → recommended: custom hook
    deptPrep              (2 states)  → recommended: custom hook
    ttContextMenu         (1 state)   → recommended: keep local
    ungrouped             (51 misc)   → see analyze-state output

  Options:
    --accept-large-props      extract as-is (81 props)
    --refactor-first          run state analysis before extraction
    --max-props=N             change the threshold for this run
```

Threshold rationale: 12 is what most React style guides cite as the
upper bound for readable prop lists. Configurable per project. The
*active* part is critical — the agent can't silently go past the
threshold; the user is in the loop by default.

### (C) State complexity (proactive)

A standalone `analyze-state` command (with the same logic that powers
guardrail B) that the user — or the agent, when asked — can run any
time:

```bash
tedit analyze-state apps/.../page.tsx
```

Outputs structured JSON (canonical format, same as everywhere):

```json
{
  "file": "apps/.../page.tsx",
  "states_total": 32,
  "handlers_total": 21,
  "clusters": [
    {
      "name": "timetableInteraction",
      "states": ["timetableRows", "dragIdx", "dragTable", "rowDropIndex", "rowDragHeight"],
      "handlers": ["handleDragStart", "handleDragEnd", "handleRowDragOver", "handleSceneDrop", "handleTimetableDrop"],
      "recommendation": "custom-hook",
      "confidence": "high",
      "reason": "all 5 states co-read and co-write within 5 shared handlers; zero outside reference",
      "extract_to": "src/.../use-timetable-interaction.ts"
    },
    {
      "name": "crewImport",
      "states": ["crewImportOpen", "crewImportDayId", "crewImportCandidates", "crewImportPreview"],
      "recommendation": "custom-hook",
      "confidence": "high",
      "reason": "tight coupling, 4 states + 3 handlers, used only inside a modal subtree"
    },
    {
      "name": "ttContextMenu",
      "states": ["ttContextMenu"],
      "recommendation": "keep-local",
      "confidence": "high"
    }
  ],
  "ambiguous": [
    {
      "states": ["sectionDropdownOpen", "activeSections"],
      "candidates": ["sectionUI-cluster", "merge-into-timetable"],
      "resolution": "pass --cluster-decide sectionDropdownOpen=sectionUI"
    }
  ],
  "ungrouped": ["isLoading", "selectedDayId"],
  "summary": {
    "auto_decidable": "5 / 7 clusters",
    "user_input_needed": "2 ambiguous"
  }
}
```

Paired with `refactor-state`:

```bash
tedit refactor-state apps/.../page.tsx --plan plan.json --write
```

Where `plan.json` is the (possibly edited) output of `analyze-state`.
Two-pass design is intentional: state reorganization is
design-bearing, never silent-apply.

## Shared mechanism — the analysis layer

All three guardrails share a single source of truth:

1. **AST walk + use-graph builder** — for every `useState`, where is
   it read, where is it written, what handler closures use it.
2. **Cluster detector** — connected-component analysis on the
   use-graph; states that move together get grouped.
3. **Cluster → recommendation rules** —
   - cluster contained in one subtree, no outside refs → `custom-hook`
   - cluster read by multiple subtrees, written in one → `context`
   - cluster read+write in one place only → `keep-local`
4. **Diagnostic emit** — structured JSON in canonical format; same
   keys whether triggered by `extract`, `analyze-state`, or by
   guardrail A/B.

This is one engine, three surfaces. Implementing it once unlocks all
three guardrails plus the algorithmic-state-refactoring vision from
earlier.

## Why guardrails, specifically, not just better defaults

The 81-prop disaster wasn't caused by a bad default. It was caused
by **the absence of friction at the moment of decision**. The agent
called `extract`, the tool said yes, the agent moved on. There was no
point in the flow where "is 81 props really what you want?" got
asked.

Guardrails insert that question — *only* at the moment it's relevant,
*only* when the threshold is crossed, *never* as a generic
"are you sure?" prompt. The cost-benefit is overwhelming:

- Cost: one extra round-trip when threshold crossed (5–10% of
  extract calls).
- Benefit: 0 silent design disasters. Every prop-overflow / file-
  length problem becomes a user decision instead of an agent default.

## Agent self-honesty (why this is the right shape)

Honest take from the agent's side: a guardrail as a **separate
command** ("you can run `tedit analyze-state` before extract") would
*not* be used. Agents (and humans) skip optional analysis steps under
any time pressure. The only design that actually changes behavior is
**guardrails baked into the default action** — when the threshold
fires, the agent literally cannot proceed without surfacing the
decision to the user (or explicitly overriding).

This is the same reason browsers warn before form resubmission, the
same reason `rm -rf /` prompts, the same reason `git push --force`
takes more typing than `git push`. Friction in the right place is the
feature, not a bug.

## CLI summary

```bash
# Guardrail A: passive, automatic on any mutation
tedit rename file.tsx 'Foo' Bar --write
# → may print: "tedit: file.tsx is now 1,420 lines. splitting recommended."

# Guardrail B: active, in `extract`
tedit extract page.tsx 'DailyPlanBody' --to ... --name ...
# → may refuse: "predicted 81 props, options: --accept-large-props | --refactor-first | --max-props=N"

# Guardrail C: explicit analysis (manual or scripted)
tedit analyze-state page.tsx
tedit refactor-state page.tsx --plan plan.json --write
```

Flow form (after multi-file flow lands):

```json
[
  { "action": "analyze-state", "file": "page.tsx", "out": "plan" },
  { "action": "refactor-state", "file": "page.tsx", "plan": "{{plan}}" },
  { "action": "extract", "from": "page.tsx", "selector": "DailyPlanBody", "to": "..." }
]
```

One chain — analyze → reorganize → extract — instead of the current
"extract, regret, manual fixup" cycle.

## Trust contract (per DESIGN-PRINCIPLES)

- **Selector precision** — cluster detection operates on the same
  AST and identifier resolution as everything else; no new
  string-matching surface.
- **Byte-cleanness** — `refactor-state` uses source-range patches
  like every other mutation. Cluster moves transform `useState` →
  `useFooContext()` or hook-call call-sites with zero unrelated
  re-formatting.
- **Failure diagnostics** — ambiguous clusters become diagnostics,
  not guesses. `refactor-state` refuses to write a plan that
  contains unresolved `ambiguous` entries.
- **Rollback safety** — `refactor-state` is multi-edit; the same
  git-aware default + backup applies as for any other write.

## Build order

1. **Use-graph builder + cluster detector** — the engine. Internal.
2. **Guardrail A (file length)** — easiest layer, instant value;
   just a line-count check in the mutation post-step.
3. **`analyze-state` command** — exposes the engine as JSON; no
   mutation yet, lowest risk.
4. **Guardrail B (extract props overflow)** — wires `extract` to
   the engine; refuses-by-default with structured suggestion.
5. **`refactor-state` command** — applies a plan; lands the
   biggest mechanical win.
6. **Cluster boundary heuristics** — iterate on cluster detection
   quality based on real-codebase results.

(1)–(3) alone already prevent the next 81-prop disaster, because
guardrail B's refuse-by-default would surface the cluster summary
even without `refactor-state` existing yet — the user just runs the
suggested commands manually.

## Related

- `VISION.md` — "stream of consciousness" goal includes *correct*
  consciousness, not just uninterrupted. Guardrails are how tedit
  keeps the agent's stream pointed at design quality.
- `DESIGN-PRINCIPLES.md` — pillar 3 (failure diagnostics) literally
  describes this shape; guardrails are diagnostics promoted to
  mutation-time defaults.
- `ISSUE-extract-component-with-slot-mode.md` — guardrail B's
  "refuse-by-default at high prop count" is the most concrete piece
  of integration; helper handling there + cluster detection here
  share the symbol-resolution machinery.
- `ISSUE-git-aware-default-write-mode.md` — same philosophy at a
  different layer: tool detects context and behaves accordingly,
  rather than asking the user to remember flags.
