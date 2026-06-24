# Git-aware default write mode

## Summary

`tedit` defaults mutations to dry-run today. That's the right default
for humans, but the wrong default for agents whose entire workflow
already runs inside a git repo with cheap `git restore` rollback. The
proposal: **default to write when the target file is in a git working
tree that can revert it; default to dry-run otherwise, with a loud
warning.**

This keeps the agent's stream of consciousness uninterrupted in the
common case (git repo + write + verify via `git diff`) while
preserving the safety net in the uncommon case (untracked file,
no-git directory, file outside repo).

## Status — 2026-05-27

Implemented:

- Shared write-policy resolver for mutation commands, creation
  commands, extract, workspace-flow, and chain-workspace.
- Auto default behavior when neither `--write` nor `--dry-run` is
  passed:
  - tracked git files write by default;
  - untracked files in a git repo write by default with a note;
  - ignored files and no-git files default to dry-run with a warning.
- Explicit `--write` / `--dry-run` override auto behavior.
- `TEDIT_DEFAULT_WRITE=true|false|auto`.
- `.tedit/config.json` `defaultWrite: "auto" | "true" | "false"`.
- Backup policy for writes: `.tedit.bak` is written when git cannot
  restore the previous bytes, or when `--backup` /
  `TEDIT_BACKUP=always` is used. `--no-backup` /
  `TEDIT_BACKUP=never` opts out.
- JSON output includes `write_policy` and backup path metadata.
- Workspace transactions resolve write policy after computing changed
  files and write only when every changed file is write-eligible.

Still follow-up:

- Backup messages are included in normal output / JSON; they are not
  routed specially to stderr.
- No `tedit cleanup` for backup removal.

## Resolution — 2026-05-28

Git-aware write policy is implemented across mutation, creation, extract,
workspace, chain, patch, and multiedit paths. Explicit writes outside git
produce `.tedit.bak` backups by default; tracked git files can rely on git
for rollback. Remaining cleanup ergonomics are optional follow-ups.

## Motivation

For an agent:

- `--write` requires the agent to make two calls per edit (dry-run +
  write) or to confidently skip dry-run. The first wastes round-trips,
  the second adds risk.
- In git, `git diff` and `git restore` give post-hoc verification and
  trivial rollback. The agent doesn't need `tedit`'s dry-run as a
  safety net — git already provides one.
- The result of always-dry-run-by-default is the agent invents
  inconsistent patterns ("did I add `--write`?"), which itself becomes
  a trust-erosion surface.

For a human:

- Outside a git repo, dry-run is the only safety net. Defaulting to
  write there is dangerous and surprising.
- Even inside a repo, a human running an experimental chain on an
  untracked scratch file expects dry-run-first behavior.

The solution isn't "pick one default" — it's **detect context and
behave accordingly, transparently**.

## Proposed behavior

When a mutation command is invoked without explicit `--write` or
`--dry-run`:

```
┌───────────────────────────────────────┐
│ Target file in a git working tree?    │
│  AND tracked OR git considers parent  │
│  dir a repo?                          │
└──────────┬────────────────────────────┘
           │
     Yes ──┴── No
     ▼         ▼
 default       default
 = write       = dry-run
 (silent)      + warn loudly
```

### Cases

1. **File is tracked in a git repo** → default `--write`. Same as
   today's `--write` invocation, no prompt.
2. **File is in a git repo but untracked (new file)** → default
   `--write`, but emit a one-line note: `tedit: writing to untracked
   file (no git history to restore from).` This is the create/scaffold
   path — already a new-file operation, untracked is expected.
3. **File is in a git repo but the working tree has uncommitted
   changes to this file** → default `--write`, with a one-line note:
   `tedit: target file has uncommitted changes; recovery requires
   diff inspection.` Still safe enough (git can show prior state via
   reflog/stash) but worth flagging.
4. **No git repo found in ancestors** → default `--dry-run`, with a
   loud warning:
   ```
   tedit: no git repository found above /abs/path/file.tsx.
     Defaulting to --dry-run because rollback is not guaranteed.
     Pass --write to override (you are responsible for backups).
   ```
   Exit code 0 but the diff prints to stdout (same as explicit
   dry-run).
5. **`.gitignore`d file in a git repo** → treat as case 4 (no git
   rollback). Same warning.

### Explicit overrides always win

- `--write` always writes, regardless of git state. The warning in
  case 4/5 disappears.
- `--dry-run` always dry-runs, even in case 1.

The auto-detection only changes what happens when **neither flag is
passed**. Existing scripts that always pass `--write` keep working
unchanged.

### Configuration

Two layers, both optional:

```bash
TEDIT_DEFAULT_WRITE=true   # force write-default everywhere (current --write semantics)
TEDIT_DEFAULT_WRITE=false  # force dry-run-default everywhere (current behavior)
TEDIT_DEFAULT_WRITE=auto   # the git-aware logic above (proposed default)
```

Project-local config (optional follow-up):

```json
// .tedit/config.json
{ "defaultWrite": "auto" }
```

`auto` matches the proposed behavior. Hard `true`/`false` lets teams
opt into one mode if they don't like the auto-switching.

## Why this is a trust feature, not a convenience feature

Per DESIGN-PRINCIPLES, the three pillars are selector precision,
mutation byte-cleanness, and failure diagnostics. Git-awareness
arguably introduces a **fourth implicit pillar: rollback safety**.

Today, dry-run is the only safety mechanism. That conflates two
distinct concerns:
- "let me preview before committing" (a human-review tool)
- "let me undo if it goes wrong" (a rollback tool)

Git already covers the second. By detecting git and using it as the
rollback authority, `tedit` can stop pretending dry-run is the
backstop and reserve dry-run for its real purpose (review). This
matches what every other mature CLI in the ecosystem does — `npm
install` writes immediately because `package-lock.json` + git is the
backstop; `terraform apply` requires `plan` first because it operates
on resources git can't restore.

`tedit` lives in the first camp (mutates source files that git
already versions), so write-by-default-when-safe is the principled
choice.

## Backup files (the no-git fallback safety net)

The git-aware logic handles the *common* case (you're in a repo,
write-default is safe). For the *uncommon* but real case — user
explicitly passes `--write` in a no-git directory, or `TEDIT_BACKUP`
is set on — `tedit` should drop an in-place backup before mutating.
This is the seatbelt for "I know what I'm doing, but make sure I can
still undo it if I'm wrong."

### Behavior

For any `--write` invocation:

| Condition | Backup written? |
|---|---|
| In git repo, file tracked, `TEDIT_BACKUP` unset | **No** (git is the backstop) |
| In git repo, file tracked, `TEDIT_BACKUP=always` | Yes |
| Not in git repo, `--write` explicit, `TEDIT_BACKUP` unset | **Yes** (auto fallback) |
| Not in git repo, `TEDIT_BACKUP=never` | No (user opted out) |
| `--no-backup` flag passed | No, regardless |

Default policy: **backup when git can't rescue you, skip when it can**.

### Backup file shape

- Path: `<file>.tedit.bak` (sibling of the original, same dir).
  - Simple, no hidden directories to manage.
  - Trivially restorable: `mv file.tsx.tedit.bak file.tsx`.
  - Easy to spot in a directory listing or `.gitignore`.
- Contents: the **pre-mutation** source, byte-identical.
- Generation: 1-generation retention. Each new `--write` overwrites
  the previous `.tedit.bak`. No timestamped accumulation, no cleanup
  daemon needed.
- Multi-step chain: backup taken **once at the start of the chain**,
  not per step. Restoring `.tedit.bak` rolls back the entire chain.

### CLI

```bash
tedit rename file.tsx 'ScrollArea' div --write             # backup decided by policy table
tedit rename file.tsx 'ScrollArea' div --write --backup    # force backup
tedit rename file.tsx 'ScrollArea' div --write --no-backup # force skip
```

Env vars:

```bash
TEDIT_BACKUP=auto       # the policy table (default)
TEDIT_BACKUP=always     # always write a .tedit.bak
TEDIT_BACKUP=never      # never write a .tedit.bak
```

### Reporting

Every write that produces a backup prints one line to stderr:

```
tedit: backup written → file.tsx.tedit.bak
```

JSON output (when applicable) includes:

```json
{
  "success": true,
  "wrote": "file.tsx",
  "backup": "file.tsx.tedit.bak"
}
```

So agents can chain a "verify and clean up" step:

```bash
tedit chain ... --write && tedit verify ... && rm file.tsx.tedit.bak
```

(A future `tedit cleanup` could batch-remove `.tedit.bak` files
matching a glob — minor follow-up.)

### Edge cases

- **`.tedit.bak` already exists** (previous run, not cleaned up):
  overwrite. Single-generation by design — the most recent
  pre-mutation state is the only one worth keeping.
- **Backup write fails** (no permission, disk full): abort the
  mutation. Better to fail loudly than write the source without
  a recovery point.
- **Target file doesn't exist yet** (create/scaffold/new): no
  backup needed — there's no prior state to preserve. `tedit`
  refuses to overwrite an existing file at creation time anyway.
- **`.gitignore` recommendation**: project setup should add
  `*.tedit.bak` to root `.gitignore`. Tedit can emit a one-time
  hint the first time it creates a backup in a git repo:
  ```
  tedit: consider adding '*.tedit.bak' to .gitignore
  ```
- **Symlinks**: backup the *target* file (`realpath`), not the
  symlink itself.

### Why this fits the rollback-safety pillar

The git-aware default delegates rollback to git when present.
Backups extend the same principle to environments git doesn't cover:
**every `--write` should have a way back to the previous state, even
if it's just a sibling file**. Together, the two cover:

| Environment | Rollback path |
|---|---|
| Git repo, tracked file | `git restore <file>` |
| Git repo, untracked or ignored | `mv <file>.tedit.bak <file>` (auto backup) |
| No git repo | `mv <file>.tedit.bak <file>` (auto backup) |
| Explicit `--no-backup` outside git | None (user accepted the risk) |

No `tedit --write` ever leaves the user (or agent) with nothing.
That's the contract.

## Implementation notes

1. Resolve absolute path of target file.
2. Walk parents for `.git` dir (cap at filesystem root).
3. If found: shell out to `git ls-files --error-unmatch <file>` to
   determine tracked status. (Or use a Node git library; either way
   the question is binary: "can git restore this file?")
4. Optionally `git status --porcelain <file>` for the "uncommitted
   changes" case.
5. Apply the decision table above. All git calls are read-only and
   fast (single-file scope, no full status).

Caching: detect once per `tedit` invocation. Chains run many steps
against the same file; one git check is enough.

Failure mode: if git binary is missing or `.git` is corrupt, treat
as case 4 (no git → dry-run + warn). Never silently default to write
when git status can't be confirmed.

## Edge cases

- **Worktrees / submodules**: `git rev-parse --is-inside-work-tree`
  handles these correctly; same logic applies.
- **Bare repos / sparse checkouts**: very rare for source editing;
  treat as case 4.
- **Permissions issues reading `.git`**: case 4.
- **Symlinks**: resolve `realpath` before walking parents.
- **CI environments**: usually a fresh clone with no commits since
  checkout; everything tracked → case 1, write-default works. If CI
  doesn't checkout source (artifact-only), case 4 → dry-run, agent
  notices the warning and adjusts.

## Severity

Medium-low for safety (current dry-run default is conservative, not
broken). Medium-high for **agent ergonomics** — the round-trip cost
of always passing `--write` is one of the few remaining frictions
between the agent and "use tedit like an IDE refactor button". Fixing
this completes the picture from VISION.md: the agent's stream of
consciousness stays on the change, not on flag bookkeeping.

## Related

- `VISION.md` — stream-of-consciousness goal is directly served by
  removing the dry-run round-trip when git makes it safe.
- `DESIGN-PRINCIPLES.md` — proposed implicit fourth pillar (rollback
  safety) makes the existing three more coherent: dry-run becomes a
  review tool, not a safety net.
- `ISSUE-chain-ergonomics.md` — chains are where the
  always-pass-`--write` friction is most felt; this fix is its
  natural counterpart.
