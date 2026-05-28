# Apply `analyze-state` refactor plans

## Status

Implemented. v1 applies a conservative in-component object-state refactor and can extract simple local clusters into generated custom hooks.

## Implemented v1

```bash
tedit refactor-state src/Page.tsx --cluster crewImport --write
```

This version merges a simple selected cluster into one in-component object
state and rewrites direct setter calls. With `--to` and `--name`, it can also
create a custom hook file and update the source atomically. It deliberately
fails on functional setters or complex declarations instead of guessing;
`--external-deps params` can explicitly thread external handler dependencies
into the generated hook.

## Priority

P2.

## Problem

`tedit analyze-state` can identify connected `useState` clusters and suggest
custom-hook boundaries, but it does not yet apply a refactor. Agents still
need to perform the actual hook extraction manually.

## Goal

Add a conservative `refactor-state` command that applies one selected
cluster plan into a custom hook when the cluster is simple enough.

## Proposed shape

```bash
tedit refactor-state src/Page.tsx --cluster crewImport --to src/useCrewImport.ts --name useCrewImport --write
```

## v1 Scope

- Only explicit `--cluster` names from `analyze-state` output.
- Only clusters whose states and handlers are local to one component.
- Generate a hook file and replace local state declarations/usages with the
  hook return object.
- Fail with diagnostics instead of guessing when dependencies are shared or
  ambiguous.

## Tests

- Simple two-state cluster moves to a hook.
- Ambiguous/shared handler dependencies fail without writing.
- Later parse failure prevents both source and hook writes.

## Related

- `ISSUE-design-quality-guardrails.md`
