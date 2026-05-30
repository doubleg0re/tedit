# Agent Adoption Hardening Roadmap

Goal: make `tedit` attractive enough that agents choose it over routine Edit,
MultiEdit, Write, and Patch when safety, retryability, parser guardrails, or
structured output matter.

## Phase 1. MCP UX And Output Contracts

Status: completed in `tests/mcp-contract.test.mjs`.

Scope:

- Lock compact MCP/CLI output contracts for every default agent-profile tool.
- Keep success and failure shapes predictable:
  - `ok`
  - `kind`
  - `summary`
  - `path` or structured primary payload
  - `changedCount` and `writtenCount` for mutations
  - bounded `next` hints when a deterministic retry exists
- Make `actions` guidance contract testable, not only documented.

Acceptance:

- Golden tests cover the default MCP tool surface.
- Default compact results do not leak legacy `success` or `file` fields where
  agent-facing `ok` and `path` are the canonical fields.

## Phase 2. AST Select/Edit V1 Hardening

Status: completed in `tests/ast-tools.test.mjs`.

Scope:

- Harden `scan_strings`, `ast_select`, and `ast_edit` around common agent tasks:
  hardcoded text inventory, call-argument targeting, object label replacement,
  JSX text/attribute replacement, and simple template replacement.
- Improve selector failure hints so agents can recover without hand-building
  brittle text matches.

Acceptance:

- Tests cover AST discovery and edit paths for JSX, TS object values, call
  arguments, and templates.
- Non-unique and unsupported AST edits return bounded actionable hints.

## Phase 3. HTML/XML/Markdown Editing Hardening

Scope:

- Expand corpus coverage for markup and markdown structural edits:
  append/prepend/wrap/unwrap/remove/rename, attributes, classes, comments, and
  text replacement.
- Preserve atomic failure guarantees for invalid markup and markdown edits.

Acceptance:

- Representative HTML/XML/SVG/Markdown/MDX edits round-trip with verify.
- Invalid edits fail before writing and leave files unchanged.

## Phase 4. Built-In Agent Workflow Guidance

Scope:

- Make `actions` a practical workflow guide, not just a capability dump.
- Include clear tool-choice rows for discovery, small edit, multiedit, patch,
  file generation, AST string work, structural markup/JSX work, and history.
- Keep README and MCP guidance aligned.

Acceptance:

- Tests assert core guidance intents and examples are present.
- README describes the same default/advanced decision model.

## Phase 5. Dogfood Benchmark

Scope:

- Add a repeatable benchmark-style dogfood harness with fixed scenarios.
- Track success, retry-recovery behavior, output compactness, and parser guardrail
  coverage without depending on wall-clock timing.

Acceptance:

- One script runs all scenarios and emits compact JSON.
- `npm test`, `npm run pack:check`, and `npm run dogfood:agent` stay green.

## Verification Checklist

Before marking a phase complete:

- `npm test`
- `npm run pack:check` when packaging or docs/surface changes are involved
- `git diff --check`
- `npm run dogfood:agent` once benchmark scenarios change
- Clean working tree after each phase commit

## Current Next Step

Continue with Phase 3 HTML/XML/Markdown editing hardening.
