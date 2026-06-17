# Single auto-routing edit entrypoint so agents never choose tedit-vs-Edit

## Status

Partially implemented — 2026-06-17. The dispatch decision is now captured in
`src/edit-route.ts` with regression coverage for trust-core formats vs
safe-string fallback. Full migration of CLI/MCP `edit` internals to consume the
route object remains future work. Arising from an outside-view review of the
`DESIGN-PRINCIPLES.md` ("trust over breadth") vs `ISSUE-five-pillar-roadmap.md`
("replace plain Edit/MultiEdit/Patch") tension, and a live observation: an agent
with the `tedit` MCP connected still defaulted to plain `Edit` for several
markdown edits in the same session, because the *routing decision* (is this a
tedit job?) is friction the agent avoids.

## Priority

P1. Not a correctness bug. It is the move that resolves the adoption-vs-trust
tension **and licenses freezing per-language rule breadth** — i.e. it is the
consolidation that lets the project stop accreting language rules.

## Problem

Two of the project's own documents pull in opposite directions:

- `DESIGN-PRINCIPLES.md`: stay in JSX, trust over breadth, "don't be a
  multi-language tool — each rule is its own trust contract."
- `ISSUE-five-pillar-roadmap.md` Pillar 1: "replace plain Edit/MultiEdit/Patch
  in normal coding work" — which implies covering everything an agent edits.

The friction these try to resolve is real: if `tedit` only reliably handles a
subset, the agent must decide *per edit* whether to use `tedit` or fall back to
`Edit`. That decision has a cost, so the agent skips it and defaults to `Edit`
(observed this session). But the fix that has been creeping in — **add an AST
rule per format (json/yaml/markdown/markup) so coverage is universal** — is the
wrong fix: "use it without thinking" only holds if *every* format hits the JSX
trust bar. One weak rule silently corrupting output reinstates the routing
doubt. Breadth cannot buy no-deliberation; only breadth-at-trust can, and that
is multiplicatively expensive.

## Proposal — move the routing into tedit, not the agent

A single `edit` front door that auto-detects file type and dispatches:

- **Structured formats (JSX/TSX, JSON, YAML)** → existing AST-precision path
  (selector + byte-clean mutation + parse-verify). These earn an AST rule
  because they are structured and corruption-prone.
- **Everything else (markdown, plain, unknown)** → safe-string path
  (exact/fuzzy/anchor/regex/line-range, already implemented) **plus**
  parse-verify-if-a-parser-exists, leaving the file unchanged on failure
  (already implemented in the verification layer).

The agent always calls one entrypoint and **never makes the routing decision** —
`tedit` makes it. The breadth lives in the *dispatcher*, not in N trust
contracts. Most of this already exists (Pillar 1 string ops + Pillar 4
verification); the work is unifying them behind one front door and one output
contract, not building new language rules.

## Why this matters

"One tool, no deliberation" requires exactly two guarantees, and the dispatcher
delivers both without a high-trust AST rule for every format:

1. **One entrypoint** covers any file the agent might edit.
2. **Never worse than `Edit`** — any edit plain `Edit` could make, `tedit`
   makes, with at least the same safety (and strictly more where structure
   exists). An agent can then adopt "always `tedit`" with zero downside.

## Suggested Acceptance Criteria

1. A single edit entrypoint (CLI + MCP) accepts any file path and produces a
   correct edit, routing internally by detected type.
2. Structured formats (JSX/TSX/JSON/YAML) route to the AST-precision path;
   other files route to the safe-string + verify-if-known path.
3. **Never-worse-than-Edit**: for any plain-string edit `Edit` could perform,
   the entrypoint performs it; on a known-parseable format it additionally
   parse-verifies and leaves the file unchanged on failure (`PARSE_BROKEN_*`).
4. Output is compact by default on this path (see
   `ISSUE-mcp-diff-output-verbosity.md`); routing decision is reported
   (which path was taken, which parser verified) without dominating context.
5. Regression coverage: routing per format, never-worse parity against a plain
   string edit, and fail-loud on each verifiable format.
6. **Breadth freeze, recorded as a decision**: no new per-language AST rule
   ships unless it clears the JSX-level trust bar (selector precision + byte
   cleanness + diagnostics). Non-structured formats are served by the
   safe-string fallback, not by new rules. This is the anti-accretion intent of
   the issue and should be stated in `DESIGN-PRINCIPLES.md`.

## Non-goals (reaffirm DESIGN-PRINCIPLES)

- Not a general-purpose AST manipulator — non-structured files get safe-string
  handling, never a synthesized AST rule.
- Not a formatter — the dispatcher never reformats what it did not mutate.
- Not a scripting language — routing is automatic, not agent-scripted.

## Anti-accretion note

This issue exists to **stop** rule accretion, not start it. It is the
consolidation that makes "stay narrow" and "one tool to replace Edit"
compatible: narrow *trust core* (AST for structured formats), universal *safe
fallback* (string + verify) for the rest, one front door over both. After this
lands, new language rules should be the rare exception, not the roadmap.

## Suggested first slice (de-risk spike)

Before the full migration: implement the dispatch skeleton + routing-decision
tests only (detect type → choose path → report path taken), with the
never-worse parity test against a plain string edit, on two formats (one
structured, one not). This proves the design and the trust contract before the
central `cli.ts` / `mcp-tools.ts` surfaces are migrated.

## Related

- `DESIGN-PRINCIPLES.md` — trust over breadth, non-goals
- `ISSUE-five-pillar-roadmap.md` — Pillar 1 (agent edit runtime), Pillar 4 (verification)
- `ISSUE-mcp-diff-output-verbosity.md` — compact-by-default output contract

## Landed

- `resolveEditRoute(filePath)` reports `ast` for trust-core structured
  extensions and `string` for everything else.
- Markdown can have a structural adapter while deliberately routing to the
  safe-string path.
- Regression tests cover trust-core routing, non-core routing, and
  verify-if-known behavior for string-routed formats.

Still later: wire this route object directly into the public `edit` command and
MCP `edit` handler instead of keeping it as a tested decision primitive.
