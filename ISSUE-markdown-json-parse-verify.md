# Add Markdown and JSON parse verification for universal edits

## Status

Implemented in v1.

Landed:

- `.json` universal edits parse final source with `JSON.parse`.
- `.md` / `.markdown` universal edits run the no-dependency `markdown-lite` fence verifier.
- Successful JSON/Markdown edits report `parse_verified` plus `parser`.
- Parse failures return `PARSE_BROKEN_AFTER_EDIT` and leave files untouched.

## Priority

P1.

## Problem

`tedit edit` can mutate every file, but parse verification currently only
runs for registered language rules such as JSX/TSX. For ordinary agent
work, Markdown and JSON are common edit targets:

- `README.md`
- issue/RFC documents
- package metadata
- config files
- generated flow specs

For these files, `tedit edit` is currently bytes-only. That is still
useful, but it means a malformed JSON edit or obviously broken Markdown
structure can be written without a format-specific check.

## Goal

Add lightweight verification for Markdown and JSON so universal edits are
safer on common non-JSX files.

This does not need to add full structural Markdown/JSON editing yet. The
first step is verification after base edits.

## Proposed behavior

### JSON

For `.json` files:

- After a planned edit, parse the final source with `JSON.parse`.
- If parsing fails, return a structured error and do not write.
- Preserve the original file untouched on failure.
- Include parser error location where available.

Possible error code:

```text
PARSE_BROKEN_AFTER_EDIT
```

JSON files should report:

```json
{
  "parse_verified": true,
  "parser": "json"
}
```

### Markdown

For `.md` and `.markdown` files:

Start with a lightweight no-dependency verifier:

- Ensure fenced code blocks are balanced.
- Ensure common frontmatter fences are balanced when present.
- Optionally detect obvious unbalanced HTML comments.

Do not attempt full CommonMark parsing in v1 unless a dependency is
explicitly accepted later.

Markdown files should report:

```json
{
  "parse_verified": true,
  "parser": "markdown-lite"
}
```

If the project later accepts a Markdown parser dependency, this can
upgrade to real CommonMark/MDX-aware verification.

## Non-goals

- Full Markdown AST editing.
- Heading/list structural actions.
- Markdown formatting normalization.
- JSON key-level structural editing.
- Adding dependencies before the lightweight verifier is evaluated.

## Implementation notes

Current verification is tied to registered language adapters. There are
two possible paths:

1. Add lightweight verification hooks to the base rule by extension.
2. Add minimal `json` and `markdown` rules whose first action is only
   parse verification, then later grow them into structural rules.

Option 2 may align better with the long-term rule architecture, but it
must not expose unsupported structural actions prematurely.

## Tests

Add coverage for:

- Valid JSON edit writes.
- Invalid JSON edit fails and leaves file unchanged.
- JSON `parse_verified` reports true on success.
- Valid Markdown edit writes.
- Markdown edit that breaks a fenced code block fails.
- Markdown `parse_verified` reports true on success.
- Unknown extension remains bytes-only with `parse_verified: false`.

## Related

- `ISSUE-base-rule-universal-edit.md`
- `RFC-agent-edit-primitives.md`
- `VISION.md`

