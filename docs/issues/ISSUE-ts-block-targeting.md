# TS block-level targeting: address named declarations without authoring braces

## Status

Implemented first slice — 2026-06-17. `ts-select` resolves named declarations
and `ts-edit` can replace block bodies or insert source before/after a
declaration with source-range patches and parse verification. From the
single-entrypoint dispatch review and the
observation that the biggest large-file editing pain is plain-TS
(`claude-tui-proxy/src/server.ts`, ~3000 lines, dozens of `apiGate*`/`anthropic*`
functions), which is **not JSX** and therefore outside tedit's current
structural precision. Today such files route to the safe-string fallback
(parse-verify only) — safe, but with no precise targeting.

## Priority

P1. Directly addresses `DESIGN-PRINCIPLES.md` problem statement #1 ("large files
— old_string uniqueness collapses") for the most common large-file case: dense
plain-TS modules. The structural precision that solves it today only exists for
JSX.

## Governing principle (north star, refined)

> **Mechanical work belongs to the algorithm; semantic work belongs to the AI.**

Brace matching, balance, and position arithmetic are 100% mechanically decidable.
They must never be the agent's job. The agent's job is "**which** block" and
"**what** content" — never "where does the closing `}` go." This is not about
being cheaper than asking the model (it is not — building this costs more); it is
about moving the deterministic part to deterministic code so the AI stops being
the weak link on the part it is provably bad at.

## Problem

In a function-dense TS file:

- `old_string` for a string `Edit` is rarely unique among N near-identical
  functions → wrong edit or "string not found".
- Edits that add/remove nested code require the agent to author balanced braces
  in a deep context → misplaced `}` → broken syntax.

tedit's selectors are JSX-shaped (tag/attribute/`:has`) and do not address TS
declarations. So for these files tedit gives the safe-string fallback (won't
write broken TS, anchor/regex targeting) but **not** "address this function
exactly."

## Proposal — AST for the WHERE, string for the HOW

Add **declaration targeting** for TS, feeding the existing safe-string + verify
path (no recast mutation):

1. A selector resolves a named declaration to its **source range** via babel
   parse: `fn:apiGateMetadata`, `method:ClassName.foo`, `prop:configKey`,
   `class:Foo`. Resolution is exact, with fail-loud diagnostics + candidate hints
   on 0/N matches (pillar 1 + pillar 3), exactly like JSX selectors.
2. **Body-range replace**: the declaration's `{ ... }` body is a source range.
   The tool owns the outer braces (agent never authors them); only the span
   between them is replaced with agent-provided content. Inner balance is caught
   by parse-verify.
3. **Range splice, not reprint.** All edits are source-range patches — pillar 2's
   own convergence target. Code outside the targeted range is byte-identical. No
   recast subtree reprinting.

This is the trust-preserving form of "edit TS": the algorithm owns location and
brace balance; the AI owns intent and body content.

## Scope

In scope (this issue):

- Resolve named declaration → exact source range, fail-loud on ambiguity.
- Replace a declaration's body within its tool-owned braces.
- Insert before/after a named declaration.
- Applies to `.ts`/`.tsx`/`.js`/`.jsx` (TS targeting works inside JSX files too).

Out of scope (explicitly):

- Reordering/moving/restructuring declarations → `ISSUE-ts-trivia-map-and-reorder.md`
  (deferred; depends on a trivia-complete positional map).
- Arbitrary TS node editing (if-blocks, loops, type internals) → remains a
  non-goal.

## Suggested Acceptance Criteria

1. A declaration selector resolves a named function/method/property/class to an
   exact source range; 0 or >1 matches fail loudly with candidate hints (line +
   distinguishing detail), never an arbitrary `[0]`.
2. Body-range replace keeps the declaration's outer braces tool-managed; the
   agent supplies only body content.
3. Result is parse-verified (`typescript`); on `PARSE_BROKEN_AFTER_EDIT` the file
   is left unchanged.
4. Never-worse than string `Edit`: any edit `Edit` could make is still possible;
   this only adds precise targeting and the brace guarantee.
5. Code outside the targeted range is byte-identical (range splice, no reprint).
6. Compact output by default (see `ISSUE-mcp-diff-output-verbosity.md`); the
   response reports the resolved target and parser.
7. Routes through the single edit entrypoint
   (`ISSUE-single-edit-entrypoint-dispatch.md`): TS files keep the safe-string
   path and gain optional name-based range scoping on top of it.

## Non-goal re-charter (do this consciously, in writing)

`DESIGN-PRINCIPLES.md` currently says: "don't drift into edit any TS node."
This issue moves that boundary. Update the doc, with date + reason, to:

> **TS: named-declaration targeting + body-range replace only.** Not arbitrary
> node mutation, not restructuring. The algorithm owns location and brace
> balance; the AI owns intent.

The written boundary is the point: the actors who will extend tedit are
accretion-prone agents that cannot infer intent. A re-chartered boundary is the
only form "this far, no further" survives in when the human is not in the loop.
Drifting past an undocumented boundary removes the fence for exactly the actor
most likely to run past it.

## Related

- `ISSUE-single-edit-entrypoint-dispatch.md` — TS routes to the string path; this enriches it
- `ISSUE-ts-trivia-map-and-reorder.md` — the deferred reorder follow-up
- `DESIGN-PRINCIPLES.md` — problem statement #1, pillars 1/2/3, non-goals
- `ISSUE-five-pillar-roadmap.md` — Pillar 1 (agent edit runtime), Pillar 3 (selectors)

## Landed

- `tedit ts-select <file> [selector]` with selectors `fn:name`,
  `class:Name`, `method:Owner.name`, `prop:name`, `prop:Owner.name`, and
  `var:name`.
- `tedit ts-edit <file> <selector> --body ...` replaces only the inside of a
  block body; the outer braces remain tool-owned.
- `tedit ts-edit ... --insert-before/--insert-after ...` inserts source at
  declaration boundaries.
- MCP advanced tools: `ts_select`, `ts_edit`.
- Parse verification labels `.ts` as `typescript`; writes are blocked on parse
  failure.

Still intentionally out of scope: arbitrary TS node mutation and formatter-like
subtree reprinting.
