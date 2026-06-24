# RFC: Multi-file flow support for extract

## Status

Implemented for v1. Standalone `tedit extract` remains available, and
multi-file execution is exposed through `workspace-flow` and
`chain-workspace`.

## Problem

Current `flow` runs against one opened `StructuredDocument`:

```ts
runFlow(doc, steps)
```

`extract` is different:

- reads one source file
- creates or overwrites one destination file
- patches the source file
- may move helpers and transferred imports across both files
- must write both files atomically or write neither

Bolting this onto the existing single-document flow model would make
multi-file writes an implicit side effect of a step that otherwise looks
like a normal in-memory mutation.

## Implemented Shape

The multi-file runner is separate from `runFlow(doc)`, so existing
single-file flow semantics do not gain hidden file side effects.

```json
{
  "flow": [
    {
      "action": "extract",
      "from": "src/page.tsx",
      "selector": "Card",
      "to": "src/components/PageCard.tsx",
      "name": "PageCard",
      "typecheck": true,
      "slots": [
        { "selector": "CardBody.children", "prop": "children" }
      ],
      "out": "pageCardExtract"
    },
    {
      "action": "chain",
      "file": "src/components/PageCard.tsx",
      "steps": [
        { "action": "prop.set", "target": "Card", "name": "data-extracted", "value": true }
      ]
    }
  ]
}
```

Implemented details:

1. `WorkspaceTransaction` tracks original and next source for each file.
2. `planExtract` accepts in-memory source and destination-existence
   overrides, so workspace steps can operate on files created earlier in
   the same transaction.
3. `runWorkspaceFlow(steps, options)` supports:
   - `extract` steps with explicit `from`/`to`
   - `chain` steps with explicit `file` and nested single-file steps
   - ordinary single-file steps when `file` is present
4. `tedit workspace-flow <flow-json>` writes all changed files only after
   every step succeeds.
5. `tedit chain-workspace` provides explicit file-boundary syntax:

```bash
tedit chain-workspace \
  extract src/page.tsx Card --to src/components/PageCard.tsx --name PageCard --typecheck \
  :: in src/components/PageCard.tsx prop.set Card data-extracted true \
  --write
```

## Trust Contract

- Dry-run remains default.
- JSON result must contain per-file diffs and planned writes.
- If any file parse/validation fails, no file is written.
- Existing single-file flow semantics must not gain hidden multi-file
  side effects.

## Remaining Follow-ups

- Variables use the same flat `out` namespace as single-file flow.
  A richer file-scoped namespace can be added later if real flows need it.
- `chain-workspace` supports inline chains plus `--from-file` and
  `--from-stdin`. A richer workspace-chain grammar can be added later if
  repeated real flows expose quoting or path ergonomics issues.
