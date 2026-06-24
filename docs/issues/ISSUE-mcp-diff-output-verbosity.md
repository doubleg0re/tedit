# MCP edit response diff is too verbose for small changes

## Status

Resolved follow-up from the 2026-05-29 Claude TUI proxy dogfood. The review's main three issues are considered resolved; this issue tracked the additional follow-up around default output ergonomics, including config-driven TTY defaults.

Resolution notes:

- MCP mutating tools now default to compact `structuredContent` through the shared output formatter.
- MCP `content[0].text` is serialized from the same compact `structuredContent`, so clients that read text content do not see the raw core result.
- `multiedit` MCP regression coverage now asserts both `structuredContent` and `content[0].text` omit raw `success`, `results`, `diff`, `file`, per-file `changed`/`written`, and `write_policy` fields by default.
- Compact default output now reports `changedCount` and `writtenCount` as file counts, with per-file `change` and `persisted` fields.
- The local Claude registration was pointing at the ignored `.tedit/dist/mcp.js` install copy; that install copy has been refreshed from the current build.

## Priority

P2. This is not a mutation correctness bug: the file was edited correctly and parse verification passed. It is an agent ergonomics issue because the MCP response can spend a large amount of context on a diff that the caller did not need.

## Dogfood Context

A Codex agent used the `mcp__tedit__` tools while editing `/Users/ladin/Playground/claude-tui-proxy/README.md`.

The tested operation was intentionally tiny:

```text
Insert one temporary line under `## Readiness checks`, inspect the diff, then remove the line.
```

The `edit` call succeeded:

- `success: true`
- `changed: true`
- `written: true`
- `parse_verified: true`
- parser: `markdown-lite`

## Observed Behavior

`tedit`'s MCP response included a `diff` field that was effectively the full README-sized diff payload. For a one-line insertion, the response contained a very long unified diff including most of the file body.

By contrast, `git diff -- README.md` produced the expected compact hunk:

```diff
@@ -339,8 +339,10 @@ Recommended production hardening:

 ## Readiness checks

+- Temporary tedit diff probe.
 - `npm test` runs unit and API hardening tests.
 - `npm run build` type-checks and emits `dist/`.
```

After the probe, the temporary line was removed with `mcp__tedit__.edit`, and `mcp__tedit__.verify_file` passed.

## Expected Behavior

For MCP and agent-facing calls, the default response should be compact by default:

- include `summary`, numeric `changedCount`/`writtenCount`, `parse_verified`, parser, match count, and concise file metadata;
- include changed hunk summaries or at most a small bounded diff preview;
- avoid embedding full file-scale diffs unless explicitly requested;
- keep detailed diffs available through an explicit option such as `output: "detailed"`, `includeDiffs: true`, or a diff side file.

The current `summary` and `files` fields are useful. The issue is that the default `diff` payload can still dominate the response.

## Why This Matters

Agents pay context cost for tool output. A tool can perform a safe, parse-verified one-line edit and still make the surrounding workflow noisy if it returns a full-file-scale diff by default.

The safety signal needed by the agent was small:

```json
{
  "ok": true,
  "kind": "mutation",
  "changedCount": 1,
  "writtenCount": 1,
  "parse_verified": true,
  "parser": "markdown-lite",
  "files": [
    {
      "path": "README.md",
      "change": "modified",
      "persisted": true
    }
  ],
  "summary": "1 file written; parse verified with markdown-lite"
}
```

The long diff is useful for debugging `tedit` itself, but it should be opt-in for MCP/default agent paths.

## Suggested Acceptance Criteria

1. MCP `edit`, `multiedit`, and file creation tools default to compact output unless detailed output is explicitly requested.
2. Compact output does not include full diff text by default.
3. Compact output still reports whether a diff is available and enough metadata to decide the next action.
4. Detailed output remains available through explicit options and still includes the full diff.
5. TTY CLI default output can be controlled by config/env/flag without changing MCP compact defaults.

## Related Follow-up

The additional item identified after review is: TTY default output should also be controllable through configuration. Treat that as a follow-up polish item rather than one of the core review blockers.
