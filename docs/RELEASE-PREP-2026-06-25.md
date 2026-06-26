# Release Prep - 2026-06-25

Scope: release-readiness evidence for `tedit@0.1.0`. No publish, tag, PR, or external registry action was performed.

## Positioning

`tedit` is structure-aware JSX/TSX editing for AI agents, backed by parser-checked safe edits for common project files. The JSX/TSX selector workflow is the wedge; edit/multiedit/patch, dry-run diffs, parser verification, atomic writes, and MCP setup are the base layer.

Primary users:

- Agent developers who need reliable JSX/TSX structural edits, with safe text/patch workflows for TS/JS, JSON, Markdown, and adjacent project files.
- MCP host users who want an installed `tedit-mcp` server rather than local one-off scripts.

## Package

- Name/version: `tedit@0.1.0` from `package.json`.
- Runtime: Node `>=20`.
- Release gate: `npm run release:smoke` / `npm run pack:check`.
- Bins: `tedit` and `tedit-mcp`.
- Published file surface: `dist`, `docs`, `README.md`, and package metadata.

## Evidence

- PASS `npm run typecheck` — TypeScript check completed.
- PASS `npm run lint` — typecheck-backed lint completed.
- PASS `npm test` — 227/227 tests passed.
- PASS `npm run release:smoke` — `tedit-0.1.0.tgz`, 25 package checks passed, `tedit 0.1.0`, 80 CLI actions, 15 MCP tools.
- PASS `git diff --check` — no whitespace errors.
- PASS CLI smoke — `node dist/cli.js --version`, `actions --json`, `verify-file README.md --json`, and unique dry-run edit succeeded.
- PASS `npm audit --audit-level=high` — 0 vulnerabilities after lockfile refresh (`hono` 4.12.23 -> 4.12.27).

## Go / No-Go

Go for local package release prep when the working tree is clean and the evidence above is current.

Still required after an actual npm publish:

```sh
npx -y tedit@0.1.0 --version
```
