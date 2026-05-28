# Agent ergonomics review follow-ups

## Status

Partially implemented from the 2026-05-28 dogfood/review session.

Implemented in v1:

- MCP now exposes `write_file`, `create_file`, `scaffold_file`, and `new_file`.
- Mutating MCP results include compact `summary`, enriched `files`, and `next`
  fields where applicable.
- MCP/CLI error results surface top-level `next` hints derived from existing
  diagnostics.

Remaining:

- Backup lifecycle cleanup under `.tedit/backups`.
- Explicit `profile: "agent"` / `TEDIT_PROFILE=agent` defaults once the result
  shape has more dogfood time.

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
- `.tedit.bak` sidecar backups are useful for safety but create workspace noise
  and can leak into packaging edge cases such as npm's `README*` auto-include
  behavior.
- Output is much better with `--summary`, `--quiet`, and `--diff-out`, but MCP
  callers still need a response shape optimized for agent decisions rather than
  human terminal output.
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

### 2. Agent-shaped MCP result mode

Keep existing structured JSON, but add a consistent top-level compact summary
for MCP responses. The agent should not have to infer the result from nested
fields.

Suggested common fields:

```json
{
  "success": true,
  "changed": true,
  "written": false,
  "summary": "1 file would change; parse verified with tsx",
  "files": [
    {
      "file": "src/Page.tsx",
      "changed": true,
      "written": false,
      "parser": "tsx",
      "diffAvailable": true
    }
  ],
  "next": ["rerun with write=true to apply"]
}
```

Acceptance criteria:

- `edit`, `multiedit`, `patch`, `write_file`, `extract`, and `apply_plan` expose
  compact `summary`, `files`, and `next` fields.
- Full diffs remain available, but callers can request compact responses without
  losing the decision-critical facts.
- CLI behavior remains backward-compatible.

### 3. Backup lifecycle cleanup

Sidecar `.tedit.bak` files are safe but noisy. Keep the safety property while
moving toward a more manageable lifecycle.

Preferred direction:

- Default non-git backups to `.tedit/backups/<timestamp>/<relative-file>.bak`
  instead of `<file>.tedit.bak` when possible.
- Write a manifest that maps original file path, backup path, reason, and time.
- Add `tedit backups list` and `tedit backups clean --older-than <duration>`.
- Keep `--backup`, `--no-backup`, and existing env behavior compatible.
- Continue excluding backup artifacts from package checks.

Acceptance criteria:

- Backup creation no longer litters edited directories by default.
- Users can list and clean tedit-created backups without touching unrelated
  files.
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

- Base edit failures include a `next` array with one to three concrete recovery
  suggestions.
- Selector ambiguity includes stable selector candidate hints, not only generated
  node ids.
- MCP callers receive the same recovery hints in structured content.

### 5. Agent default profile

Add an explicit profile for agent hosts so the default behavior is consistent
across CLI and MCP usage.

Possible shape:

```bash
TEDIT_PROFILE=agent
```

or per-call:

```json
{ "profile": "agent" }
```

Suggested defaults for `agent` profile:

- compact result shape by default,
- dry-run when outside git or ignored, matching current safety behavior,
- diffs omitted unless requested,
- parse verification always reported,
- backup policy included only when relevant,
- failure `next` hints included by default.

Acceptance criteria:

- `profile: "agent"` is accepted by MCP mutating tools.
- CLI can opt in via env or flag without changing current defaults.
- Tests cover profile defaults for success, dry-run, and failure paths.

## Recommended implementation order

1. Add MCP `write_file` and `create_file` first. This removes the biggest reason
   to keep using shell-based `write --from-stdin`.
2. Add compact MCP result fields for `edit`, `multiedit`, `patch`, and new write
   tools.
3. Add failure `next` hints to base edit and selector errors.
4. Move backup handling toward manifest-backed `.tedit/backups` storage.
5. Add `profile: "agent"` once the above pieces are stable enough to group.

## Non-goals

- Replacing the CLI. The CLI remains the durable universal surface.
- Adding a new parser or formatter dependency.
- Changing default write safety to be more aggressive.
- Hiding diffs entirely. Diffs should stay requestable; they just should not be
  mandatory context for every successful agent decision.

## Dogfood checks

Before closing this issue, repeat the same kind of session that produced it:

- Use MCP tools instead of shell for at least one new file, one exact edit, one
  multiedit, one patch, and one parse verification.
- Confirm no temporary JSON/spec files are needed for common edits.
- Confirm no backup artifact leaks into `npm run pack:check`.
- Run `npm test` and a direct MCP stdio client smoke test.
