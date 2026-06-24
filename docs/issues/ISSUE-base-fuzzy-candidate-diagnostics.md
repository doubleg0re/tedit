# Improve base-rule fuzzy candidate diagnostics

## Status

Implemented.

## Priority

P2.

## Problem

`tedit edit` already surfaces fuzzy-only matches when exact matching fails,
but diagnostics can be more useful for recovery. Agents benefit from knowing
why the fuzzy match differs and from seeing a suggested next command.

## Goal

Enrich `MATCH_FUZZY_ONLY` and fuzzy multi-match diagnostics with compact
whitespace-drift information and a safer next-step hint.

## Proposed behavior

- Include normalized pattern preview.
- Include fuzzy match span and line/column, as today.
- Add whitespace drift metadata where cheap to compute.
- Include a command-shaped suggestion such as `--find-fuzzy` or `--find-lines`.

## Tests

- Exact mismatch with one fuzzy candidate includes whitespace drift details.
- Multiple fuzzy candidates keep `MATCH_NOT_UNIQUE` and include candidates.

## Related

- `ISSUE-base-rule-universal-edit.md`
