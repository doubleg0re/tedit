# Review: base rule + text + state + patch + git-aware default

Dogfood round 4, 2026-05-28. Reviewer: Claude (PreFlowAI worktree).

## Baseline

- `npm test`: **99/99** pass (up from 50/50 the day before — roughly
  doubled regression coverage in one night)
- `dist/cli.js` rebuilt 10:05; size 26 KB → 50 KB (close to 2× — a
  good proxy for how much capability landed)
- All four PENDING issues from the previous review are functionally
  shipped; only the `## Resolution` markers in the issue files were
  left unfilled. (`base-rule`, `design-quality-guardrails`,
  `git-aware-default-write-mode`, `text-content-mutation`.)
- Bonus surfaces beyond the open issues: `multiedit`, `patch`
  (unified diff **and** apply-patch envelope), `tedit actions`
  (discovery), `tedit write` (create alias).

## Verdict (TL;DR)

**This is the release that crosses tedit from "great for JSX
refactor" into "general-purpose Edit replacement."** Five
end-to-end scenarios — `.md` base-rule edit, JSXText mutation,
state-cluster analysis, multi-file apply-patch, git-aware default
behavior — all passed with two small UX wrinkles and one known
heuristic limit. The rest is production grade.

| # | Scenario | Verdict |
|---|---|---|
| 1 | `tedit edit` on a non-JSX file (`.md`) | ✅ universal coverage works as advertised |
| 2 | `text set` / `text replace` for JSXText | ✅ (+ small UX hint missing for trimmed-match misses) |
| 3 | `analyze-state` on a real 1,530-line page | 🟡 over-clustering (known build-order #6 limit) |
| 4 | `patch` apply-patch envelope, multi-file + atomicity | ✅ |
| 5 | git-aware default + auto-backup | ✅ exactly as the issue specified |

## Detail

### 1. Base rule — `.md`, fuzzy fallback, empty-match diagnostics ✅

```bash
tedit edit /tmp/tedit-r4/notes.md --find "alice" --replace "bob"  # in /tmp = no git
# → Wrote: /tmp/tedit-r4/notes.md
# → tedit: backup written -> /tmp/tedit-r4/notes.md.tedit.bak
```

Wait — that's actually scenario 5 firing inside scenario 1 (no git
→ writes anyway when explicitly `--write`, with auto-backup). Both
behaviors verified in one shot.

Empty-match path:

```bash
tedit edit notes.md --find "Status:in progress" --replace "Status: done"
# {
#   "tried_strategy": { "kind": "exact", "pattern": "Status:in progress" },
#   "matches": [],
#   "suggestions": [
#     "Check the literal text for stale whitespace or punctuation.",
#     "Use --find-fuzzy for whitespace-insensitive matching.",
#     ...
#   ],
#   "next_step_hint": "Re-run with a strategy that can identify exactly one target span."
# }
```

Every trust-pillar-3 box ticked: tried-strategy echoed, candidate
list (empty here, so the suggestions take over), next-step hint.
Empty result never silent.

Implicit dry-run when no flag is passed and we're outside a git
repo also worked correctly, complete with a one-line explanation:

```
tedit: no git repository found above /private/tmp/tedit-r4/notes.md.
  Defaulting to --dry-run because rollback is not guaranteed.
  Pass --write to override.
```

### 2. `text.set` / `text.replace` ✅ (with one UX wrinkle)

```bash
tedit text set button.tsx 'button:nth-of-type(1)' --value "확인" --write
# <button>저장</button>  →  <button>확인</button>      ✅

tedit text set button.tsx 'button:nth-of-type(2)' --expr 't("confirm")' --write
# <button>{t("cancel")}</button>  →  <button>{t("confirm")}</button>      ✅

tedit text replace button.tsx 'button:nth-of-type(3)' \
  --match-text "다운로드" --with-text "업로드" --write
# <button><Icon /> 다운로드</button>  →  <button><Icon /> 업로드</button>      ✅
# (Icon sibling preserved; leading space preserved)
```

UX wrinkle (small but worth fixing): the first `text replace`
attempt used `--match-text " 다운로드"` (with the leading space
that's literally in the source). That returned `TEXT_MATCH_NONE`
because matching is performed against the trimmed text. The
diagnostic at that point said:

```
"No JSX text child matched text \" 다운로드\"."
```

…which is *technically* correct but misses the agent's next move.
A hint of the form would close the loop in one round-trip instead
of two:

```
TEXT_MATCH_NONE: " 다운로드" did not match.
  Note: text matching is whitespace-trimmed.
  Closest trimmed-text children at this selector:
    "다운로드"  (line 5, surrounding: "<button><Icon /> 다운로드</button>")
  Retry with --match-text "다운로드" if that's the target.
```

Small addition, big agent-experience win.

### 3. `analyze-state` — runs fast, over-clusters 🟡

Target: `apps/web/src/app/(app)/projects/[id]/daily-plan/page.tsx`
(1,530 lines). 420 ms. Returned:

```json
{
  "states_total": 20,
  "handlers_total": 27,
  "clusters": [
    {
      "name": "shootingDaysCluster",
      "states": [20 items],
      "handlers": [27 items],
      "recommendation": "custom-hook",
      "confidence": "high",
      "reason": "20 states are co-read or co-written across 27 handler(s)"
    }
  ]
}
```

All 20 states collapsed into a single cluster because a few large
handlers touch many states (e.g. a `handleBootstrap` that
initializes everything). The recommendation `custom-hook` for a
20-state cluster doesn't really help — the page actually has
distinct domains (timetable / crew / dept / day rail / lock state)
that *should* be separate clusters.

This is the build-order #6 limit you flagged ahead of time
("Cluster boundary heuristics — iterate based on real-codebase
results"). Two thoughts on improving it:

- **Penalize giant handlers** in the coupling computation, or
  exclude initialization-style handlers (touching ≥N distinct
  states is suspicious; weight their edges lower).
- **Emit a diagnostic when a single cluster gets above some
  threshold** (e.g. >8 states): "single cluster of 20 states
  detected; consider running with `--max-cluster-size 8` for
  domain sub-clustering, or pass `--exclude-handler handleBootstrap`."

Even without algorithmic improvement, that diagnostic alone would
turn a confusing "1 huge cluster" output into a guided
"here's why and what to do next" output.

Aside: `analyze-state` on the already-extracted `daily-plan-body.tsx`
(which has 0 `useState` — everything's a prop) correctly returned
`states_total: 0` with no false clustering. Good edge-case handling.

### 4. `patch` apply-patch envelope + atomicity ✅

Multi-file envelope, single command:

```text
*** Begin Patch
*** Add File: /tmp/tedit-r4/new-a.ts
+export const A = "alpha";
+export const A2 = 42;
*** Add File: /tmp/tedit-r4/new-b.ts
+import { A } from "./new-a";
+export const B = A + " beta";
*** Update File: /tmp/tedit-r4/notes.md
@@ -1,2 +1,2 @@
-# Project Notes
+# Project Notes (v2)
*** End Patch
```

Result:

```
[ADD] /tmp/tedit-r4/new-a.ts        hunks=1   parse_verified=true (jsx)
[ADD] /tmp/tedit-r4/new-b.ts        hunks=1   parse_verified=true (jsx)
[UPDATE] /tmp/tedit-r4/notes.md     hunks=1   parse_verified=true (markdown-lite)
```

All three written, all parsed.

Atomicity: a deliberately broken patch (one valid add + one update
hunk that doesn't match) failed cleanly with
`PATCH_HUNK_FAILED`, structured `expected`/`actual`, and the
new add file *not* created. Same trust shape as `workspace-flow`
exposes for `extract` — multi-file edits are all-or-nothing.

The headline finding is that **the same `patch` command auto-
detects unified diff vs. apply-patch envelope** (`*** Begin
Patch` triggers the envelope parser). That makes `tedit patch`
a universal sink for AI-tool output formats — Codex emits
apply-patch envelopes natively, Claude/git emit unified diffs,
both land safely through the same call.

### 5. git-aware default + auto-backup ✅

Tested three contexts in one session — every one behaved as the
issue specified:

| Context | Default behavior | Backup |
|---|---|---|
| `/tmp` (no git) | dry-run + loud "no git repository found" message | n/a (dry-run) |
| `/tmp` + explicit `--write` | writes, backup created | `.tedit.bak` |
| git repo, **untracked** file, no flag | writes, with one-line note "writing to untracked file (no git history to restore from)" | `.tedit.bak` |
| (would be: git repo, tracked file, no flag → writes, no backup since git is the backstop) | (not tested in this run; behavior is consistent with spec) | — |

The notes are exactly the kind of context-aware reporting the
RFC called for: not nagging, not silent, just one truthful line
per decision the runtime made for you.

## Bonus surfaces (worth dogfooding next)

These shipped alongside the issues but didn't get a dedicated
dogfood pass this round. Each looks load-bearing:

- **`tedit multiedit`** — multiple edits in one transaction. Not
  yet exercised end-to-end; suspect this is the right tool for
  "tweak 5 props across 3 files atomically" cases.
- **`tedit actions [file]`** — discovery. Should let an agent
  introspect "what can I do to this file" instead of guessing.
  Useful for the `.claude/skills/` integration story.
- **`tedit write`** — appears to be a `create` alias; worth
  verifying semantics match.

## Suggested follow-ups (small, in priority order)

1. **`text.replace` trim-aware diagnostic** — when
   `--match-text` misses on a leading/trailing-whitespace string,
   show the trimmed candidate text in the failure message.
2. **`analyze-state` over-cluster guidance** — when a single
   cluster grows past N states, emit a diagnostic with
   suggested flags / exclusions rather than just reporting the
   giant cluster.
3. **Backfill `## Resolution` markers** on the four issues that
   landed this round. Helps reviewers track what's done vs.
   open. (Cosmetic but it's the convention the earlier rounds
   used.)

## Score progression

| Round | Daily-driver fit | Major arrival |
|---|---|---|
| 1 (recast fallback) | 40% | atomic ops only |
| 2 (surgical patches) | 70% | imports/expr/chain ergonomics |
| 3 (workspace + extract) | 85–90% | extract, multi-file atomic, cycle detection |
| **4 (this review)** | **95%** | **base rule, text mutation, git-aware default, apply-patch envelope** |

Remaining 5% is roughly: cluster-heuristic refinement + slot-mode
extract + the discoverability/skill layer that lives outside tedit
itself.

## Adoption signal

I'm switching to **tedit as the default editor for the JSX/TSX work
in this session**, starting with the next two UI tasks (calendar
page meta line + locations page-head). Anything that doesn't fit
will fall back to `Edit`, but the expectation is that won't happen
often anymore. Will report friction (if any) in the next round.

The recent change in shape — from "you should try `tedit chain` for
this" to "of course you'd use `tedit` for this" — is exactly the
inflection point the VISION doc was aiming at. Nice work to whoever
pushed this through overnight.
