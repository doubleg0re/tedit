# Add `--summary` (or terse) output mode for `multiedit` / `edit`

## Status

Implemented. Filed from a real dogfood run (PreFlowAI 2026-05-28, "Button DS
normalization" task: 13 edits across 5 files in 2 `multiedit` batches).

## Priority

P2. Quality-of-life for agent loops. Not a correctness issue, but the
current default output makes the safety-net (`--dry-run`) painful to
actually read.

## Resolution

`tedit edit ... --summary` and `tedit multiedit ... --summary[=files|edits]`
now emit terse human-readable output. Summary mode omits diffs, file contents,
git status, and parse-detail payloads. Failure summaries include the failing
edit index, a truncated find preview, and a compact reason. `--quiet`,
`--diff-out <file>`, `tedit verify <spec>`, `tedit --version`, and short
`tedit help <subcommand>` are now implemented as the CLI UX follow-up pack.

## Problem

`tedit multiedit ... --dry-run` (and `--write`) currently emit a
JSON blob that includes, per file:

- the per-edit result (match strategy, count, ok/fail)
- the **full diff** of the file
- the **full final file content** (or at least a large preview)
- workspace/git status
- parse-verify diagnostics

For a 6-edit batch across one ~3k LOC file (the budget page case), the
dry-run output ballooned to **245 KB**, which is well past what an
agent can reasonably stream into its own context. The harness ended up
persisting the output to disk and showing only a 2 KB head.

The information needed to decide "apply or not" is tiny:

```
budget-buttons-to-ds.json
  apps/.../budget/page.tsx              ok    6/6 edits
  → all good, ready to --write
```

Today the agent's only recourse is:

```bash
tedit multiedit spec.json --dry-run 2>&1 | grep -E '"success"|"error"|"matchCount"'
```

…which works but is a hack: it relies on the JSON field names being
greppable on single lines and silently drops anything pretty-printed
across multiple lines.

## Goal

Add a first-class terse output mode so agents can verify a batch
applied cleanly without paging through full diffs.

Two natural names:

- `--summary` — switches output to a one-line-per-file (or one-line-per-edit)
  status format.
- `--quiet` / `-q` — emits nothing on full success, machine-parseable
  failures otherwise. (Closer to typical CLI convention.)

Both could coexist; `--summary` is the friendlier default for the
"agent dry-runs to decide whether to write" workflow.

## Proposed shape

### `--summary` (human/agent readable)

```
$ tedit multiedit spec.json --dry-run --summary
spec: button-ds-normalize.json (7 edits, 4 files)
  apps/web/src/components/ui/button.tsx                                  ok  2/2
  apps/web/src/app/(app)/projects/[id]/casting/page.tsx                  ok  1/1
  apps/web/src/app/(app)/projects/[id]/characters/page.tsx               ok  3/3
  apps/web/src/app/(app)/projects/[id]/screenplay-analysis/...           ok  1/1
result: success — 7/7 edits matched, no files written (dry-run)
```

On failure:

```
$ tedit multiedit spec.json --dry-run --summary
spec: budget-buttons-to-ds.json (6 edits, 1 file)
  apps/.../budget/page.tsx                                               FAIL 4/6
    edit[3] find: "<button\n  type=\"button\"\n  className={confirmed..." — no match
    edit[5] find: "<DropdownMenuTrigger\n  aria-label=\"더 보기\"..."      — fuzzy 3 candidates
result: failure — refusing to apply (any --dry-run failure blocks --write)
```

Key properties:

- One line per file (default) or per edit (`--summary=edits`).
- Path columns aligned, status column right of path.
- For failures, the failing edit's `find` is truncated to ~60 chars and
  the failure reason (`no match`, `fuzzy N candidates`, `count
  mismatch (expected N, got M)`) is shown inline.
- **No file content. No diff. No git status.** All of that stays
  available via the default JSON output for when the agent *does* want
  to inspect.

### `--quiet` / `-q` (CLI-convention)

- Exit 0 + empty stdout on full success.
- Exit non-zero + single JSON object on failure, with just enough info
  to point at which edit broke.

Useful for non-interactive pipelines / pre-commit hooks where the
default `--summary` text is still too noisy.

## Rationale: why this matters for agent dogfood

The current "JSON-dump everything" output is great for **debugging
tedit itself** — full diff + parse-verify + git status is exactly what
you want when you're investigating a regression.

It is bad for the workflow tedit was built for: agents looping

  1. write spec JSON
  2. `--dry-run` to verify matches
  3. read the result
  4. `--write` if all green

Step 3 is the bottleneck. Agents reading tool output pay context
window cost per byte, and a 245 KB dry-run blob from a single command
is enough to evict prior conversation state. The natural workaround
(`grep '"success"'`) leaks tedit's internal field names into agent
prompts and breaks the moment output gets re-formatted.

Making the terse path a flag (`--summary`) keeps the default
backwards-compatible while giving the dogfood loop a first-class
"verify and proceed" output.

## Follow-ups resolved in the CLI UX pack

- `tedit verify <spec>` is now an explicit dry-run-with-summary wrapper for
  multiedit specs.
- `--diff-out <file>` writes detailed diffs to a side file while stdout can
  stay terse or quiet.
- `--quiet` emits no stdout on success for edit/multiedit/patch/verify;
  quiet verify failures return terse JSON on stderr.

## Related dogfood notes (not blocking)

Two minor papercuts from the same run were resolved:

- `tedit --version` prints the package version and exits 0.
- `tedit help <subcommand>` provides short command-specific help for the
  agent-facing surfaces instead of always dumping the full reference.
