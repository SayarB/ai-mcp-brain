# ai-mcp-brain

Scaffolding and MCP tools for a personal **second brain**: an Obsidian markdown vault that Cursor, Claude, and Codex can read and update.

The vault lives outside this repo (default: your Obsidian iCloud “My Brain” folder). This project owns the CLI, prompts, rule injection, and MCP server.

## Quick start

```bash
bun install
cp config.example.toml config.toml   # edit vault_path / inject paths if needed
bun run brain -- init                # create vault folders (idempotent)
bun run brain -- inject --target all # rules + MCP into Cursor / Claude / Codex
```

Restart the agent apps after inject so MCP and rules reload.

Run the MCP server manually (usually spawned by the harness):

```bash
bun run mcp
```

Cursor example: see [`mcp.cursor.example.json`](mcp.cursor.example.json) (inject already merges into `~/.cursor/mcp.json`).

## CLI

| Command | Purpose |
|---------|---------|
| `bun run brain -- init [--path <dir>]` | Create Obsidian vault structure |
| `bun run brain -- inject [--target cursor\|claude\|codex\|all]` | Inject memory policy + wire MCP |
| `bun run brain -- ingest` | *(planned)* Promote `external/` drops into notes |

Env: `BRAIN_VAULT` overrides `vault_path` from config.

## Vault layout

```
My Brain/
  inbox/              # unsorted captures
  external/           # human file drops (ingest later)
  projects/<slug>/    # one git repo → README, decisions, tools, gotchas
  patterns/           # cross-repo approaches
  stack/
    catalog/          # one note per tool/SaaS
    recent.md         # newest-first skills/tools log
  media/              # short talk takeaways
  agents/             # orchestrator / agent learnings
  _meta/              # schema, projects-index
  AGENTS.md
```

**Project = one git repository.** Slug defaults to the git root folder name; overrides go in `_meta/projects-index.md`.

## MCP tools (`ai-mcp-brain`)

| Tool | Purpose |
|------|---------|
| `search_notes` | Keyword search |
| `read_note` | Read by relative path |
| `remember` | Write note (`scope`: `global` \| `project`) |
| `get_project_context` | Ensure + load a git-repo project pack |
| `list_recent` | Recent tools/skills |
| `track_tool` | Upsert catalog + prepend recent |

## Memory policy (short)

- Read before inventing vault facts (`search` / `get_project_context`).
- Write durable decisions, preferences, gotchas, tools you use or try.
- Do **not** write secrets or ephemeral debug.
- Repo-only facts → `projects/<slug>/`. Tools/SaaS → `stack/catalog/` + `recent`.
- **If global vs project is unclear, ask** before writing.

Full draft: [`templates/prompts/agent-memory.md`](templates/prompts/agent-memory.md)  
Injected slim copy: [`templates/prompts/memory-policy.md`](templates/prompts/memory-policy.md)

## Repo map

```
src/cli.ts              # brain CLI
src/config.ts           # config.toml + BRAIN_VAULT
src/init.ts             # vault scaffolding
src/inject.ts           # harness injection
src/vault.ts            # note IO helpers
src/mcp/server.ts       # stdio MCP server
templates/vault/        # Obsidian seed tree
templates/prompts/      # agent memory prompts
templates/rules/        # Cursor / Claude / Codex snippets
config.example.toml
plans/                  # design notes
PLAN.md                 # living roadmap
```

## Later

- `brain ingest` for `external/`
- Embeddings / richer retrieval
- Auto-watch on `external/`

## License

Private / personal use unless otherwise stated.
