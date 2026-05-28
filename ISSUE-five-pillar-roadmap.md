# Five-pillar roadmap for tedit as an agent editing runtime

## Goal

Turn `tedit` into a dependable agent-facing replacement for ad hoc Edit,
MultiEdit, and Patch calls, while preserving its stronger structural refactor
and verification guarantees.

The work is organized into five sequential pillars:

1. Agent Edit Runtime
2. Safe Refactor Engine
3. Selector / Targeting Language
4. Verification Layer
5. MCP / Distribution

Each pillar should have a clear CLI/API surface, regression coverage, docs, and
at least one dogfood check before it is considered complete.

## 1. Agent Edit Runtime

Purpose: make everyday agent edits comfortable enough that `tedit` can replace
plain Edit/MultiEdit/Patch in normal coding work.

Current coverage:

- `edit` supports exact, fuzzy, anchor, regex, line-range, stdin, file-backed
  inputs, delete, insert-before, insert-after, replace-all, and expect-count.
- `multiedit` applies cross-file edits atomically.
- `verify` runs multiedit specs as dry-run validation.
- `patch` accepts unified diffs and Codex apply-patch envelopes.
- `write` creates or overwrites files with parser verification.
- `--summary`, `--quiet`, `--diff-out`, and `--version` exist for the core
  agent path.

Completion criteria:

- Short `tedit help <command>` coverage for the core agent commands.
- Quiet/diff-out behavior documented for create/write where it already works.
- Regression tests for help coverage and write quiet/diff-out behavior.
- README examples that show the recommended agent loop:
  `verify -> write/apply -> diff-out`.

Status — 2026-05-28: complete for the current agent runtime scope.

Evidence:

- `tedit help <command>` now covers every command family exposed in the main
  help, including creation, selector, flow, and rule-discovery commands.
- Main help and README document quiet/diff side-file behavior for create/write
  style generation commands.
- Regression tests cover full help-topic availability and `write --quiet
  --diff-out` behavior.
- `npm test` passes with 119 tests.

## 2. Safe Refactor Engine

Purpose: move high-risk JSX/TSX refactors out of handwritten multi-file edits
and into planned, validated operations.

Current coverage:

- `extract` can create a component file, replace the call site, infer props,
  support slots, and enforce prop-overflow guardrails.
- Helper policy exists for move/share/as-prop/fail decisions.
- `refactor-state` can group state into object state or extract simple custom
  hooks, including explicit external dependency parameter threading.
- `analyze-state` emits cluster recommendations and over-cluster guidance.
- A proposal exists for plan files and `apply-plan`.

Completion criteria:

- Minimal `--plan-out` support for at least one risky refactor path.
- `apply-plan --dry-run` and `apply-plan --write` validate and apply the plan.
- High-risk steps are visible and selectively skippable.
- Shared helper movement remains plan-first, not silent direct mutation.

Status — 2026-05-28: complete for the current safe-refactor scope.

Evidence:

- `extract --plan-out <file>` writes an `extract-component-plan` without
  changing source or target files.
- `apply-plan` revalidates source/target hashes, re-runs the extract planner,
  supports `--dry-run`, `--write`, `--diff-out`, `--quiet`, `--only`, and
  `--skip`.
- Skipping a `move-helper-*` step replans that helper as an explicit prop,
  avoiding silent helper movement.
- Regression tests cover plan generation, dry-run/write application, stale
  source rejection, and helper-move skipping.
- `npm test` passes with 122 tests.

## 3. Selector / Targeting Language

Purpose: let agents describe target nodes with familiar, precise selectors.

Current coverage:

- Tag/component, CSS id/class shorthand, attribute matching, descendant, child,
  adjacent sibling, general sibling, `:scope`, scoped relative `:has(...)`,
  `:not(...)`, child position pseudos, and `:expr` are implemented.
- Attribute operators include `=`, `*=`, `^=`, `$=`, `~=`, and `|=`.
- Selector failures include stable diagnostics and candidate hints.

Completion criteria:

- README selector table matches the parser behavior.
- Tests cover selector parity for the supported CSS-like subset.
- Any unsupported pseudo/classes fail loudly with actionable diagnostics.

Status — 2026-05-28: complete for the current selector-language scope.

Evidence:

- Attribute selectors now accept quoted and unquoted values.
- Unsupported pseudo-classes and pseudo-elements fail with explicit diagnostics
  naming the unsupported selector and listing supported pseudos.
- README selector examples and limitations reflect the implemented parser.
- Regression tests cover unquoted attributes and unsupported pseudo diagnostics.
- `npm test` passes with 123 tests.

## 4. Verification Layer

Purpose: stop unsafe writes before they land.

Current coverage:

- TS/TSX, JSON, and lightweight Markdown parse verification are wired into
  create/write/edit/multiedit/patch paths where applicable.
- Git-aware write policy and backup behavior reduce accidental writes outside
  safe contexts.
- File length and prop overflow quality guardrails are available.

Completion criteria:

- Verification docs explain which file types are parse-verified.
- Optional stronger project checks have an issue or implementation path.
- Plan/apply validates hashes or anchors before writing.
- Regression tests cover failed verification leaving files unchanged.

## 5. MCP / Distribution

Purpose: make `tedit` easy for agent hosts to discover and call.

Current coverage:

- Package bins expose `tedit` and `tedit-mcp`.
- MCP server version comes from package metadata.
- Tests run an MCP client against the stdio server.
- `npm pack --dry-run --json` regression coverage verifies key dist files.

Completion criteria:

- CLI/MCP parity gaps are tracked.
- README includes direct MCP setup snippets.
- Pack checks cover CLI/MCP bins and required published files.
- Tool schemas expose the same safety defaults as the CLI.

## Sequencing

Work proceeds in order. When a pillar is complete, update this file with the
implemented evidence and tests, then move to the next pillar.
