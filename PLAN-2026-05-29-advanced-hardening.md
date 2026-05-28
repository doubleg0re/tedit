# tedit Advanced Hardening Plan - 2026-05-29

## Objective

Continue moving tedit from a capable structural editor into a low-friction agent editing runtime.

## Candidate Ranking

### P1. Parser skip semantics

Status: Implemented in `76dac53`.

Plain text and unsupported extensions currently return `parse_verified: false`, which is accurate but ambiguous for agents. It can read like a parse failure even when verification was intentionally skipped because no parser exists.

Deliverable:

- Keep backward-compatible `parse_verified: false`.
- Add `parse_skipped: true` and `parse_skip_reason` for unsupported or disabled parser paths.
- Surface the fields consistently in CLI, MCP, multiedit, patch, workspace-flow, and compact output summaries.
- Add tests for plain text verify/edit/multiedit output.

### P2. Deterministic recovery hints

Status: Implemented for base-edit failures and selector ambiguity in the current slice.

Some failures have enough structured data to suggest one safe next command, but the hint is still generic.

Deliverable:

- Convert exact-match fuzzy-only diagnostics into direct retry hints.
- Include stable selector narrowing hints for ambiguity where possible.
- Keep `next` limited to deterministic one-to-three actions.

### P3. MCP discoverability polish

Status: Implemented in the current slice.

MCP tool names are usable but not fully optimized for agents that are deciding between native edit/read/write and tedit.

Deliverable:

- Document why no first-class read replacement exists yet, or add a read tool only if it is more useful than native read.
- Normalize action/tool discovery wording without breaking existing aliases.
- Add a focused MCP smoke for common agent edit loops.

### P4. Plan workflow expansion

Status: Implemented for `refactor-state-plan` in the current slice.

Plan/apply is intentionally extract-specific. The next generalization should wait for a second concrete risky refactor.

Deliverable:

- Use refactor-state or shared-helper movement as the second planned workflow only when the command behavior is mature enough.
- Keep schema extraction grounded in actual plan differences.

### P5. Cross-rule parity and parser depth

Status: Implemented for the remaining regex-semantics hardening item in the current slice.

The current rules cover JSX/TSX, JS/TS, JSON/JSONL, YAML, Markdown/MDX, and markup. CSS remains deliberately deferred.

Deliverable:

- Extend corpus tests when new real-world edge cases are found.
- Improve lightweight parser checks without adding dependencies unless explicitly requested.

## Current Implementation Unit

P1 through P5 are implemented. Further cross-rule parity work should be driven by new real-world edge cases rather than speculative parser expansion.
