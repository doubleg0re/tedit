# TS Module Refactor Engine Roadmap

## Requirements Summary

Goal: make `tedit` capable of safely splitting large TS/JS modules such as `src/mcp-tools.ts` without hand-editing imports. The end-state is a refactor transaction layer: symbol graph -> plan -> move/extract -> import/export repair -> verify -> rollback.

Current anchors:

- `src/mcp-tools.ts:34` defines `TeditMcpTool`, and `src/mcp-tools.ts:1035` defines the default MCP profile registry.
- `src/mcp-tools.ts:1209` now has a thin `flow` MCP facade draft that reuses existing chain/workspace-flow engines.
- `src/ts-tools.ts:64` already exposes declaration matches, and `src/ts-tools.ts:101` / `src/ts-tools.ts:109` already implement TS edit/move option shapes.
- `src/refactor-plan.ts:11` currently limits plan kinds to extract-component/refactor-state; module-split plans should extend this existing plan/apply pattern, not create a second planner.

## Principles

1. Reuse existing parsers and workspace transaction code before adding new machinery.
2. Plan first for multi-file refactors; direct write only for small, explicit moves.
3. TypeScript correctness beats pretty architecture: every write path must typecheck or rollback when requested.
4. MCP surface stays small: expose via `refactor` and `flow`, not many one-off tools.
5. Each phase leaves one runnable regression test.

## Roadmap

### P0 — MCP `flow` facade

Purpose: give agents one default-profile workflow tool that accepts either JSON `steps` or CLI-style `chain`.

Implementation:

- Add default MCP tool `flow` next to `edit`/`multiedit`/`patch` in `src/mcp-tools.ts`.
- Input accepts either:
  - `{ steps: WorkspaceFlowStep[] }` / `{ flow: WorkspaceFlowStep[] }`
  - `{ file, chain: "find button as b :: wrap @b div" }`
  - `{ chain: "extract ... :: in ..." }` for workspace-chain syntax.
- Reuse `fileChainToWorkspaceFlow`, `workspaceChainToFlow`, and `runWorkspaceFlow`.

Acceptance:

- `toolsForMcpProfile("agent")` includes `flow`.
- `runMcpTool("flow", { file, chain, dryRun: true })` returns compact mutation contract.
- README default MCP list and docs-sync test agree.
- `npm test` passes.

### P1 — TS symbol graph read model

Purpose: make tedit understand top-level module structure before moving anything.

Implementation:

- Add `src/ts-symbol-graph.ts`.
- Support top-level `function`, `const`/`let`/`var`, `type`, `interface`, `class`, `enum`.
- Return:
  - declaration range
  - exported flag
  - local references used by the symbol
  - local symbols that reference it
  - external import specifiers used by it
  - type-only import candidates
- Extend `ts_select` or `refactor kind=symbol_graph` with read-only output.

Acceptance:

- For `src/mcp-tools.ts`, graph includes `runEditTool`, `runPatchTool`, `TEDIT_MCP_ALL_TOOLS`, `TeditMcpTool`.
- Graph reports `runEditTool` used by `TEDIT_MCP_ALL_TOOLS`.
- Graph reports imports used by moved symbols without rewriting files.
- New unit test covers mixed value/type imports.

### P2 — `move_symbols` dry-run

Purpose: move explicit top-level symbols to another module and produce a diff without writing.

Implementation:

- Add `refactor { kind: "move_symbols" }`.
- Inputs: `from`, `to`, `symbols`, `closure`, `write/dryRun`.
- v1 closure modes:
  - `none`: selected symbols only.
  - `helpers`: include private helpers only when not used by source after move.
  - `ask`: dry-run result lists candidates; no automatic extra move.
- Generate target file, imports, exports, and source import back to moved symbols.
- Use existing `unifiedDiff`, `write-policy`, and parse verification.

Acceptance:

- Moving one standalone function to a new file dry-runs cleanly.
- Missing helper dependencies appear as `alsoMoveCandidates` or imported shared refs.
- Source and target parse verify.
- No write occurs in dry-run.

### P3 — `move_symbols` write + verify rollback

Purpose: make the move safe enough for real repo refactors.

Implementation:

- Add write path with `captureRestorePoints` and existing post-verify command support.
- Support `verify: { cmd, timeoutMs, rollbackOnFail }`.
- Parse `tsc` diagnostics into response using existing verify-command diagnostics.

Acceptance:

- Passing `npm run typecheck` leaves files written.
- Failing verify with rollback restores source/target exactly.
- Response includes changed files, imports added, exports added, verify result.

### P4 — `extract_array_entries`

Purpose: split registries like `TEDIT_MCP_ALL_TOOLS` by category/name without manual object cutting.

Implementation:

- Add `refactor { kind: "extract_array_entries" }`.
- Inputs: `file`, `array`, `where`, `entries`, `to`, `exportName`.
- Supports object-array entries filtered by literal fields: `name`, `category`, `exposure`.
- Replaces source entries with spread import, e.g. `...EDIT_TOOLS`.

Acceptance:

- Extract `category: "edit"` entries from a fixture registry.
- Target module imports handlers/schema helpers it needs.
- Source imports target array and preserves order via spread.
- Typecheck passes.

### P5 — `module_split_plan` / `apply_plan`

Purpose: plan a large split before touching source.

Implementation:

- Extend `RefactorPlanKind` in `src/refactor-plan.ts:11` with `module-split-plan`.
- Plan file contains symbol moves, array extractions, shared helper candidates, source hashes, target hashes.
- `apply_plan` handles module split plans using existing plan selection (`only`/`skip`) where practical.

Acceptance:

- `module_split_plan` can propose edit/discover/refactor groups for a fixture shaped like `mcp-tools.ts`.
- Applying the plan writes multiple files atomically.
- Stale source hash blocks apply.
- `npm run typecheck` verifies output.

### P6 — Real `mcp-tools.ts` split

Purpose: use the engine on the real 135KB file.

Target shape:

- `src/mcp/tool-types.ts` — `TeditMcpTool`, profile types, shared schema bits if needed.
- `src/mcp/tool-registry.ts` — profile filtering, `runMcpTool`, registry concatenation.
- `src/mcp/tools/edit.ts` — edit/multiedit/patch/delete/rename/flow definitions and handlers.
- `src/mcp/tools/discovery.ts` — actions/select/search/inspect/history/verify.
- `src/mcp/tools/refactor.ts` — refactor facade and plan/apply/extract tools.
- `src/mcp/tools/advanced.ts` or finer files for JSX/AST/TS advanced tools.
- `src/mcp/tool-helpers.ts` — shared input/output helper functions only after duplication pressure proves it.

Acceptance:

- Default tool names unchanged except intentionally added `flow`.
- All profile docs sync tests pass.
- `npm test` and `npm run release:smoke` pass.
- `src/mcp-tools.ts` becomes a compatibility export/shim or small registry file under ~20KB.

## Risks and Mitigations

- Risk: import repair gets clever and breaks edge cases. Mitigation: v1 supports top-level symbols only and always runs typecheck.
- Risk: circular dependencies after moves. Mitigation: plan reports cycles and refuses write unless user explicitly keeps shared helpers in source.
- Risk: formatting churn. Mitigation: source ranges for declarations; only generated import blocks may be normalized.
- Risk: plan/apply grows too broad. Mitigation: keep `module-split-plan` under existing `refactor-plan.ts` plan/apply model.

## Verification Steps

Per phase:

```sh
npm run typecheck
npm test
npm run release:smoke
```

For move/write phases also run a failing verify rollback test using a command that exits non-zero.

## Stop Conditions

- Stop P0 when `flow` is default-profile, documented, tested, and committed.
- Stop P1-P5 before touching real `src/mcp-tools.ts` if symbol graph cannot identify imports and local references reliably.
- Only start P6 after the plan/apply engine passes fixture tests.
