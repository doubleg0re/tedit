# MCP server integration — first-class agent surface
Status: Implemented initial MCP integration on 2026-05-28.

Implemented scope:
- Added stdio MCP server entrypoint at `src/mcp.ts` and package bin `tedit-mcp`.
- Added MCP tool handler layer at `src/mcp-tools.ts` over existing core engines.
- Exposed core tools: `edit`, `multiedit`, `patch`, `actions`, `analyze_state`, `refactor_state`, `chain_workspace`.
- Exposed common JSX/TSX wrappers: `find`, `inspect`, `append`, `prepend`, `wrap`, `unwrap`, `remove`, `rename`, `prop_set`, `prop_remove`, `text_set`, `text_replace`, `insert_comment`, import tools, expression tools, and `extract`.
- Added README setup docs and MCP client regression coverage.

Distribution hardening:
- Package metadata exposes both `tedit` and `tedit-mcp` bins.
- The MCP server version is read from package metadata instead of being hardcoded.
- Regression coverage runs `npm pack --dry-run --json` and asserts that the CLI/MCP dist files, README, and package metadata are included.
- `npm run pack:check` now fails if backup artifacts such as `.bak` or `.tedit.bak` enter the package tarball.
- MCP parity now includes `verify_file`, `extract_plan`, and `apply_plan`, with stdio client regression coverage for listing and calling the new tools.

Remaining polish:
- Publish smoke testing is higher priority than internal wrapper refactors:
  verify `npx -y tedit@<version> --version`, CLI startup, MCP startup, bin
  shebang/executable bit, package size, and no `postinstall` script from a
  clean packed or published artifact.
- The MCP tool layer is intentionally thin. Extract `cli.ts` command wrappers
  into shared command modules only if CLI/MCP behavior starts to diverge in a
  way tests cannot comfortably cover.



## Summary

Add a Model Context Protocol (MCP) server to `tedit` so agents
(Claude Code, Cursor, any MCP-aware host) can call every tedit
command as a **first-class tool** instead of going through `Bash`.

The CLI stays as-is — it's the universal surface for humans, CI,
and non-MCP hosts. The MCP server is a **thin transport wrapper
on top of the same internal core** the CLI already calls. Both
surfaces share parsing, mutation, verification, backup, and
git-awareness — only the input/output transport differs.

This is the single largest remaining adoption multiplier for
agents: it removes the round-trip and escape costs that currently
make agents skip tedit for small edits.

## The problem this solves

Today, every tedit call from a Claude Code session looks like:

```
Bash("node ~/playground/tedit/dist/cli.js edit file.tsx --find ... --replace ...")
```

That call shape forces five friction points:

1. **Bash round-trip** — process launch, argv parsing, shell quoting.
2. **Shell escape hell** — multi-line JSX strings, Korean text, nested
   quotes; agents resort to writing JSON files just to pass them in.
3. **Output parsing** — `Bash` returns a string; the agent must
   `JSON.parse` the result blob.
4. **Verbose surface** — every call shows the JSON dump in the
   transcript, regardless of whether the agent needed any of it.
5. **Discovery friction** — `tedit` lives in one's mind as "a CLI in
   that folder" rather than "an editor tool sitting next to `Edit`."

Net effect: for any single-line change, the agent picks `Edit`
because it's cheaper, even when the change would benefit from
tedit's parse-verify + atomicity + git-awareness. The 81-prop
disaster's structural cousin lives here — the safer path is
*technically available* but the friction makes the agent skip it.

## Surface, post-MCP

```
mcp__tedit__edit({ file, find, replace })           // base rule
mcp__tedit__multiedit({ edits: [...] })             // atomic batch
mcp__tedit__patch({ patch })                        // unified diff / apply-patch envelope
mcp__tedit__extract({ from, selector, to, name })   // JSX refactor
mcp__tedit__rename({ file, selector, to })          // JSX rule
mcp__tedit__wrap({ file, selector, with })          // JSX rule
mcp__tedit__text_set({ file, selector, value })     // JSXText mutation
mcp__tedit__analyze_state({ file })                 // diagnostic
mcp__tedit__chain_workspace({ steps: [...] })
mcp__tedit__actions({ file })                       // discovery
...
```

Each tool's params mirror the CLI's flags / spec JSON. Each tool
returns the same structured JSON result the CLI already emits — no
new schema, no new error codes.

## Architecture

```
        ┌──────────────────┐         ┌──────────────────┐
        │  CLI (cli.ts)    │         │ MCP (mcp.ts)     │
        │  argv → params   │         │ JSON → params    │
        │  result → stdout │         │ result → MCP     │
        └────────┬─────────┘         └─────────┬────────┘
                 │                              │
                 └──────────────┬───────────────┘
                                │
                  ┌─────────────▼──────────────┐
                  │ Internal core (unchanged)  │
                  │ runEdit / runMultiedit /   │
                  │ runPatch / runExtract /    │
                  │ runScaffold / runChain /   │
                  │ git-aware default + backup │
                  └────────────────────────────┘
```

Two thin transports over one shared engine. No business logic
duplication. The MCP layer's job is purely shape conversion:

- MCP tool call → internal param object (the same one the CLI
  builds from argv)
- internal result → MCP response (the same JSON the CLI emits)

If the CLI grows a new flag, the MCP tool gets the same parameter.
If a new action lands, two lines of registration in `mcp.ts` and
it's exposed.

## Registration & usage

Standard MCP convention:

```json
// User's .mcp.json or settings
{
  "mcpServers": {
    "tedit": {
      "command": "node",
      "args": ["/path/to/tedit/dist/mcp.js"]
    }
  }
}
```

Once registered, the host (Claude Code, Cursor, etc.) auto-loads
the tool list. No further config. Discovery via the standard MCP
`listTools` call.

For projects that want tedit available everywhere by default, the
server can also be packaged as `npx`-runnable so the config is:

```json
"args": ["-y", "tedit-mcp"]
```

(Same shape as `@modelcontextprotocol/server-filesystem` etc.)

## What this unlocks

For the agent:

- **Single-line `Edit` substitution becomes free.** No Bash, no
  escape, no JSON parsing. Cost identical to native `Edit`.
- **Decision tree collapses.** "Is this a tedit case?" no longer
  applies — the agent calls the appropriate `mcp__tedit__*` tool
  directly. Edge cases (1-line replace) get the same safety net
  (parse verify, backup) as 100-line extracts.
- **Discovery via `mcp__tedit__actions`.** Agents can introspect
  what's possible per file ("this .tsx file supports `rename`,
  `wrap`, `prop.set`, ...") and pick the structural action instead
  of fumbling with strings.
- **Errors come back as native MCP errors**, not as JSON strings
  inside stdout. Cleaner agent error handling.

For the human:

- **Nothing changes.** The CLI is untouched. `tedit edit ...` in
  a shell still works, still emits JSON, still pipes into `jq`.

## Surface tradeoffs vs. CLI (already discussed, summarized here)

| Concern | CLI | MCP |
|---|---|---|
| Universal (any host / human / CI) | ✅ | ❌ (MCP hosts only) |
| Agent call cost | High (Bash round-trip) | **Low (native tool call)** |
| Shell-escape complexity | High for multi-line / Korean / JSX | None (JSON args) |
| Output parsing | Manual | Native |
| Pipe / jq / xargs friendly | ✅ | ❌ |
| Discovery in host tool list | ❌ | ✅ |

Both surfaces are needed; this issue adds the MCP one without
removing the CLI.

## Implementation phases

1. **Skeleton MCP server** — `@modelcontextprotocol/sdk` integration,
   stdio transport, register one tool (`edit`) end-to-end. Verifies
   the wiring.
2. **Bulk tool registration** — map every CLI subcommand
   (`multiedit`, `patch`, `chain`, `chain-workspace`, `rename`,
   `wrap`, `unwrap`, `remove`, `prop.set/remove`, `imports.*`,
   `expr.*`, `text.*`, `extract`, `create`, `scaffold`, `new`,
   `analyze-state`, `refactor-state`, `find`, `inspect`, `actions`)
   to a `mcp__tedit__*` tool with identical param schema.
3. **Discovery tool first-class** — `mcp__tedit__actions` returns
   the same JSON the CLI emits; agents can list "what can this file
   accept" without reading any docs.
4. **`npx tedit-mcp` package** — distribution polish so user config
   is one line.
5. **Docs: "MCP vs CLI: when to use which"** — short page in
   README explaining the parity and the choice. (Mostly: agents use
   MCP, humans use CLI, you don't pick — both are there.)

(1)–(3) are the load-bearing pieces. (4)–(5) are distribution and
docs.

## Out of scope (intentional)

- **HTTP / SSE transport.** stdio is enough for the agent use case.
  HTTP can come later if a hosted scenario emerges.
- **Auth / multi-tenant.** stdio implies local-process trust;
  agents already run in a trusted local context.
- **Replacing the CLI.** The CLI is the universal surface and isn't
  going away. MCP adds, doesn't subtract.
- **Editing semantic changes.** The MCP server is pure transport;
  any behavior change happens in the shared internal core, not in
  the MCP layer.

## Trust contract (per DESIGN-PRINCIPLES)

All four pillars are inherited automatically — the MCP layer doesn't
implement any of them, it just calls the same internal functions:

- **Selector precision** — same selector engine.
- **Byte-cleanness** — same source-range patches.
- **Failure diagnostics** — same structured errors, returned as MCP
  errors instead of stdout JSON.
- **Rollback safety** — same git-aware default + `.tedit.bak`.

The MCP layer's own correctness surface is small: just the param
mapping and the result mapping. Easy to test (golden-file: CLI
output vs. MCP response for the same call).

## Why this is the right next step (vs. continuing CLI polish)

The CLI is at the point where each additional flag is marginal:
quiet output, better stdin handling, more shorthand. All
worthwhile but each is single-digit % adoption impact.

The MCP server is a step-change: **it removes the per-call cost
that currently makes agents skip tedit for small edits**. After
this, the agent's `Edit` → `tedit edit` substitution is literally
the same number of tokens to call, and the safety / git-awareness
/ backup come for free. That's the inflection point where tedit
becomes the default editor in the agent's mind, not "the
specialized tool you reach for when JSX gets gnarly."

The VISION doc's "stream of consciousness stays on the change,
not on the tooling" goal is gated on this. CLI got us 95% of
the way there; MCP closes the last 5%.

## Related

- `VISION.md` — first-class agent affordance is exactly the gap
  this closes.
- `DESIGN-PRINCIPLES.md` — all four pillars inherited via shared
  core, no new surface to worry about.
- `ISSUE-base-rule-universal-edit.md` — the base rule is what
  makes `mcp__tedit__edit` a true `Edit` substitute; without it
  the MCP server would be JSX-only.
- `ISSUE-chain-ergonomics.md` — chain shorthand stays useful when
  humans hand-write chain files; MCP agents will mostly emit the
  structured shape directly.
