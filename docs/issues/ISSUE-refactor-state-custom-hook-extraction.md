# Extract `refactor-state` clusters into custom hooks

## Status

Implemented.

## Priority

P2.

## Context

`refactor-state` can now apply a selected `analyze-state` cluster either as
an in-component object state or as a generated custom hook when `--to` and
`--name` are provided. The custom-hook path remains conservative and refuses
external handler dependencies by default. When the caller explicitly passes
`--external-deps params`, those dependencies are threaded into the generated
hook as parameters.

## Goal

Add a second `refactor-state` mode that moves a selected cluster into a custom
hook file and replaces local declarations/usages with the hook return object.

## Proposed shape

```bash
tedit refactor-state src/Page.tsx --cluster crewImport --to src/useCrewImport.ts --name useCrewImport --write
```

## Required safety checks

- Identify all handler and helper dependencies the hook would need.
- Refuse shared or ambiguous dependencies unless explicitly mapped.
- Create/update both source and hook file in one transaction.
- Preserve parse verification and write policy behavior for both files.
- Keep functional setter rewrites conservative and explicit.

## Implemented behavior

```bash
tedit refactor-state src/Page.tsx --cluster crewImport --to src/useCrewImport.ts --name useCrewImport --write
```

The command creates the hook file, imports it from the source file, replaces
selected state reads with the hook return object, moves local handlers that
only depend on the selected cluster, and commits both files atomically.

## Tests

- Simple two-state cluster extracts to a hook file.
- External handler dependencies fail without writing.
- Source and hook writes commit through the same workspace transaction.
