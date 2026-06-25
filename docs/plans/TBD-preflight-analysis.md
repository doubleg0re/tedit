# TBD: Cross-language Preflight Analysis

## Why

Before a refactor writes files, agents need a cheap read-only check: what symbols exist, what the target depends on, and what will break or need imports/exports.

This is especially useful before splitting large modules, but should not be TS-only.

## Shape

Do not add a new tool first. Prefer enriching existing read/dry-run responses:

- `select` / language graph: show file inventory.
- `refactor move_symbols` dry-run: show move-specific risks.

Possible response field:

```json
{
  "preflight": {
    "inventory": {},
    "dependencies": {},
    "risks": [],
    "suggestedNext": []
  }
}
```

## Language coverage candidates

- JS/TS/JSX/TSX/MJS/CJS: top-level functions, variables, arrays, types/interfaces/classes, imports/exports, moved-symbol dependencies.
- Python: top-level functions/classes/globals, imports, referenced globals.
- Markdown: headings, code blocks, links/images, section reference risks.
- JSON/YAML: top-level keys, array/object registries, duplicate-key or extraction risks.
- HTML/XML: ids/classes/tags, selector match counts, anchor/id reference risks.

## First useful increment

For TS module splitting only, without inventing a tool:

1. Add `symbol_graph.summary`:
   - `functions`
   - `globals`
   - `arrays`
   - `types`
   - `classes`
2. Add `move_symbols.preflight`:
   - `moving`
   - `requiredGlobals`
   - `requiredImports`
   - `sourceBackImports`
   - `exportsAddedToSource`
   - `risks`

## Non-goals for now

- No LSP daemon.
- No semantic-diff engine.
- No auto-fix system.
- No separate `preflight` MCP tool until multiple languages prove the same response shape is useful.
