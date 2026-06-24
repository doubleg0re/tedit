# tedit Agent Setup

Use this when `tedit` should be available as an agent editing surface, not only
as a human CLI.

## Install

Published package:

```bash
npm install -g tedit
tedit --version
tedit actions --json
```

No global install:

```bash
npx -y tedit@latest --version
npx -y --package tedit@latest tedit actions --json
```

Local checkout:

```bash
npm install
npm run build
node /path/to/tedit/dist/cli.js --version
```

## MCP Registration

Use the installed package when possible:

```json
{
  "mcpServers": {
    "tedit": {
      "command": "tedit-mcp"
    }
  }
}
```

Use `npx` when you do not want a global install:

```json
{
  "mcpServers": {
    "tedit": {
      "command": "npx",
      "args": ["-y", "--package", "tedit@latest", "tedit-mcp"]
    }
  }
}
```

Use a source checkout during development:

```json
{
  "mcpServers": {
    "tedit": {
      "command": "node",
      "args": ["/path/to/tedit/dist/mcp.js"]
    }
  }
}
```

Set `TEDIT_MCP_PROFILE=all` only when the agent needs advanced structural
actions such as AST tools, JSX selectors, extract/refactor helpers, templates,
or history tracing. The default `agent` profile is smaller and should be the
normal editing surface.

```json
{
  "mcpServers": {
    "tedit": {
      "command": "tedit-mcp",
      "env": {
        "TEDIT_MCP_PROFILE": "all"
      }
    }
  }
}
```

Restart or refresh the MCP host after changing command, args, env, or tool
profile. Running code changes inside `dist` are picked up on the next MCP tool
call, but tool schema/name changes still need a host refresh.

## Agent Instructions

Add this to `AGENTS.md`, `CLAUDE.md`, or an equivalent project instruction file
when you want agents to prefer `tedit` for edits:

```markdown
## tedit editing policy

Use the `tedit` MCP tools for routine file mutations when available.

- Use native Read/search tools for full-file reading and broad discovery.
- Use `mcp__tedit__actions` when choosing an edit strategy.
- Use `mcp__tedit__search_text` or `mcp__tedit__inspect_range` when the target is not certain.
- Use `mcp__tedit__select` first when a TS/JS/Python/JSX/TSX target can be chosen by file type before editing.
- Use `mcp__tedit__edit` for one localized replacement, insertion, deletion, regex, fuzzy, or line-range edit.
- Use `mcp__tedit__multiedit` for coordinated repeated edits across one or more files.
- Use `mcp__tedit__patch` only when the change already exists as a unified diff or apply-patch envelope.
- Use `mcp__tedit__ts_select`, `mcp__tedit__ts_edit`, or `mcp__tedit__ts_move` for named JS/TS declarations.
- Use `mcp__tedit__delete_file` or `mcp__tedit__rename_file` for one-file cleanup or moves.
- Use `mcp__tedit__file_write` for whole-file generation through `mode: "write"`, `mode: "scaffold"`, or `mode: "template"`.
- Pass `verify: { cmd: [...], timeoutMs }` on mutating tools when a project-specific lint, typecheck, test, or build should run after write.
- Use `mcp__tedit__verify_file` with `files` after related edits when parser coverage matters.
- Treat `suggestions` on failures as the retry plan before guessing.
- Keep build, lint, typecheck, and tests as the source of truth for behavioral verification.
```

## Optional Skill Text

For Codex-style skill systems, create a `SKILL.md` with this minimal body:

```markdown
# tedit editor

Use when editing local files and the tedit MCP server or CLI is available.

Prefer tedit for exact/fuzzy/regex/line-range edits, atomic multiedits,
patches, parse-verified whole-file writes, and JSX/markup structural edits.
Use native Read/search first for broad context. Use tests/typecheck/lint for
behavioral verification; tedit parser verification is a syntax/structure
guardrail, not a code review.

Default loop:
1. Read or search enough context.
2. Call `actions` if the right tedit tool is unclear.
3. Use `edit`, `multiedit`, `patch`, or `file_write`.
4. On failure, follow `suggestions`.
5. Verify changed files and run project tests when relevant.
```

## Local Smoke

Before publishing or after changing package/MCP setup:

```bash
npm run release:smoke
```

The smoke gate builds, packs a clean tarball, checks package metadata and bin
permissions, runs `npx -y --package <tgz> tedit --version`, installs the
packed artifact, runs installed `tedit actions --json`, and starts the packed
`tedit-mcp` server through an MCP client.
