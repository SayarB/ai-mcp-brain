# ai-mcp-brain

Portable second brain: Obsidian markdown vault + MCP for Cursor, Claude, Codex, and Zed.

## Install (preferred): agent prompt

Paste [`INSTALL.md`](INSTALL.md) into any agent. It installs by copying `templates/vault/` and writing harness MCP/rules — **no OS-specific install scripts required**.

You need a JS runtime so the MCP server can run: **Bun (preferred)** or **Node.js 20+** (MCP launches via local `tsx`). See [`INSTALL.md`](INSTALL.md).

**If you change how install works**, update `INSTALL.md` and the install scripts (`setup` / `init` / `inject` / `vault-layout` / examples) in the **same change** — see [Maintaining install](INSTALL.md#maintaining-install-contributors). Keep [`UNINSTALL.md`](UNINSTALL.md) aligned with the same harness paths.

## Uninstall

Paste [`UNINSTALL.md`](UNINSTALL.md) into any agent (or follow its checklist). Removes MCP + injected policy from harnesses; **keeps the vault** unless you explicitly ask to delete it.

## Optional setup shortcut

```bash
bun install && bun run setup -- --vault "~/Obsidian/My Brain"
# or
npm install && npm run setup -- --vault "~/Obsidian/My Brain"
```

Quote paths with spaces. Avoid iCloud/`Mobile Documents` if the editor sandbox returns `EPERM`.

Then: open vault in Obsidian → restart editors → MCP `vault_info` → `readable: true`.

**Orchesto:** in any product repo, ask the agent to **setup orchesto** — it should `read_note` vault `workflows/global/setup-orchesto.md`. See also [`templates/skills/orchesto/`](templates/skills/orchesto/).

## Runtime / CLI

| Command | Purpose |
|---------|---------|
| `npm run mcp` / `bun run mcp` | MCP server |
| `npm run setup` / `bun run setup` | Optional one-shot install |
| `npm run brain -- …` | Optional advanced init/inject |

Inject prefers **Bun** for the MCP command when available; otherwise **Node + `tsx`**. Env: `BRAIN_VAULT` overrides vault path.

After cloning this repo, enable git hooks once so **post-push restarts local MCP**:

```bash
git config core.hooksPath .githooks
```

Or run manually anytime: `npm run restart-mcp` / `bash scripts/restart-mcp.sh`.

## Vault layout

```
My Brain/
  inbox/              # unsorted captures
  external/           # human file drops (ingest later)
  projects/<slug>/    # one git repo → README, decisions, tools, gotchas
  instructions/       # binding process rules
  suggestions/        # soft prefs (prefer / lean)
  workflows/          # playbooks
  actions/            # action → guidance registry
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
| `track_tool` | Catalog SaaS/tool + prepend recent |
| `vault_info` | Diagnostics: path, readable?, note count |
| `resolve_guidance` | Look up instructions / soft suggestions / workflows |
| `list_guidance` | List instruction kinds, suggestion kinds, workflow ids |
| `upsert_guidance` | Create/append/section-edit guidance; `mode=replace` rewrites the whole note |
| `resolve_action` | Action registry → expand instructions + soft suggestions (+ workflows) |
| `list_actions` | List action ids from `actions/registry.md` |

### Instructions, suggestions, and workflows

Standing guidance lives in the vault:

- `actions/registry.md` — action trigger map (extend here; no repo change)
- `instructions/global/<kind>.md` — **binding** process (explicit hard rules only)
- `suggestions/global/<kind>.md` — **soft** prefs (auto-logged standing defaults)
- `workflows/global/<id>.md` — multi-step playbooks
- Project overlays: `projects/<slug>/instructions|suggestions|workflows|actions/`

Agents should call **`resolve_action`** at mode start (not every turn). Project precedes global. Soft suggestions = prefer, not must. Binding instructions stay empty until you mean hard rules.

After wiring MCP: **restart** editors and call `vault_info` → `readable: true`.

## Memory policy (short)

- Read before inventing vault facts; **resolve_action** / **resolve_guidance** before inventing process.
- Soft standing prefs → `suggestions/` (auto-log). Binding process → `instructions/` only for hard rules.
- Write durable decisions, gotchas, tools you use or try.
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
