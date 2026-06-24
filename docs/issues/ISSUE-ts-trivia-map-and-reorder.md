# Trivia-complete positional tree + safe declaration move (DOM-style)

## Status

Implemented first slice — 2026-06-17. `parseTsTriviaMap` models comments,
blank lines, and directives as positioned nodes, and `ts-move` reorders named
declarations with dry-run trivia hints plus `take` / `drop` overrides. Supersedes
the earlier deferred stub of this file. Depends on
`ISSUE-ts-block-targeting.md` (the range model). This is the one
**greenfield structural** piece of tedit's TS work — the rest can be handed off;
this is the part worth designing from a blank page.

## Priority

P2 (after block targeting). Reorder ships only when the silent-misattachment
class below is made loud.

## Two layers

1. **Trivia-complete positional tree** — the structural foundation.
2. **Declaration move** — the first consumer that motivates and validates it.

---

## Layer 1 — Trivia-complete positional tree

Model **comments, blank lines, and directives as first-class positioned nodes**
(HTML DOM `<!-- -->`-node style), not babel's lossy `leadingComments` /
`trailingComments` metadata. If a comment is a node at position P, "does it
belong to A or B" stops being a question — it is simply at P.

**Invariant: `serialize(tree) === src`, byte-for-byte.** In-order traversal
reproduces the source exactly, including all trivia. This lossless round-trip is
the property that makes any structural move both byte-clean **and** trivia-safe:
move a subtree (with its owned trivia nodes) and everything else serializes
untouched.

The DOM analogy leaks in three places source has and HTML does not. The model
must encode each:

1. **Blank lines are semantic.** In HTML, inter-element whitespace is noise. In
   source, a blank line is the **ownership delimiter** — a comment directly above
   a declaration with no blank line is owned by it; the same comment separated by
   a blank line is a floating note, not owned. So blank lines must be first-class
   nodes too, not discarded.
2. **Line relationship matters.** A `} // inline` trailing comment travels with
   its declaration; a comment on the next line may not. Each trivium node carries
   its relationship: `own-line` / `same-line-trailing` / `gap-before(n)`.
3. **Comments occur intra-expression.** `const x = /* c */ 5`, `f(a, /* c */ b)`.
   The trivia-complete tree must descend all the way, not just statement level.

## Layer 2 — Declaration move

`move` reorders a declaration (targeted via `ISSUE-ts-block-targeting.md`) as a
source-range cut-paste. Trivia ownership is handled as **default + hint +
override**, never a silent guess:

- **Default (mechanical → algorithm):** a deterministic ownership rule decides
  the carried trivia bundle — contiguous comment block directly above with no
  blank gap = owned; `same-line-trailing` = owned; `gap-before(n>=1)` = not
  owned. Handles the common case without asking.
- **Hint (pre-hoc, fail-loud):** `move` is dry-run-first and returns, for the
  carried set **and** the adjacent-but-not-carried set, each trivium as
  `{ relationship, preview }` — **relationship (the gap state) first, content
  second**, because the gap is what tells the agent "yours vs not." Preview is
  compact (1 line + line count); full content on demand. This surfaces the
  ambiguity at decision time, converting silent misattachment into a visible
  decision — strictly better than a post-hoc conservation check.
- **Override (semantic → AI):** the agent confirms, or adjusts the carried set by
  trivium id (`take: [...]`, `drop: [...]`), before write.

Reuses the existing `dry-run -> confirm -> write` flow; no new UX surface.

## Suggested Acceptance Criteria

1. Parse yields a tree where comments, blank lines, and directives are positioned
   nodes; `serialize(parse(src)) === src` byte-for-byte across a corpus including
   intra-expression comments, same-line trailing comments, CRLF, and leading/
   trailing file whitespace.
2. Each trivium node carries its relationship (`own-line` / `same-line-trailing`
   / `gap-before(n)`).
3. The default ownership rule is deterministic and documented (blank gap = the
   boundary).
4. `move` is dry-run-first and returns a **compact** trivia hint: the carried set
   and the adjacent-not-carried set, each as `{ relationship, 1-line preview,
   line count }`, with full content available on demand.
5. The agent can override the carried set by id before write.
6. After a move, all code outside the moved range(s) and their carried trivia is
   byte-identical; no comment is dropped, duplicated, or re-owned without having
   appeared in the hint.
7. Output is compact by default (see `ISSUE-mcp-diff-output-verbosity.md`).

## Scope / non-goal

The tree is a general structural foundation, but this issue consumes it **only**
for declaration-level move and the block-targeting body-replace. It is not a
license for arbitrary node restructuring — consistent with the TS re-charter in
`ISSUE-ts-block-targeting.md`.

## Sequencing

`ISSUE-ts-block-targeting.md` (range model) → trivia-complete tree (this, the
greenfield prerequisite) → `move` (builds on both). Reorder does not ship until
criteria 1–6 hold; until then the agent falls back to targeting + manual
placement.

## Related

- `ISSUE-ts-block-targeting.md` — range model, the predecessor
- `ISSUE-single-edit-entrypoint-dispatch.md` — the entrypoint these route through
- `DESIGN-PRINCIPLES.md` — pillar 2 (byte-cleanness), the silent-failure rationale

## Landed

- `parseTsTriviaMap(source)` returns a source hash, line ending, and positioned
  `comment` / `blank-line` / `directive` trivia with `own-line`,
  `same-line-trailing`, or `gap-before(n)` relationships.
- `serializeTsTriviaMap(source, map)` preserves the byte-for-byte source
  invariant for the positional map.
- `tedit ts-move <file> <target> --before/--after <anchor>` performs a
  declaration source-range cut/paste and parse-verifies the result.
- Writes require `--confirm-trivia`; dry-runs return compact carried and
  adjacent-not-carried trivia hints.
- `--take` / `--drop` override carried trivia ids when the resulting leading
  move range remains contiguous.
- `--source-hash` rejects stale write attempts after a prior dry-run.
- CRLF parser offsets are normalized back to real source offsets before ranges
  are reported or patched.

Remaining depth for a later pass: a fuller nested positional tree for every
expression-level node. The current implementation consumes expression comments
as positioned trivia but only ships declaration-level move as a mutation.
