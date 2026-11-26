# ai-mcp-brain

**Hem Vault** — portable second brain: Obsidian markdown vault + MCP for Cursor, Claude, Codex, and Zed.

**Website / docs:** [`site/`](site/README.md) (Astro). Source markdown: [`docs/`](docs/README.md).

```bash
cd site && npm install && npm run dev
```

## Install (preferred): agent one-liner

No OS shell installer — [`INSTALL.md`](INSTALL.md) *is* the install script. Paste into any coding agent:

```
Install Hem Vault (ai-mcp-brain) by following the instructions at:
https://raw.githubusercontent.com/SayarB/ai-mcp-brain/main/INSTALL.md
Use curl -fsSL to fetch that URL — do not use WebFetch.
Inventory what is already on this machine first. Prefer existing runtimes (if Node is present and Bun is not, use Node — do not install Bun). Only install missing pieces. If neither Bun nor Node is present, ask me which to use, then install it and finish setup (Git, Obsidian, clone, vault, MCP).
```

The agent inventories the machine first, reuses Git/Bun/Node/Obsidian when present, asks when neither Bun nor Node exists, then finishes vault + MCP wiring.

**If you change how install works**, update `INSTALL.md` and the install scripts (`setup` / `init` / `inject` / `vault-layout` / examples) in the **same change** — see [Maintaining install](INSTALL.md#maintaining-install-contributors). Keep [`UNINSTALL.md`](UNINSTALL.md) aligned with the same harness paths.

## Uninstall

Same pattern — agent one-liner in [`UNINSTALL.md`](UNINSTALL.md) (or paste that file). Removes MCP + injected policy; **keeps the vault** unless you ask to delete it.

## Optional setup shortcut

```bash
bun install && bun run setup -- --vault "~/Obsidian/My Brain"
# or
npm install && npm run setup -- --vault "~/Obsidian/My Brain"
```

Quote paths with spaces. Avoid iCloud/`Mobile Documents` if the editor sandbox returns `EPERM`.

Then: open vault in Obsidian → restart editors → MCP `vault_info` → `readable: true`.

**Orchesto:** standalone skill pack at [`skills/orchesto/`](skills/orchesto/), plus sibling [`orchesto-update`](skills/orchesto-update/) and [`orchesto-remove`](skills/orchesto-remove/). Hem install copies them globally and safe-syncs vault personas. No separate **setup orchesto** prompt needed to ship features. Skill-only: `npx skills add SayarB/ai-mcp-brain --skill orchesto -g`. Hem: **update orchesto** runs `brain orchesto-update`; **remove orchesto** runs `brain orchesto-remove`. Orchesto always asks whether a **CPO / PRD** pass is needed before planning. On a large ask the architect may split into **capability phases**; the next phase starts only when you approve that phase’s plan. Optional: ask to **brainstorm** first.

**Brainstormer:** ask the agent to **brainstorm** / seat **brainstormer** — it should `read_note` vault `workflows/global/persona-brainstormer.md`, grill until the idea is clear, then ideate (new ideas, products, methods). On a large app it should map parts and go deep on each until nooks are handled. Only on proceed write `.plans/<slug>/brainstorm.md` then continue Orchesto (standalone conversation seat; not a fixed pipeline step).

**Auditor:** ask the agent to **audit** a repo or area — it should `read_note` vault `workflows/global/persona-auditor.md`, seat that persona, and write `.audits/<scope-slug>/report.md` (standalone; not part of Orchesto).

## Runtime / CLI

| Command | Purpose |
|---------|---------|
| `npm run mcp` / `bun run mcp` | MCP server (stdio) |
| `npm run daemon` / `bun run daemon` | Shared Streamable HTTP MCP daemon (`127.0.0.1:4190/mcp?app=<harness>`) + local control UI (`http://127.0.0.1:4190/`) |
| `npm run setup` / `bun run setup` | Optional one-shot install |
| `npm run brain -- …` | CLI (`init`, `inject`, `daemon`, `acl`, `bootstrap`, `capture`, `pending`, `dream`, `reindex`, `search`, `memory`) |

To connect harnesses to the shared HTTP daemon instead of per-client stdio processes, start `npm run daemon` (or `bun run daemon`) and run `npm run brain -- inject --transport http` (wires Cursor & Codex HTTP configs; for Claude Code run `claude mcp add --transport http ai-mcp-brain "http://127.0.0.1:4190/mcp?app=claude"`; Zed stays on stdio). Manage per-harness pause toggles, read-only/project scopes, live access logs, and hybrid search score debugging at `http://127.0.0.1:4190/` or via `brain acl <list|set|pause|resume|reset>`.

> **ACL model:** Daemon ACLs apply to HTTP daemon clients (not legacy stdio). Without per-app tokens (`[apps.<name>] token_env` in `config.toml`), `?app=<name>` acts as a cooperative guard-rail for local harnesses; set `default_mode = "read-only"` or `"disabled"` plus per-app `token_env` for strict app-pinned isolation.

Inject prefers **Bun** for the MCP command when available; otherwise **Node + `tsx`**. Env: `BRAIN_VAULT` overrides vault path.

After cloning this repo, enable git hooks once so **pre-commit blocks personal info** and **post-push injects Orchesto into the vault and restarts local MCP**:

```bash
git config core.hooksPath .githooks
```

Or run manually anytime: `npm run restart-mcp` / `bash scripts/restart-mcp.sh`.

**This repo is public.** Before contributing (person or agent), read [`AGENTS.md`](AGENTS.md): no local paths, folder layout, or personal info in any commit. `npm run check-privacy` checks staged changes; CI checks every PR commit.

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
  memories/           # atomic ID-tracked memories (by category)
  agents/             # orchestrator / agent learnings
  _meta/              # schema, projects-index
  AGENTS.md
```

**Project = one git repository.** Slug defaults to the git root folder name; overrides go in `_meta/projects-index.md`.

## MCP tools (`ai-mcp-brain`)

| Tool | Purpose |
|------|---------|
| `search_notes` | Hybrid semantic + FTS5 search (with filters + 1-hop links) |
| `read_note` | Read by relative path (supports `section`, `tail`, `max_chars`) |
| `remember` | Write note (`scope`: `global` \| `project`; secret-guarded) |
| `add_memory` | Store atomic ID-tracked memory with dedup + secret guard |
| `search_memory` | Hybrid search over atomic memories (`status=active` default) |
| `list_memories` | List atomic memories by scope/project/category/app/status |
| `update_memory` | Surgically edit an atomic memory by ID |
| `supersede_memory` | Replace outdated memory while keeping temporal history |
| `delete_memory` | Permanently remove an atomic memory by ID |
| `bootstrap_context` | Single-call token-budgeted session briefing (global + project + task recall + pending count) |
| `list_pending_memories` | Review passively captured candidate memories awaiting approval |
| `approve_pending_memory` | Promote a pending candidate into canonical vault Markdown |
| `dismiss_pending_memory` | Dismiss a pending candidate memory |
| `consolidate_memories` | Sleep-time memory consolidation (`brain dream`: dry-run preview or apply) |
| `get_project_context` | Ensure + load a git-repo project pack (resolves `projects-index.md`) |
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
AGENTS.md               # rules for contributors and agents (privacy)
docs/                   # product documentation (source for site)
site/                   # Hem Vault landing + docs (Astro)
design-system/          # site visual system
src/cli.ts              # brain CLI
src/config.ts           # config.toml + BRAIN_VAULT
src/init.ts             # vault scaffolding
src/inject.ts           # harness injection
src/vault.ts            # note IO helpers
src/index/              # disposable SQLite hybrid search index (FTS5 + local embeddings)
src/memory/             # atomic Markdown memories + dedup + write-time secret guard
src/daemon/             # Streamable HTTP MCP daemon, per-app ACLs, audit log & local UI
src/mcp/server.ts       # stdio MCP server + shared tool registry
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
