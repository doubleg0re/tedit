# Plan files and apply-plan for risky refactors

Status: Implemented initial extract plan/apply support on 2026-05-28.

Implemented:

- `extract --plan-out <plan-json>` writes an `extract-component-plan` without mutating source files.
- `apply-plan <plan-json> --dry-run|--write` revalidates source/target hashes and reruns the extract planner before applying.
- `--only`, `--skip`, `--quiet`, and `--diff-out` are supported on `apply-plan`.
- Skipping `move-helper-*` replans that helper as an explicit prop fallback.
- Regression coverage verifies plan generation, stale source rejection, write application, and helper move skipping.

Remaining follow-ups:

- Generalize plan/apply beyond extract component plans.
- Add true shared-module helper movement as its own high-risk planned step.
- Add richer `plan inspect` summary output.

## Summary

Some `tedit` refactors are mechanically possible but architecturally risky.
Moving shared helpers into a new module, changing import ownership, splitting a
large state cluster, or applying context-level state extraction can cross file
and module boundaries in ways that are hard to review from a single command
result.

`tedit` should support a plan-first workflow for these operations:

1. Generate a structured plan file without changing source files.
2. Let an agent or human inspect and optionally edit that plan.
3. Apply the accepted plan through the same parser, anchor, and atomic write
   safety checks used by normal `tedit` commands.

This keeps simple edits fast while giving risky refactors an explicit decision
point.

## Proposed command shape

```bash
tedit extract src/Page.tsx find Body \
  --component Body \
  --plan-out .tedit/plans/extract-body.json

# Optional inspection step.
tedit plan inspect .tedit/plans/extract-body.json

# Preview all accepted steps.
tedit apply-plan .tedit/plans/extract-body.json --dry-run

# Apply after review.
tedit apply-plan .tedit/plans/extract-body.json --write
```

Selective application should be supported for high-risk steps:

```bash
tedit apply-plan .tedit/plans/extract-body.json --only move-shared-helper --dry-run
tedit apply-plan .tedit/plans/extract-body.json --skip move-shared-helper --write
```

## Plan file shape

The plan should be stable JSON, editable by humans and agents:

```json
{
  "kind": "extract-component-plan",
  "version": 1,
  "created_by": "tedit",
  "source": "src/Page.tsx",
  "source_hash": "sha256:...",
  "target": "src/Body.tsx",
  "steps": [
    {
      "id": "create-component-file",
      "kind": "write-file",
      "risk": "low",
      "file": "src/Body.tsx"
    },
    {
      "id": "replace-callsite",
      "kind": "edit-file",
      "risk": "medium",
      "file": "src/Page.tsx"
    },
    {
      "id": "move-shared-helper-formatCrewName",
      "kind": "move-symbol",
      "risk": "high",
      "symbol": "formatCrewName",
      "from": "src/Page.tsx",
      "to": "src/Body.helpers.ts",
      "reason": "helper is used by the extracted component and remains shared"
    }
  ]
}
```

Each step should carry enough information for `apply-plan` to re-resolve and
validate the action instead of blindly trusting stale byte offsets.

## Required safety behavior

`apply-plan` must validate a plan before writing:

- Schema is known and versioned.
- Referenced files still match expected hashes or anchors.
- Selectors still resolve to the same intended nodes.
- Target files do not collide unless overwrite is explicit.
- Import/export changes do not create obvious name conflicts.
- Each write remains atomic across all touched files.
- Changed files parse after application.
- `--dry-run` prints diffs and performs every validation except the write.

If the user or agent edits the plan file, `apply-plan` should treat it as an
input program that must be validated, not as trusted output from a prior run.

## Risk policy

Suggested default behavior:

- Low-risk local changes can still run directly.
- Medium-risk changes may run directly when explicitly requested, but can also
  be emitted as plan steps.
- High-risk changes default to plan-only unless the user passes a deliberate
  accept flag or applies an approved plan.

Examples of high-risk steps:

- Moving a shared helper into a new module.
- Changing public exports.
- Rewriting import ownership across multiple files.
- Context-level state extraction.
- Splitting a large state cluster into several hooks or providers.

## Why this belongs in tedit

Agents can edit JSON plans much more reliably than they can coordinate a risky
multi-file refactor from scratch. A plan file also gives the user a concrete
review surface: what files will change, which symbols will move, which steps are
risky, and what can be skipped.

This extends `tedit` from a safe mutation CLI into a safe refactor workflow
without making the default edit path slower.

## Non-goals

- No interactive prompt requirement in the core CLI.
- No dependency on an external planner service.
- No automatic acceptance of high-risk steps just because a plan exists.
- No unchecked byte-offset replay.

## Tests

Add coverage for:

- `extract --plan-out` writes a plan and leaves source files unchanged.
- `apply-plan --dry-run` validates and prints diffs without writing.
- `apply-plan --write` applies all accepted steps atomically.
- Edited plans are revalidated before writing.
- Hash or anchor mismatch fails without writes.
- `--only` and `--skip` apply the expected subset.
- High-risk steps are visible in summary output.
- Plan application rejects schema/version mismatch.

## Related follow-ups

- Shared helper module movement from extract.
- Context-level `refactor-state` application.
- More advanced state-cluster splitting decisions.
- Agent-facing summary output for planned vs applied steps.
