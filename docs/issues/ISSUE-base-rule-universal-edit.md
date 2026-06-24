# Base rule: universal `find` / `replace` with the tedit trust contract

## Summary

A **system-level rule** that handles any file — known extension or
not — and provides the foundation every other rule composes on top
of. Concretely: `find`, `replace`, `insert-before`, `insert-after`,
`delete`, with multi-strategy match (exact / fuzzy / anchor / line
range), rich failure diagnostics, automatic backup/rollback, and
dry-run.

Goal: **agents stop having to decide "is this a tedit case or an
Edit case?" — the answer becomes "always tedit"**. JSX/TSX gets
language-rule actions on top; plain `.ts`, `.md`, `.json`, `.css`,
`.txt` get the base rule and a much smarter string editor than what
they have today.

## Status — 2026-05-27

Implemented:

- Standalone `tedit edit <file>` for every file extension.
- Match strategies: `--find` / `--find-exact`, `--find-fuzzy`,
  `--find-anchor-after ... --find/--contains`, `--find-regex`, and
  `--find-lines`.
- Mutations: `--replace`, `--insert-before`, `--insert-after`, and
  `--delete`.
- Strict unique-match default, `--replace-all`, and `--expect-count`.
- Structured diagnostics for `MATCH_NONE`, `MATCH_NOT_UNIQUE`,
  `MATCH_FUZZY_ONLY`, `MATCH_COUNT_MISMATCH`, `INVALID_REGEX`,
  line-range errors, and `PARSE_BROKEN_AFTER_EDIT`.
- Parse verification for registered language rules before write, plus
  lightweight `.json` and `.md` / `.markdown` verification.
  Unknown files skip parse and still edit safely.
- `tedit actions [file] --json` discovery.
- Workspace integration through `workspace-flow` and
  `chain-workspace in <file> edit ...`.
- Single-file `chain <file> edit ... :: jsx-action ...` integration
  via the workspace transaction path.
- Language-rule fallback diagnostics: JSX selector failures include
  base literal candidates and a `tedit edit --find ...` next-step hint.

Still follow-up:

- Richer fuzzy base-candidate suggestions inside language-rule errors.

## Resolution — 2026-05-28

The universal base edit surface is implemented and dogfooded through
standalone `edit`, `multiedit`, `patch`, `workspace-flow`, and mixed
single-file `chain` paths. JSON/Markdown parse verification and richer
fuzzy diagnostics are in place; remaining work is incremental UX polish,
not core capability.

This is the single largest adoption multiplier left for the project.
Without it, `tedit` is a specialized JSX tool that lives next to
`Edit`. With it, `tedit` *is* the editor.

## Why now (horizon 2, not 4)

Per VISION.md, this was originally placed at horizon 3 (after JSX
polish and imports/expr). It's been promoted because:

1. **JSX polish past the current point is marginal return.** The big
   wins (selectors, surgical patches, imports, expr, scaffold) have
   landed. `text.set` and a few extracts remain, but each adds at
   most single-digit % to JSX trust.
2. **Base rule covers everything else in one move.** Any file the
   project doesn't have a language rule for — and that's almost all
   files, today — gets a meaningful upgrade the moment the base rule
   ships.
3. **Adoption is gated on decision-tree simplicity.** As long as the
   agent must choose "tedit or Edit?" per call, the easy path wins
   and `tedit` is skipped for the wrong reasons. A universal base
   rule collapses the question.

JSX-specific polish (`text.set`, extract heuristics) can land in
parallel; they don't compete with this work.

## What the base rule provides

### Actions (universal, work on every file)

| Action | Shape |
|---|---|
| `find`           | locate matches by selector, return positions and previews |
| `replace`        | swap a matched region with new text |
| `insert-before`  | insert text immediately before a matched region |
| `insert-after`   | insert text immediately after a matched region |
| `delete`         | remove a matched region |

### Multi-strategy match (the heart of the rule)

A single `find` parameter accepts one of several strategies — the
agent picks the one that fits the intent, and the runtime auto-tries
the others on failure to enrich the diagnostic.

| Strategy | Example | When to use |
|---|---|---|
| `exact`       | `"function handleSave("` | the default; agent knows the literal text |
| `fuzzy`       | `{ pattern: "function handleSave(...)", ignoreWhitespace: true }` | whitespace/indentation differs from Read |
| `anchor`      | `{ after: "// === Handlers ===", contains: "handleSave" }` | the literal text isn't unique; relative position is |
| `lines`       | `[142, 156]` | last-resort; positions known from grep/lint |
| `regex`       | `{ regex: "^export (default )?function", flags: "m" }` | structural string pattern beyond literal |

Resolution order on failure:

```
1. Try the strategy the agent specified.
2. If exact failed: try fuzzy automatically (ignore-whitespace).
3. If fuzzy returned a single match: report it as "exact match
   failed; fuzzy match available at L142, whitespace differs by 2
   spaces — apply?" and refuse to write.
4. If multiple matches: list all with line numbers and surrounding
   context (1 line before/after), suggest narrowing strategies.
5. Always include the original input as `tried_strategy` in the
   diagnostic.
```

The principle: **never an empty result, never a silent guess**.

### Failure diagnostics (the trust pillar)

Every base-rule failure returns structured JSON with:

```json
{
  "success": false,
  "code": "MATCH_NOT_UNIQUE",
  "tried_strategy": "exact",
  "matches": [
    { "line": 42,  "preview": "  <Button className=\"...\" />" },
    { "line": 158, "preview": "  <Button onClick={...} />" },
    { "line": 244, "preview": "  <Button>Save</Button>" }
  ],
  "suggestions": [
    "Add 1–2 lines of context to disambiguate.",
    "Use { anchor: { after: 'function handleSave' } } if the target is in a specific scope.",
    "Use replace_all=true if you intend all 3 locations.",
    "Use { lines: [N, M] } as a last resort if you know the position."
  ],
  "next_step_hint": "Re-run with one of the suggestions above."
}
```

Error codes (stable, agent-parseable):

- `MATCH_NONE` — no match by any strategy.
- `MATCH_NOT_UNIQUE` — multiple matches, no `replace_all`.
- `MATCH_FUZZY_ONLY` — exact failed, fuzzy single match available.
- `PARSE_BROKEN_AFTER_EDIT` — write produced invalid syntax for the
  registered language rule; auto-rolled back.
- `BACKUP_WRITE_FAILED` — couldn't write `.tedit.bak`; aborted.

### Verification

- **Always**: write the new bytes; if a language rule is registered
  for the extension, or the file is JSON/Markdown, parse or lightly
  verify the result.
- **On parse failure**: roll back automatically (restore from backup
  or original buffer), return `PARSE_BROKEN_AFTER_EDIT` with the
  parser error message.
- **No registered language rule or lightweight verifier**: skip parse
  (`.txt`, etc.), keep the edit.
- **`--verify-typecheck`**: opt-in, runs project `tsc` on the edited
  file (or its referenced files); rolls back on new errors.

### Rollback safety

Inherits the git-aware default + backup behavior from the existing
RFC (`ISSUE-git-aware-default-write-mode.md`):

- git tracked file → write default, no backup
- git untracked / ignored → write default, auto backup
- no git → dry-run default; `--write` triggers backup
- `--no-backup` to opt out outside git

No edit ever leaves the user/agent without a recovery path.

## CLI surface

Minimum:

```bash
tedit edit <file> --find <text>            --replace <text>            [--write|--dry-run]
tedit edit <file> --find <text>            --insert-before <text>      [--write|--dry-run]
tedit edit <file> --find <text>            --insert-after <text>       [--write|--dry-run]
tedit edit <file> --find <text>            --delete                    [--write|--dry-run]
```

Multi-strategy find:

```bash
tedit edit <file> --find-exact "function handleSave("       --replace "function handleSave(opts: Opts) {"
tedit edit <file> --find-fuzzy "function handleSave(...)"   --replace "..."     [--ignore-ws]
tedit edit <file> --find-anchor-after "// === Handlers ===" --find "handleSave" --replace "..."
tedit edit <file> --find-regex "^export (default )?function" --replace "..."
tedit edit <file> --find-lines 142:156                       --delete
```

Convenience: when only `--find` is passed, behavior is `--find-exact`
with automatic `--find-fuzzy` fallback on failure.

Multi-match handling:

```bash
tedit edit <file> --find "Button"                    # fails: MATCH_NOT_UNIQUE
tedit edit <file> --find "Button" --replace-all      # explicit consent
tedit edit <file> --find "Button" --expect-count 3   # error if count differs
```

Discovery:

```bash
tedit actions <file>                                 # list base + language actions
tedit actions --json                                 # machine-readable
```

### Chain integration

Base actions become chain steps without ceremony:

```
edit --find "useState(false)" --replace "useState(true)" as edit1
edit --find-anchor-after "const config = " --find "timeout: 3000" --replace "timeout: 5000"
```

Mixed with language actions in one chain:

```
edit --find "DEFAULT_TIMEOUT = 3000" --replace "DEFAULT_TIMEOUT = 5000"   # base rule
rename @comp --to Button                                                    # jsx rule
imports.add --from "./constants" --named "DEFAULT_TIMEOUT"                  # jsx/ts rule
```

The agent never has to know "which rule does this action live in" —
it just calls actions.

## Integration with language rules

Two integration points:

1. **Composition (default).** Base rule actions are always available;
   language rules add more actions on top. `tedit actions <file>`
   returns the union.
2. **Fallback (on action failure).** When a language action emits
   `MATCH_NONE` (e.g., a JSX selector matched nothing), the rule can
   optionally surface base-rule candidates as part of the diagnostic:

   ```
   rename failed: selector 'Button[variant="primary"]' matched 0 nodes.
     Closest base-rule string matches for 'Button':
       L42:  <Button className="..." />
       L158: <Button onClick={...} />
     If the intent was a literal text rename, retry with:
       tedit edit <file> --find "Button" --replace "PrimaryButton"
   ```

   This makes language-rule failures self-recoverable without the
   agent re-Reading the file.

## Trust contract (per DESIGN-PRINCIPLES)

| Pillar | Base rule application |
|---|---|
| Selector precision | multi-strategy `find` with strict unique-match-or-fail default |
| Byte-cleanness     | source-range patches; nothing outside the matched span is touched |
| Failure diagnostics | structured codes, candidate lists, suggested next steps — never empty results |
| Rollback safety    | git-aware default + `.tedit.bak` (inherits the existing RFC) |

## Implementation phases

1. **Exact + diagnostics.** Plain string match + the structured
   failure shape. Already covers ~60% of current `Edit` usage with
   strictly better error messages.
2. **Fuzzy fallback.** Whitespace-insensitive match; auto-tried on
   exact failure; surfaced as `MATCH_FUZZY_ONLY` for agent to
   accept/reject.
3. **Anchor + regex.** The advanced strategies. Cover the cases
   exact/fuzzy can't disambiguate.
4. **Verification + parse-rollback** for files where a language rule
   is registered.
5. **Discovery (`tedit actions`)** — list available actions per file
   so agents can introspect rather than guess.
6. **Language-rule fallback hook** — let `rename`, `wrap`, etc.
   surface base-rule candidates in their failure diagnostics.

Phases 1–3 alone make the base rule usable as a drop-in `Edit`
upgrade. 4–6 turn it into the unified surface VISION describes.

## Migration / replacement story

For the agent ecosystem, `tedit edit` should be **drop-in compatible
in spirit** with the current `Edit` tool — same call shape for the
trivial case, smarter on failure, more capable when needed.

Backward-compatible call pattern:

```typescript
// Current
Edit({ file_path, old_string, new_string })

// Base rule
tedit_edit({ file: file_path, find: old_string, replace: new_string })
```

The agent's prompt/skill layer can map `Edit` → `tedit edit`
transparently. Differences appear only when the current `Edit` would
have failed silently or returned a useless error — exactly the cases
the base rule is designed to fix.

For the standalone `tedit` CLI, the existing `edit` shape becomes
canonical; the JSX-specific verbs (`rename`, `wrap`, …) stay where
they are, layered on top.

## Out of scope (intentional)

- Language-aware semantics inside the base rule (closure tracking,
  scope-aware renames, etc.). That's what language rules are for.
- AST manipulation. Base rule is bytes-only with optional parse
  verification — keeping it that way is what makes it work for any
  file type.
- Replacing the actual `Edit` tool in client environments. That's a
  separate skill/plugin integration concern (see follow-up).

## Why this is the right shape (vs. extending Edit incrementally)

The current `Edit` could grow fuzzy matching, better diagnostics,
etc. — but it lives in the agent's host environment, not in `tedit`,
and adding capability there means re-implementing in every host. The
base rule belongs in `tedit` because:

- All the trust infrastructure (selectors, patches, diagnostics,
  backup, git-awareness) is already here.
- Composing with language rules is automatic.
- One implementation, all hosts get it via the same CLI / SDK.

The base rule is `tedit` doing what `tedit` already does, applied to
the lowest-common-denominator file type. No new infrastructure, just
generalization.

## Related

- `VISION.md` — horizon 2; the layered-architecture section
  describes how this composes with language rules.
- `DESIGN-PRINCIPLES.md` — the four trust pillars apply unchanged.
- `ISSUE-chain-ergonomics.md` — base actions plug into chain as
  ordinary steps; named outputs (`as`) work across base and language
  steps.
- `ISSUE-git-aware-default-write-mode.md` — inherited wholesale.
- `ISSUE-chain-flag-handling-and-silent-invalid-output.md` — the
  same loud-error contract applies to base-rule flag parsing.
