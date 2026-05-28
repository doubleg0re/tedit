# Agent ergonomics review follow-ups

## Status

Implemented from the 2026-05-28 dogfood/review session. The remaining items
are follow-up polish, not blockers for the current agent loop.

Implemented in v1:

- MCP now exposes `write_file`, `create_file`, `scaffold_file`, and `new_file`.
- MCP/non-TTY output defaults to compact machine-readable results, while TTY CLI
  output stays detailed unless explicitly overridden.
- Mutating results include compact `summary`, enriched `files`, and
  deterministic `next` fields where applicable.
- Detailed payloads remain available through `--output detailed`,
  `TEDIT_OUTPUT=detailed`, MCP `output: "detailed"`, `includeDiffs`, and
  `includeDetails`.
- MCP/CLI error results surface top-level `next` hints derived from existing
  diagnostics.
- Backups now use a manifest-backed `.tedit-cache/backups` lifecycle by
  default, with `tedit backups list`, `restore`, and dry-run-first `clean`.
- `npm run pack:check` now smoke-checks the packed CLI and MCP bins and blocks
  backup/postinstall artifacts.

Implemented after v1:

- Parser skips stay backward-compatible as `parse_verified: false` and add
  `parse_skipped: true` plus `parse_skip_reason` for unsupported or disabled
  parser paths.
- Exact-match, count-mismatch, and selector ambiguity failures surface
  deterministic `retry_hints` plus top-level `next` suggestions where safe.
- MCP discovery now documents the intended native Read plus `verify_file` /
  `find` / `inspect` path, adds tool metadata for agent choice, and smoke-tests
  an MCP failure-to-retry loop.
- Plan/apply now supports `refactor-state-plan` as the second concrete planned
  workflow alongside extract-component plans.

Remaining follow-ups from Claude MCP smoke:

- Decide whether regex replacements should support `$&`/`$1` backreferences
  or explicitly document literal replacement semantics.

## Priority

P1 for adoption. The core engines are now capable enough; the next bottleneck
is whether an agent naturally chooses `tedit` over native Edit/Write/Patch in a
normal coding loop.

## Review summary

The dogfood run proved that `tedit` can replace ordinary file edits when the
agent is willing to call it. The remaining friction is not the mutation engine;
it is the interface around that engine:

- CLI quoting is still expensive for long JSX, JSON, Markdown, Korean text, and
  nested quotes.
- Whole-file writes were implemented in the CLI but were not exposed as direct MCP
  tools; v1 now adds direct MCP generation tools.
- `.tedit.bak` sidecar backups were useful for safety but created workspace
  noise; v1 moves default backups into manifest-backed `.tedit-cache/backups`.
- Output is now compact by default for MCP and non-TTY callers, while detailed
  output remains available for terminal debugging and explicit agent probes.
- Failure diagnostics contain useful data, but the next action is not always
  obvious enough for a fast agent retry loop.

## Goal

Make `tedit` the low-friction default editing surface for agents by removing the
remaining reasons to fall back to native Edit/Write/Patch for routine work.

A successful version should let an agent do the common loop without shell
quoting, temporary JSON files, or full-output parsing:

1. discover actions if needed,
2. dry-run or verify,
3. apply with git-aware safety,
4. inspect a compact result,
5. retry from actionable diagnostics when a match fails.

## Proposed work

### 1. MCP parity for whole-file generation

Add MCP tools for the CLI commands that currently still require shell usage:

- `write_file`
- `create_file`
- `scaffold_file`
- `new_file`

Suggested tool shapes:

```ts
write_file({
  file: string,
  source: string,
  overwrite?: boolean,
  write?: boolean,
  dryRun?: boolean,
  backup?: boolean,
  noBackup?: boolean
})

scaffold_file({
  file: string,
  spec?: ScaffoldSpec,
  directives?: string[],
  imports?: string[],
  export?: string,
  body?: unknown,
  overwrite?: boolean,
  write?: boolean,
  dryRun?: boolean
})
```

Acceptance criteria:

- MCP can create and overwrite parse-verified JSON/Markdown/TSX files without a
  shell command.
- Tool behavior matches CLI write policy and parser verification.
- Regression coverage calls each new MCP tool through a stdio client.
- README's MCP tool list includes the new generation tools.

### 2. Compact machine-result mode

Keep existing structured JSON, but add a stable compact result contract for
machine callers. The default should follow the output channel rather than a
caller identity:

- MCP and non-TTY CLI stdout default to compact machine-readable results.
- TTY CLI stdout stays detailed and human-friendly.
- Explicit `--output compact|detailed`, `TEDIT_OUTPUT=compact|detailed`, or MCP
  `output: "compact" | "detailed"` overrides the auto default.

Suggested compact fields:

```json
{
  "success": true,
  "ok": true,
  "changed": true,
  "written": false,
  "summary": "1 file would change; parse verified with tsx",
  "files": [
    {
      "path": "src/Page.tsx",
      "change": "update",
      "changed": true,
      "written": false,
      "parser": "tsx",
      "hunks": 1,
      "bytesDelta": 42,
      "diffAvailable": true
    }
  ]
}
```

`next` is allowed, but it is not a filler field. Include it only for
deterministic, non-obvious, safe follow-ups such as an exact dry-run command to
apply, a safer fuzzy retry, or a backup restore command. Do not emit generic
"verify this" advice after every success.

Acceptance criteria:

- `edit`, `multiedit`, `patch`, `write_file`, `extract`, and `apply_plan` expose
  compact `success`/`ok`, `summary`, and `files` fields for MCP and non-TTY use.
- Full diffs and internal payloads remain available through detailed output or
  explicit include flags.
- TTY CLI behavior remains detailed unless compact output is explicitly selected.
- Tests cover compact success, dry-run, failure, and detailed/full-diff requests.

### 3. Backup lifecycle cleanup

Sidecar `.tedit.bak` files are safe but noisy. Keep the safety property while
moving toward a more manageable lifecycle.

Preferred v1 direction:

- Default non-git backups to
  `.tedit-cache/backups/<timestamp>/<relative-file>.bak` instead of
  `<file>.tedit.bak` when possible. This is repo-local, gitignored, and
  intentionally session-scoped. `.tedit/` stays reserved for the local package
  sandbox in this repo.
- Allow a future global backend such as
  `$XDG_STATE_HOME/tedit/<repo-fingerprint>/backups` without changing the
  manifest shape.
- Write a manifest that maps original file path, backup path, reason, time,
  original hash, replacement hash when available, command, and write policy.
- Add `tedit backups list`, `tedit backups restore <id>`, and
  `tedit backups clean --older-than <duration> --dry-run|--write`. Cleaning is
  dry-run by default.
- Keep `--backup`, `--no-backup`, and existing env behavior compatible.
- Continue excluding backup artifacts from package checks.

Acceptance criteria:

- Backup creation no longer litters edited directories by default.
- Users can list, restore, and clean tedit-created backups without touching
  unrelated files.
- Existing sidecar backup behavior can remain behind a compatibility setting.
- `npm run pack:check` fails if any backup artifact enters the package tarball.

### 4. Failure recovery hints

Turn rich diagnostics into direct retry guidance. The current errors often
contain enough information, but the agent still has to decide how to convert
that into the next command.

Examples:

- Exact match failed, fuzzy candidate exists: include a suggested `findFuzzy` or
  normalized exact string.
- Ambiguous selector: include the narrowest stable selector candidates when
  possible.
- `expectCount` mismatch: include observed count and candidate previews.
- Parse failure after edit: include parser name, line/column if available, and a
  recommendation to dry-run with `diff` inspection.

Acceptance criteria:

- Base edit failures include a `next` array only when there are one to three
  deterministic, non-obvious, safe recovery suggestions.
- Selector ambiguity includes stable selector candidate hints, not only generated
  node ids.
- Successful operations omit `next` unless the caller must take a specific
  follow-up action, such as applying a dry-run or restoring a backup.
- MCP callers receive the same recovery hints in structured content.

### 5. Output override and detailed mode

The primary split is machine output vs terminal output, not agent vs human. MCP,
pipes, scripts, and CI should default to compact output because the caller must
make a decision from structured facts. Interactive terminal usage should remain
detailed because a maintainer debugging `tedit` needs to see what happened.

Use `output` rather than `profile` as the public naming:

```bash
TEDIT_OUTPUT=detailed
tedit edit README.md --find old --replace new --output compact
```

or per MCP call:

```json
{ "output": "detailed", "includeDiffs": true, "includeDetails": true }
```

Compact behavior:

- include stable `success`/`ok`, `summary`, and enriched `files` fields,
- omit diffs and large payloads unless requested,
- report parse verification and write policy only when relevant to the
  decision,
- include `next` only for deterministic, non-obvious, safe follow-ups.

Detailed behavior:

- include full diffs, nested results, diagnostics, and internal payloads needed
  for debugging,
- preserve terminal-friendly verbose output for TTY CLI usage,
- allow explicit flags such as `includeDiffs`, `includeDetails`, or
  `output: "detailed"`.

Acceptance criteria:

- MCP mutating tools and non-TTY CLI output use compact results by default.
- TTY CLI output remains detailed by default.
- MCP callers can request full diagnostic output with `output: "detailed"` or
  explicit include flags.
- Tests cover compact success, dry-run, failure, deterministic `next`, TTY
  detailed defaults, and explicit full-diff requests.

## Recommended implementation order

1. Lock the compact result contract and output-selection rules first:
   MCP/non-TTY compact, TTY detailed, explicit `output` override.
2. Apply that policy across `edit`, `multiedit`, `patch`, write/create tools,
   `extract`, and `apply_plan`, with deterministic-only `next` hints.
3. Add publish-oriented smoke checks before broad distribution: `npx -y`, bin
   shebang/executable bit, package size, no `postinstall`, CLI startup, and MCP
   startup from the packed artifact.
4. Move backup handling toward manifest-backed `.tedit-cache/backups` storage
   with `list`, `restore`, and dry-run-by-default `clean`.
5. Defer plan/apply generalization and deeper extract/text follow-ups until a
   second concrete use case proves the abstraction boundary.

## Non-goals

- Replacing the CLI. The CLI remains the durable universal surface.
- Adding a new parser or formatter dependency.
- Changing default write safety to be more aggressive.
- Hiding diffs entirely. Diffs should stay requestable; they just should not be
  mandatory context for every successful agent decision.

## Dogfood checks

Latest Claude MCP smoke: PASS on 2026-05-28, saved at
`.omx/artifacts/claude-mcp-smoke-20260528-235537.md`. Claude used MCP tools
only for discovery, file creation, exact edit, multiedit, patch, and verification
probes under `/tmp/tedit-claude-mcp-smoke-20260528235537`.

Latest local MCP stdio smoke: PASS on 2026-05-28. A direct SDK client used
`actions`, `create_file`, `edit`, `multiedit`, `patch`, and `verify_file`, and
confirmed compact write results plus detailed dry-run override behavior.

Before closing this issue, repeat the same kind of session that produced it:

- Use MCP tools instead of shell for at least one new file, one exact edit, one
  multiedit, one patch, and one parse verification.
- Confirm MCP and non-TTY CLI output default to compact results, while TTY CLI
  output stays detailed unless `--output compact` is set.
- Confirm no temporary JSON/spec files are needed for common edits.
- Confirm backup artifacts do not leak into `npm run pack:check`, and that a
  created backup can be listed and restored.
- Run `npm test`, packed-artifact smoke tests, and a direct MCP stdio client
  smoke test.
