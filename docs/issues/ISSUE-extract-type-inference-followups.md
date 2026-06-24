# Tighten extract prop type inference follow-ups

## Status

Implemented.

## Priority

P2.

## Problem

`extract` infers prop types from clear TypeScript annotations and can use the
checker with `--typecheck`, but unresolved props still fall back to `unknown`
with TODO markers. That is safe, but it leaves avoidable cleanup for common
literal and simple expression cases.

## Goal

Improve conservative AST-only inference before falling back to `unknown`.

## Proposed behavior

Infer obvious types without invoking the TypeScript checker:

- string/number/boolean literals
- template literals without expressions -> `string`
- arrays -> `unknown[]` or element literal union when trivial
- object literals -> `Record<string, unknown>` or inline object type when small
- `useState<T>` state variables when the generic is explicit

## Tests

- Extracted prop from `const label = "Save"` becomes `string`.
- Extracted prop from `const count = 1` becomes `number`.
- Extracted prop from `useState<string>(...)` becomes `string`.
- Ambiguous expressions still become `unknown` with TODO.

## Related

- `ISSUE-extract-component-with-slot-mode.md`
- `ISSUE-design-quality-guardrails.md`
