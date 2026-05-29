# tedit Stabilization Roadmap - 2026-05-30

## Objective

Freeze and harden tedit's agent-facing edit contract before adding more feature
surface. The goal is for agents to safely choose tedit over native
edit/multiedit/patch for common file edits because the output contract,
failure hints, and dogfood checks are predictable.

## Principles

- Prefer contract stability over feature breadth.
- Keep risky output-shape changes explicit, documented, and tested.
- Turn real dogfood failures into repeatable tests or scripts.
- Keep cosmetic polish separate from blocking workflow fixes.
- Add new editing capabilities only with a matching dogfood path.

## Phases

### Phase 1. Contract Inventory And Golden Outputs

Status: completed in `tests/golden-output.test.mjs`.

Scope:

- Document the stable meaning of `ok` vs `success`, `path` vs `file`,
  `changedCount`/`writtenCount`, and `next.tool`/`next.cliCommand`.
- Add golden-output tests for high-value CLI paths:
  - `verify-file` compact and detailed output.
  - `inspect-range` compact payload output.
  - `search-text` detailed output with follow-up commands.
  - mutation compact output for edit/multiedit dry-runs.
  - structured compact error output for common recovery paths.

Acceptance:

- Golden tests normalize only dynamic absolute paths.
- A field rename or accidental field removal fails tests.
- The tests cover both compact default output and `--json` detailed output.

### Phase 2. Agent Dogfood Harness

Status: completed in `scripts/dogfood-agent-workflows.mjs`.

Scope:

- Add `npm run dogfood:agent`.
- Use a temporary git repo and the built `dist/cli.js`.
- Exercise:
  - `search-text -> inspect-range -> multiedit dry-run -> multiedit write -> verify-file`.
  - `patch` with unified diff and apply-patch input.
  - `history-trace` after a local commit.
  - failure recovery for bad multiedit input, no match, and ambiguous edits.

Acceptance:

- One command produces a compact JSON summary of the dogfood run.
- It leaves repository files untouched.
- It fails loudly if any expected workflow stops being usable.

### Phase 3. Error Recovery Quality

Scope:

- Keep deterministic retry hints in compact errors.
- Improve hints for:
  - `MATCH_NONE`
  - `MATCH_NOT_UNIQUE`
  - `INVALID_MULTIEDIT`
  - `PATCH_HUNK_FAILED`
  - parse failures

Acceptance:

- Each covered failure has enough structured output for an agent to generate a
  safer next command.
- Hints stay bounded to one to three concrete next steps.

### Phase 4. MCP Surface Slimming

Scope:

- Keep the default agent profile focused on core workflows:
  `edit`, `multiedit`, `patch`, `file_write`, `search_text`,
  `inspect_range`, and `verify_file`.
- Keep JSX/AST/refactor/extract tools available in advanced/all profiles.
- Make tool descriptions say when to use the tool, not how impressive it is.

Acceptance:

- Default MCP discovery is small enough for an agent to choose quickly.
- Advanced tools are still discoverable when the profile asks for them.
- Existing aliases remain backward-compatible.

### Phase 5. Docs And Help Sync

Scope:

- Align README examples, CLI `help`, and MCP descriptions.
- Mark which examples are covered by tests or dogfood.
- Keep schema descriptions synchronized with actual output fields.

Acceptance:

- README does not name fields that are absent from the current output.
- CLI help examples remain copy-pasteable.
- MCP descriptions mention the same core workflows as README.

### Phase 6. Parser And Rule Hardening

Scope:

- Keep current supported file types stable:
  JS, JSX, TS, TSX, JSON, JSONL/NDJSON, YAML, Markdown/MDX, HTML, XML, SVG.
- Add edge-case tests from real misses rather than speculative parser work.
- Keep CSS/SCSS as a future feature until the stability gates are green.

Acceptance:

- Each supported rule has at least one valid edit, invalid edit, and verify-file
  path covered by tests or corpus fixtures.
- Parser labels are useful to agents and do not imply unsupported semantics.

## Release Gate

Before claiming a stabilization phase is done:

- `npm test`
- `npm run pack:check`
- `git diff --check`
- `npm run dogfood:agent` once Phase 2 exists
- Clean working tree after commit

## Current Next Step

Continue with Phase 3 error recovery quality. Convert remaining real dogfood
failure cases into compact structured error tests before changing agent-facing
messages.
