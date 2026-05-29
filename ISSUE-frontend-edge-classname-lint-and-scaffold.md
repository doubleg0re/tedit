# Make tedit the default for frontend work: className-conflict lint + convention scaffold

## Status

Implemented in this branch. Filed from a dogfood run (PreFlowAI 2026-05-29, "산출행(CalcRow) 편집기
컴포넌트화 + 디자인 적용" — extracted a ~400-line React component, all edits via
tedit MCP).

Implemented scope:

- JSX/TSX className conflict warnings for static strings and common helper calls.
- Project config for custom class groups and disabling the guardrail.
- Warning surfacing in `verify-file`, edit/mutation results, compact CLI output,
  and compact MCP output.
- Built-in `react-component` / typed `react-client-component` shell templates
  plus docs for the intended scaffold shell -> body edit/write -> imports flow.

## Context: where tedit already wins, and where it doesn't

This run was a good stress test. tedit clearly won on:

- **`findLines` range delete** — removed a ~405-line function in one call.
  Impossible to express as an `Edit` old_string.
- **`imports_add`** — AST import insertion, location-independent.
- **`multiedit` + `replaceAll` + `--dry-run`** — repeated substitution
  (`w-9` → `!w-[60px]`) verified before write.
- **`parse_verified: jsx`** on every write — syntactic safety net.
- compact output — the earlier `--summary`/MCP-compact work paid off; reading
  results costs ~nothing now.

It did **not** add much value (vs `Write`) on:

1. **Large new file / full rewrite.** Providing full content is identical to
   `Write`; tedit only adds parse-verify + backup. Don't fight this — `Write`
   is the right tool for greenfield / >80% replacement.
2. **Tailwind / CSS specificity bugs.** `w-9` lost to NumInput's base
   `w-full` (Tailwind precedence is stylesheet-order, not class-attribute
   order). Parse passed; the bug was visual. Only caught via browser preview.
3. **Brittle multiline `find`** — one mis-indented line → no match. (Same as
   `Edit`; mitigated by fuzzy fallback + dry-run.)

## Proposal A (high value, tedit-specific): className-conflict lint

#2 is the one downside tedit can actually turn into a *win*, because tedit
parses the JSX AST and can therefore read `className` string literals — which
`Write`/`Edit` never can.

Add a lint pass (surfaced in parse-verify output) that flags, per element,
multiple Tailwind utilities from the **same property group** without `!`:

```
⚠ calc-row-editor.tsx:212  <input> width conflict:
    "w-full" (base) + "w-9" (added) — later utility may not win.
    Use "!w-9" or remove the base.
```

Implementation: a static map of conflicting prefixes (`w-`, `h-`, `p[xytrbl]?-`,
`m[xytrbl]?-`, `bg-`, `text-`, `border` width, `rounded`, `flex`, `gap-`, …).
Walk JSXAttribute `className` string/`cn(...)` args, bucket by group, warn on
>1 in a group lacking `!`. Heuristic (won't catch `cn()` runtime concatenation
perfectly) but would have caught this exact bug at edit time.

**Why it matters:** this is the thing that justifies "use tedit by default for
frontend." A syntactic editor that also catches the #1 class of silent
Tailwind bugs is strictly better than Write/Edit for React+Tailwind.

## Proposal B (from the dogfood discussion): convention-aware scaffold

Idea: instead of the agent hand-writing the whole new file (≈ `Write`), let
tedit emit a **skeleton from a small spec**, which the agent then fills /
edits — moving construction into tedit's structural wheelhouse.

```
tedit scaffold MyComponent.tsx --type react-client-component \
  --name CalcRowEditor \
  --props "calc:CalcRow, disabled:boolean, onUpdate:(f:keyof CalcRow,v:unknown)=>void"
```
→ emits: `"use client"`, conventional imports (cn, useTranslations…), a
`CalcRowEditorProps` interface, the function shell with destructure + a stub
`return`. Agent fills the body.

### Honest limits (so it's scoped right)

- **Value is proportional to boilerplate ratio.** For a logic-heavy component
  (this one: 4 calc types, preset/episode/cast logic) the skeleton is <10% of
  the file — scaffold saves little; the body is still a `Write`/edit. For
  **boilerplate-heavy** file types (a new route/page, a test file, a simple
  card, an MCP tool handler, a CRUD slice) the skeleton is 60%+ → big win.
- **Imports are chicken-and-egg.** You don't know all imports until you write
  the body. So don't require imports upfront — scaffold the shell, then use
  `imports_add` as the body grows (tedit's import surgery is already strong).
- Real differentiation needs **project conventions** baked in (house style:
  `'use client'`, `cn` from `@/lib/utils`, `XProps` naming, i18n via
  `useTranslations`). That implies a per-project template config
  (`.tedit/templates/*`). Without it, scaffold ≈ a generic snippet and `Write`
  is just as good.

### Recommended shape

- Ship a few **built-in templates** (react component, hook, test) + allow
  **project templates** in `.tedit/templates/`.
- Sweet spot is **scaffold shell → one Write/edit for the body → imports_add
  for deps**, not full structural construction (N structural appends = more
  round-trips than one body write).

## Decision rule (for the agent, today — no code needed)

- **tedit**: multi-file, large-range delete, repeated substitution, import
  surgery, structural (rename/wrap/extract), or any edit where parse-verify
  matters.
- **Write**: brand-new file or >80% full-content replacement (structural
  editing adds nothing).
- **Preview/visual check is non-negotiable** for CSS/Tailwind — tedit verifies
  syntax, not rendered result.

Proposal A would shift more frontend work into the "tedit" column by making it
catch visual-class bugs at edit time. Proposal B helps only for
boilerplate-heavy file types and only with project templates.
