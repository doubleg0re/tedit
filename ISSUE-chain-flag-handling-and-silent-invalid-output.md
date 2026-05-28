# Chain: silent-invalid output when standalone-CLI flags are used inside a chain step

## Summary

`tedit rename <file> <selector> --to <name>` works as a standalone CLI
invocation. Inside `tedit chain` (and `--from-file` chain text), the
same step **silently parses `--to` as the new tag name itself** and
produces invalid output like `<--to>...</--to>` in the diff — with no
error, no warning, no exit-code change.

Two trust failures in one bug:

1. **Surface inconsistency.** The same action has different argument
   shapes depending on whether it runs standalone or inside a chain.
   Agents (and humans) reading `tedit --help` learn the `--to` syntax
   and reasonably expect it to work in either context.
2. **Silent invalid output.** The unknown-token `--to` is accepted as
   a valid positional argument rather than rejected. The runtime then
   produces a structurally invalid mutation that no downstream parser
   would accept — but `tedit` itself reports success.

This directly violates the DESIGN-PRINCIPLES pillar of *failure
diagnostics*: a chain step that cannot be expressed should not be able
to produce broken JSX while reporting success.

## Reproduction

Round-2 dogfood, on a real file:

```text
# /tmp/swap-scrollarea.chain
find ScrollArea[viewportClassName="px-7 pb-20 pt-1"] as sa
rename @sa --to div                                          ← problematic line
prop.remove @sa viewportClassName
prop.remove @sa verticalScrollbarStyle
prop.set @sa className "flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pb-20 pt-1 [scrollbar-gutter:stable]"
find DailyPlanBody as body
wrap @body div.className="flex flex-1 flex-col gap-4"
```

```bash
node dist/cli.js chain page.tsx --from-file /tmp/swap-scrollarea.chain
```

Observed diff (excerpt):

```diff
-        <ScrollArea
-          className="min-h-0 flex-1"
-          viewportClassName="px-7 pb-20 pt-1"
-          verticalScrollbarStyle={{ marginRight: 0 }}
+        <--to
+          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pb-20 pt-1 [scrollbar-gutter:stable]"
...
-        </ScrollArea>
+        </--to>
```

Process exit code: 0. No warning printed.

Workaround that works today: drop `--to` and use positional form:

```text
rename @sa div
```

That produces the correct, byte-clean diff. So the underlying mutation
machinery is fine — only the chain step argument parser is at fault.

## Why this matters specifically for trust

An LLM agent reading `tedit --help` sees this line:

```
tedit rename <file> <selector> --to <name> [--dry-run|--write]
```

…then later writes a chain step `rename @sa --to div`. The agent has
zero way to know the chain parser drops the flag silently. The only
detection paths are:

- the agent re-reads the file after `--write` and notices `<--to>` —
  which is exactly the kind of post-hoc verification the tool is
  supposed to make unnecessary, or
- the build/typecheck fails downstream, hundreds of seconds later,
  with no breadcrumb pointing back to the tedit call.

Either way, a single typo wastes a round-trip. Scaled across an
agent's session, this is the failure mode that causes agents to
distrust the tool and fall back to `Edit`.

## Proposed resolution

Two complementary changes; either alone is an improvement, together
they restore trust.

### A. Accept the same flag syntax in chain as in standalone CLI

Whichever shape a step takes at the top-level CLI, the chain step
parser should accept too. Concretely:

| Step | Standalone | Chain (today)     | Chain (proposed) |
|------|------------|-------------------|-------------------|
| `rename`     | `--to <name>`             | positional only  | both: `rename @sa --to div` **or** `rename @sa div` |
| `prop set`   | `<name> [value] [--expr c]` | already mixed     | unchanged — already supports both |
| `prop remove`| `<name>`                   | positional        | unchanged           |
| `wrap`       | `--with <tag-or-json>`     | positional        | both: `wrap @sa --with div` **or** `wrap @sa div` |
| `imports add`| `--from … --named …`       | (not yet in chain?) | both                |

Implementation: a small step-level argv parser that recognizes the
same set of flags the standalone command would.

### B. Reject unknown tokens loudly

Independent of (A), any chain step that receives a token it cannot
interpret should fail the chain immediately with a useful message:

```
Error: chain step 2 ('rename @sa --to div'): unknown argument '--to'.
  Did you mean: `rename @sa div`?
  See `tedit rename --help` for standalone flag form.
  Chain step exited at line 2 of /tmp/swap-scrollarea.chain.
```

Key qualities of the error:
- Names the action (`rename`) and step index.
- Quotes the exact line from the chain source.
- Suggests the working form ("Did you mean…?").
- Cross-references the standalone help.

If (A) lands, `--to` is no longer an unknown token in the rename
context. (B) still matters because it catches the general class —
typos, future-deprecated flags, copy-pasted shell snippets that don't
fit chain semantics. The goal is: **no chain step ever silently
produces wrong output**.

## Severity

Medium for the specific `rename --to` case (the workaround is one
positional argument). High as a class — any standalone-CLI flag that
also leaks into chain text is a candidate for the same trap, and the
silent-failure shape is exactly the trust-breaking mode the tool is
supposed to prevent.

## Discovered during

Round-2 dogfood after the recent surgical-patch + chain-ergonomics
landings. The chain itself (with `as`, `@ref`, shorthand,
`--from-file`) worked beautifully — diff went from ~80 lines of
recast-noise to **12 lines of exactly-intended changes**. This bug was
the only friction in the whole flow, and it was caught on the first
try only because the diff happened to show the literal `<--to`
substring.

## Related

- `DESIGN-PRINCIPLES.md` pillar 3 (failure diagnostics) — silent
  invalid output is the canonical violation.
- `ISSUE-chain-ergonomics.md` — already-landed surface that this bug
  rides on top of. Fixing this is a small follow-up, not a redesign.

## Resolution

Implemented.

- Added a step-level chain argv parser that accepts standalone-style
  flags for chain actions: `rename --to`, `wrap --with`,
  `append/prepend --element`, `prop.set --expr`, import flags, and
  expression flags.
- Changed `tedit chain` CLI parsing so it only consumes chain-global
  flags (`--from-file`, `--from-stdin`, `--params`, `--write`,
  `--dry-run`, `--json`, `--help`). Other `--flags` stay inside the
  chain stream and are validated by the owning step.
- Added loud failure for unknown step flags with `INVALID_CHAIN`, action
  name, segment index, line number for chain text, and the original
  source line.
- Preserved source/line metadata through `as <name>` extraction so
  named-output steps still report useful diagnostics.

Regression coverage:

- `chain accepts standalone-style flags inside steps`
- `inline chain preserves step flags instead of parsing them as top-level flags`
- `chain rejects unknown step flags loudly`

Verification:

- `npm test` passed: 33/33 tests.
