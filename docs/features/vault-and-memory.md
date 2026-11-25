# Feature: Vault & memory

## Overview

The vault is the durable second brain: Obsidian markdown that you and your coding agents share. MCP tools let agents search, load a git-repo project pack, and append facts without inventing “what we usually do.”

Use it when work should survive chat sessions — decisions, gotchas, project context, corrected misconceptions. Do not park secrets, ephemeral debug, or one-off chatter here.

## How it works

On install, `templates/vault/` is copied into your chosen vault path (idempotent: existing notes are not overwritten). The MCP server resolves the vault via `BRAIN_VAULT` / `config.toml` and only reads or writes paths inside that root.

Search uses a **disposable local SQLite hybrid index** (`FTS5 BM25` with Porter stemming + local ONNX embeddings + `[[wikilink]]` 1-hop graph links), stored outside the vault in `~/.cache/ai-mcp-brain/` and incrementally synced by `mtime` + `sha256`. Markdown remains the sole source of truth — deleting the cache rebuilds it cleanly (or run `npm run brain -- reindex --force`). Set `BRAIN_EMBED=off` for FTS5-only mode. Project packs are created from `projects/_template/` on first `get_project_context` or project-scoped `remember`.

Memory policy (injected into harnesses) tells agents to:

1. Read / search before inventing vault facts  
2. Ask when global vs project scope is unclear  
3. Write only durable knowledge — never secrets  

## Capabilities

- Durable Obsidian-ready vault shared by humans and agents  
- Project packs keyed to one git repository each  
- Hybrid semantic + FTS5 search with ranked paths, headings, snippets, filters, and 1-hop wikilinks  
- Read a note by relative path  
- Append durable notes globally or into a project pack  
- Load project context in one call  
- Diagnostics via `vault_info`  

## How to use

**Start of non-trivial work**

1. Resolve the git root folder name as the project slug  
2. Call `get_project_context`  
3. `search_notes` for relevant keywords  
4. Answer from vault facts; if nothing found, say so  

**Capture a decision**

> Remember that we use Bun for MCP launch in this brain repo.

Agent asks if scope is unclear, then `remember` with `scope=project`, `project=<slug>`, usually `projectFile=decisions`.

**Park unsorted**

> Park this for later.

→ `remember` with `scope=global`, `folder=inbox`.

**Search before inventing**

> What did we decide about auth?

→ `search_notes` → `read_note` on hits → quote the vault; never fabricate.

**Health check**

> Is the vault readable?

→ `vault_info` → expect `readable: true`.

## Choosing the right write tool

| What you are storing | Tool | Where it lands |
|----------------------|------|----------------|
| Standing soft/hard **process** rules for actions (coding, commit, PR review, git) | `upsert_guidance` | `suggestions/` or `instructions/` |
| **Atomic, ID-tracked facts** (profile, non-action preferences, evolvable decisions/gotchas that may be superseded) | `add_memory` / `supersede_memory` | `memories/<category>.md` or `projects/<slug>/memories.md` |
| **Long-form notes** (project pack prose, cross-repo patterns, inbox captures) | `remember` | `projects/<slug>/`, `patterns/`, `inbox/` |
| **Tools / SaaS** | `track_tool` | `stack/catalog/` + `stack/recent.md` |

## Edge cases

- Prefer a normal home path for the vault; iCloud / sandboxed cloud folders can yield `EPERM`  
- Project ≠ company or product brand — one folder per **git repo**  
- `_meta/projects-index.md` is auto-resolved by MCP for paths and remote URLs
- Write-time secret guard blocks private keys, API tokens, JWTs, and credentialed URLs across `remember`, `upsert_guidance`, `track_tool`, and `*_memory` tools  
- Hybrid search skips `.obsidian`, `.git`, `node_modules`, `_template`; supports filters (`project`, `scope`, `type`, `tags`, `updated_after`) and `mode=hybrid|fts|vector`  
- Prefer append / update over duplicate notes  
- Soft prefs and binding process use the [guidance system](guidance.md), not `remember`  

## Related

- [How it works](../how-it-works.md)  
- [Daily memory guide](../guides/daily-memory.md)  
- [MCP tools](../reference/mcp-tools.md)  
- [INSTALL.md](../../INSTALL.md)  
