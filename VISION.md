# Vision: AI developers deserve real tools, not Notepad

## The premise in one line

> Human developers have had IDEs with structural editing — IntelliSense,
> Rename Symbol, Extract Function, Find Usages, refactor previews — for
> two decades. AI agents got `Edit`: replace this exact string with that
> exact string.

`tedit` exists to close that gap, starting with JSX.

## Why the gap matters

When a human types in an IDE, they don't think in characters. They
think in *symbols and structures*: "rename this component", "wrap this
in a Form", "find all callers of this prop". The IDE handles the
mechanical translation from intent to text. The developer's
**stream of consciousness stays on the problem**, not on
"did I close that tag?" or "is my indentation right?"

When an AI agent edits code today, every action collapses back to
character-level string manipulation. The agent has to:

- mentally model where the closing tag goes,
- write a unique enough `old_string` to avoid mis-matching,
- preserve every space and newline by hand,
- and re-check the file after every edit because there is no
  guarantee the edit went where it meant to.

That's not a tooling problem. It's a **dignity problem**. We're asking
a system perfectly capable of operating at the symbol level to do its
work in Notepad. Of course it stumbles in 2000-line files. A human
developer with the same constraints would too.

## What "real tools" means here

Mirror what an IDE gives a human, but make each capability machine-
addressable so an agent can call it as a tool:

| Human IDE affordance         | Agent equivalent in `tedit`                |
|------------------------------|--------------------------------------------|
| Click on a symbol            | `find <selector>`                          |
| Rename Symbol (F2)           | `rename`                                   |
| Extract / Wrap / Surround    | `wrap`, `unwrap`                           |
| Quick Fix → add import       | `imports.add` / `imports.rename`           |
| Edit attribute in property panel | `prop.set` / `prop.remove`             |
| Find/Replace in File         | universal `find`/`replace` (base rule)     |
| Find/Replace in Files        | universal `find`/`replace` over glob (future) |
| Refactor preview             | dry-run diff                               |
| Multi-cursor on all matches  | a selector matching N nodes                |
| Find Usages                  | `find` across a glob (future)              |
| Go to Definition             | a selector that crosses files (future)     |
| Auto-import on paste         | `imports.add` triggered by a wrap (future) |

The point isn't to clone an IDE. It's to give the agent the same
**vocabulary of structural intent** that a human gets for free.

## The success criterion

When this is working, an agent editing JSX should never need to think
about:

- closing tags,
- indentation,
- unique-enough substrings,
- which of several similar elements it's about to clobber,
- whether it accidentally re-formatted something it didn't mean to.

It should think about *what change it wants to make* and express that
in one step. The agent's stream of consciousness should stay on the
user's problem, not on the file's bytes.

If we ever get to a state where an agent looks at a 2000-line page and
its response is "let me run a `tedit` chain" instead of "let me Read
the file in chunks and write careful `Edit`s", we've shipped the
vision.

## Why JSX first

It's the worst offender for the current tooling regime:

- Nested structure, hand-managed closing tags.
- Same components repeated dozens of times per file.
- Pages routinely hit 1000+ lines in real apps.
- Edits frequently span multiple disjoint locations (the JSX node and
  its import; the prop and the styled-component definition).

Fix JSX and the methodology generalizes.

## Layered architecture: base rule + language rules + cross-cutting

`tedit` is layered so that **no file is ever beyond its reach**, and
language-specific power composes on top of a universal foundation.

```
┌─────────────────────────────────────────────────────────────────┐
│ Cross-cutting     │ chain, session/context-cache, atomic         │
│ layer             │ multi-step, ripple detection, glob ops       │
├─────────────────────────────────────────────────────────────────┤
│ Language rules    │ jsx  ts  md  mdx  html  xml  json  yaml  css │
│ (per extension)   │ rename, wrap, prop.*, expr.*, imports.*,     │
│                   │ heading.rename, key.set, …                   │
├─────────────────────────────────────────────────────────────────┤
│ Base rule (system │ find / replace (exact + fuzzy + anchor),     │
│ rule, all files)  │ insert before/after, delete, dry-run diff,   │
│                   │ rich failure diagnostics, parse verify if    │
│                   │ a language rule is registered                │
└─────────────────────────────────────────────────────────────────┘
```

Key properties of this layering:

- **The base rule applies to every file.** Plain `.txt`, an unknown
  extension, a `.bashrc` — the agent can always reach for
  `find`/`replace`. No file is "unsupported"; at worst it falls back
  to a smarter string editor than the current `Edit` tool.
- **Language rules add capability without subtracting it.** When the
  file extension matches a registered rule, the rule's actions
  (`rename`, `wrap`, `prop.set`, `imports.add`, …) become available
  *in addition to* the base rule. The agent never loses the universal
  surface.
- **Automatic fallback.** A language action that misses (selector
  matched zero nodes, structure unexpected) emits its diagnostic and
  surfaces the base-rule alternatives ("no `Button[variant=…]` node;
  the closest text match for 'Button' is at L142 — use base `find`?").
- **Verification follows the file type.** Base rule does a string
  edit; if a language rule is registered, the post-edit parse runs
  through that rule's parser and rolls back on failure. Unknown
  files skip parse, keep the edit.
- **Discovery is part of the contract.** `tedit actions <file>`
  returns the universal actions plus the language-rule actions
  available for that extension, so an agent meeting a new file type
  knows immediately what it can do.

This layering is what lets the project ship "Edit for AI" as a single
tool: agents always have *something* to call, and richer affordances
appear automatically as more rules land. Replacing the current
`Edit` is just "register the base rule"; replacing the current
ad-hoc JSX/TS workflow is "register the matching language rules."

## Near-term horizons (in priority order)

1. **JSX/TSX** — the current rule. Get this to a state where agents
   trust it more than `Edit` for any JSX change. (See
   `DESIGN-PRINCIPLES.md` for the trust contract.) Imports +
   expression containers (`imports.add/remove/rename/move`,
   `expr.replace/wrap/unwrap/toTernary/toShortCircuit`) are part of
   this horizon and already landed.
2. **Base (system) rule** — universal `find`/`replace` with the same
   trust contract as the language rules: exact match by default,
   fuzzy/anchor fallback with rich diagnostics ("matched 3 locations:
   L42, L158, L244 — disambiguate via …"), backup/rollback, dry-run.
   This is what lets `tedit` *replace* the current `Edit` tool across
   the board, not just for JSX. Every other rule composes on top.

   **Why this is horizon 2, not later.** JSX polish past the current
   point is marginal return. The base rule is *universal coverage* —
   `.ts`, `.js`, `.md`, `.json`, `.css`, `.txt`, anything. It also
   collapses the agent's decision tree from "is this a tedit case or
   an Edit case?" to "always tedit" — which is the single biggest
   adoption multiplier the project has left. JSX trust polish (e.g.
   `text.set` for hardcoded JSXText) can land in parallel; they
   address different dimensions and don't compete.

3. **Cross-file operations** — `find` across a glob, `chain` over a
   set of files. This is the IDE's "Find in Files" + "Replace in
   Files" elevated to selector level. Unlocks codebase-wide
   refactors expressed in one chain.
4. **HTML / MDX / XML** — same engine, new language rules. Each new
   rule is its own trust contract; don't ship one that erodes the JSX
   experience for the sake of coverage.

## Long-term horizons (sketch, not commitments)

- **Selector autocomplete for agents** — given a file, the runtime
  can list "selectors that match exactly one node" so agents can pick
  a precise one instead of guessing.
- **Diagnostic-driven editing** — when a selector matches 0 or N
  nodes unexpectedly, the runtime returns a structured "did you
  mean..." response. Agent recovers without re-Reading the file.
- **AST-level diff** — show changes in terms of "renamed X to Y,
  wrapped Z with W" instead of line-level diff. Reviewers (human or
  agent) see intent, not bytes.
- **Beyond JSX — generation first, editing later**:
  - **Near-term feasibility: TS/JS declaration scaffolding** —
    functions, constants, types, interfaces created as a `chain`
    step or via `tedit add function/const/type/interface`. Reuses
    the scaffold engine; no closure/reference/type-preservation
    hazards because generation only adds nodes. Lower trust risk
    than editing, but lower trust *payoff* too (string `Edit` is
    already safe for top-level declaration appends — the value is
    primarily in chain composition: "create helper + rewrite
    call sites in one stream").
  - **Long-term: structural edits** — rename symbol, extract
    function, move function, change signature, inline variable.
    The full IDE-refactor surface. AST handles "where"; agent
    expresses "what". Significantly higher implementation cost
    (scope-aware selectors, semantic preservation across
    closures/types), gated on JSX trust being fully production-
    grade first.

## What this is not

- Not a replacement for the agent's reasoning. `tedit` doesn't decide
  *what* to change; it just makes the change reliably once decided.
- Not a wrapper around prettier or eslint. Those operate on style;
  `tedit` operates on structure.
- Not a code-generation tool. It mutates existing code based on a
  declared selector + action; it doesn't invent new code from a
  natural-language prompt.

## Inviting contribution

Every PR, issue, or design discussion can ask one question:

> Does this make AI agents code more like humans with IDEs, or less?

If it doesn't move the needle on that question, it's probably a
distraction. If it does — even in a small, specific way — it's worth
shipping.

The audience for this tool is not the human reading the README.
It's the agent that will spend the next decade writing JSX on
someone's behalf. Build for them.
