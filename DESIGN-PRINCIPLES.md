# Design principles: trust over breadth

## Problem statement

LLM-driven code editors (Claude, Cursor, Copilot, etc.) operate JSX
files through string-matching `Edit`-style tools. That works on small,
clean files but breaks down in three predictable ways:

1. **Large files (1000+ lines).** `old_string` matching collapses
   because the agent can't hold enough context to write a string that
   is *unique* in the file. Result: wrong location edited, or "string
   not found" loop.
2. **Repeated patterns.** Same component (`<Button>`, `<Card>`,
   `<Image>`) appears N times with near-identical attributes. The
   agent has to disambiguate by surrounding lines, which is
   surface-level and fragile.
3. **Structural moves.** Wrapping an element, renaming a tag,
   re-balancing JSX trees. String editing can't see tags — it sees
   characters — so closing tags drift, indentation breaks, and the
   compiler errors out.

`tedit` exists to make these three failure modes structurally
impossible. The agent describes *what node to address* and *what
mutation to apply*; the AST guarantees correctness of the
"where" and the printer guarantees byte-clean output for the
"how". The agent stops being the weak link.

## North star: trust over breadth

Every design decision should be evaluated against:

> "Will this make an LLM agent trust `tedit` more than it trusts
> `Edit` for the same JSX change?"

If yes, ship it. If no, defer — no matter how clever or general.

Trust beats coverage. A small tool that *always* does the right thing
wins over a large tool that does the right thing 95% of the time, in
this domain. The agent has no easy way to detect the 5% failures, so
those failures silently corrupt downstream work.

## The three pillars of trust

### 1. Selector precision

The selector for an intended node must match exactly the intended
node, every time, regardless of file size or repetition.

- ❌ Returning two matches when the agent expected one is a *bug*,
  not a feature. The agent will then pick `[0]` arbitrarily and edit
  the wrong place.
- ✅ Tree combinators (`A B`, `A > B`, `:has`) are required, not
  nice-to-have. They are the difference between "selector might
  match" and "selector matches exactly this".
- ✅ Selector failure must be loud and informative — see pillar 3.

### 2. Mutation byte-cleanness

Outside the explicitly mutated span, the source file must be
byte-identical before and after.

- ❌ recast reprinting an unrelated `mainHeader={cond ? (<X/>) : null}`
  is exactly the failure that breaks trust. Even if semantically
  equivalent, it tells the agent "you edited something you didn't
  mean to edit" — which is the exact problem `tedit` is supposed
  to solve.
- ✅ Source-range patches (the `rename` fix path) are the model. All
  mutations should converge there.
- ✅ Formatting/whitespace untouched outside the patched span — no
  prettier dependency, no re-indentation surprises.

### 3. Failure diagnostics

When something doesn't match or apply, the error message must let the
agent recover without re-reading the file from scratch.

- ❌ `find` returning `{ "matches": [] }` with no further info is a
  trap. The agent assumes it's wrong about the file and starts
  guessing — or worse, assumes the operation succeeded and continues.
- ✅ "Selector matched 0 nodes. Closest candidates: `ScrollArea` at
  L1280 (attribute `viewportClassName` differs), `ScrollArea` at
  L1445 (attribute `verticalScrollbarStyle` differs)." Now the agent
  has actionable signal.
- ✅ Mutation failures should explain *why* — "wrap target has no
  parent JSX element" beats "WRAP_FAILED".

## Non-goals (intentional)

Things `tedit` should **not** become, even if there's pressure to add
them:

- **A scripting language.** No loops, no conditionals beyond `when`,
  no user-defined functions in flow.json. Complexity here erodes
  trust because the agent now has to reason about control flow on
  top of mutations.
- **A code formatter.** `tedit` should never re-format what it
  didn't mutate. That's prettier's job.
- **A general-purpose AST manipulator.** Stay in JSX (and the
  minimum non-JSX needed to make JSX edits complete — imports,
  expression containers). Don't drift into "edit any TS node".
- **A multi-language tool.** Other rules (HTML, MDX) are fine in
  principle but each one is its own trust contract. Don't ship a
  rule that breaks trust just to get coverage.

## Priority lens for existing issues

Rank by direct contribution to one of the three pillars:

| Issue | Pillar | Priority |
|---|---|---|
| `ISSUE-redundant-parens-on-conditional-consequent` | (2) byte-cleanness | **P0** — broken trust today |
| `ISSUE-surgical-patches-for-non-rename-mutations` | (2) byte-cleanness | **P0** — same root cause, full coverage |
| `ISSUE-selector-tree-combinators` | (1) selector precision | **P0** — without this, selectors lie |
| `ISSUE-text-content-mutation` | covers a missing operation that today forces fallback to string Edit (loss of trust) | **P1** |
| `ISSUE-scope-expansion-non-jsx-and-expression-containers` | same — completes the "no need to leave tedit" contract | **P1** |
| `ISSUE-chain-ergonomics` | usability, not trust | **P2** |

(Selector tree combinators and imports/expr were already addressed in
recent updates — they were P0/P1 for exactly this reason, even though
the issues themselves framed the value as "agent dispatch" or "mass
refactor". The real driver was trust.)

## Decision framework for new proposals

When evaluating a new feature, action, or syntax:

1. **Does it make selectors more precise, mutations more byte-clean,
   or failures more diagnosable?**
   - Yes → ship.
   - No → continue to (2).
2. **Does it remove a case where the agent currently has to fall back
   to string `Edit` (eroding trust)?**
   - Yes → ship.
   - No → continue to (3).
3. **Does it add expressive surface without affecting (1) or (2)?**
   - Probably defer. Expressive surface usually trades against trust:
     more knobs = more ways for the agent to misuse them.

## How to read the other issue files

The other ISSUE files describe specific gaps. They were written with
varied motivations (agent dispatch, mass refactor, ergonomics) because
those are the symptoms an agent or user experiences. **The underlying
driver in every case is the trust contract above.** When prioritizing
or scoping any of them, re-read through this lens — and prefer the
narrower implementation that strengthens trust, even if a broader one
would unlock more scenarios.
