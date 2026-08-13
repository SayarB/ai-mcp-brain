# Uninstall Hem Vault (ai-mcp-brain)

Agent-first uninstall. Paste the one-liner into any coding agent; it fetches this file with `curl` and walks every step.

> **For LLM agents: use `curl`, NOT WebFetch / browser fetch.** Always:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/SayarB/ai-mcp-brain/main/UNINSTALL.md
> ```

This removes harness wiring (MCP + injected memory policy). It does **not** delete the Obsidian vault unless the user explicitly asks.

---

## For humans

### One-liner (paste into any agent)

```
Uninstall Hem Vault (ai-mcp-brain) harness wiring by following:
https://raw.githubusercontent.com/SayarB/ai-mcp-brain/main/UNINSTALL.md
Use curl -fsSL to fetch that URL — do not use WebFetch. Keep my vault unless I say to delete it.
```

### Already in the repo?

Paste the Prompt section below, or say: `Follow UNINSTALL.md in this repo.`

Re-install later: [`INSTALL.md`](INSTALL.md).

---

## Prompt

Uninstall my second-brain harness wiring for `ai-mcp-brain` on this machine. Leave my markdown vault alone unless I explicitly say to delete it.

### Goals

1. Remove `ai-mcp-brain` from Cursor / Claude / Codex / Zed MCP (or context server) configs.
2. Remove injected second-brain policy blocks and Cursor rule files this install wrote.
3. Optionally remove the global **Orchesto** skill dirs this install wrote (ask first).
4. Stop any running `ai-mcp-brain` MCP processes.
5. Optionally clean repo-local install artifacts (`config.toml`, project `.cursor/mcp.json`).
6. **Never** delete the vault or Obsidian notes unless I clearly ask.

### Prerequisites

- Working directory = this repo root (or know absolute paths to the repo + vault).
- Ask me for the vault path if unknown (common: `~/Obsidian/My Brain`). Default: **keep the vault**.
- Quote paths that contain spaces.

### Steps

#### A. Stop running MCP servers

From the repo (if present):

```bash
bash scripts/restart-mcp.sh
# or
npm run restart-mcp
```

That kills processes matching `<repo>/src/mcp/server.ts`. If the script is missing, find and kill those PIDs another way. Editors may show MCP disconnected until reload — that is expected during uninstall.

#### B. Cursor

1. Edit `~/.cursor/mcp.json`: delete the `mcpServers["ai-mcp-brain"]` entry (preserve other servers). If the file becomes empty of servers, leave `{"mcpServers":{}}` or remove the file only if nothing else remains.
2. Delete `~/.cursor/rules/second-brain.mdc` if it exists.
3. If `<repo>/.cursor/mcp.json` exists and only existed for this brain (or only contains `ai-mcp-brain`), remove that server entry or the file.

#### C. Claude

Edit `~/.claude/CLAUDE.md`: remove the marked block between `<!-- second-brain:start -->` and `<!-- second-brain:end -->` (inclusive), leaving any user content outside the markers.

#### D. Codex

1. Edit `~/.codex/AGENTS.md`: remove the same `<!-- second-brain:start -->` … `<!-- second-brain:end -->` block.
2. Edit `~/.codex/config.toml`: remove the marked block between `# --- ai-mcp-brain MCP server ---` and `# --- end ai-mcp-brain MCP server ---` (inclusive).

#### E. Zed

1. Edit `~/.config/zed/settings.json` (Windows: `%APPDATA%\Zed\settings.json`): remove `context_servers["ai-mcp-brain"]` without destroying other servers or JSONC comments.
2. Edit `~/.config/zed/AGENTS.md` (Windows: `%APPDATA%\Zed\AGENTS.md`): remove the `<!-- second-brain:start -->` … `<!-- second-brain:end -->` block.

Skip any harness the user does not use or whose paths do not exist.

#### F. Orchesto global skill (optional — ask first)

Hem Vault install also wrote the Orchesto skill globally. Only remove if I want Orchesto gone with the brain:

- Delete `~/.cursor/skills/orchesto/` (or just `SKILL.md`) if present
- Delete `~/.agents/skills/orchesto/` if present
- Delete `~/.claude/skills/orchesto/` if present

Do **not** delete project-local `.agents/skills/orchesto` / `.cursor/skills/orchesto` in unrelated product repos unless I ask.

#### G. Repo-local artifacts (optional — ask first)

Only if I want a clean clone state:

- Delete repo `config.toml` (gitignored; holds `vault_path`).
- Leave `node_modules/` unless I ask to remove dependencies.
- Do **not** remove `.githooks/` or `scripts/restart-mcp.sh` from the repo itself — those are part of the project source, not machine install state.

#### H. Vault (optional — ask first, default keep)

- **Default:** keep the vault folder (notes, suggestions, projects, etc.).
- **Only if I say so:** delete or archive the vault directory. Confirm the absolute path before deleting.

#### I. Verify

- No `ai-mcp-brain` entry in Cursor/Codex/Zed MCP configs.
- No `second-brain.mdc` under `~/.cursor/rules/`.
- Marked second-brain blocks gone from Claude/Codex/Zed agent files.
- If I asked to remove Orchesto: global `*/skills/orchesto/` dirs gone.
- `pgrep -f 'ai-mcp-brain/src/mcp/server.ts'` (or equivalent) returns nothing.
- Tell me to restart/reload editors so they drop stale MCP clients.

### Done criteria

Report: which harnesses were cleaned, whether the vault was kept or deleted, and that MCP processes were stopped.

---

## Human checklist (same steps)

| Item | Location |
|------|----------|
| Stop MCP | `npm run restart-mcp` / `bash scripts/restart-mcp.sh` |
| Cursor MCP | `~/.cursor/mcp.json` → remove `ai-mcp-brain` |
| Cursor rule | delete `~/.cursor/rules/second-brain.mdc` |
| Project MCP | `<repo>/.cursor/mcp.json` → remove server or file |
| Claude | `~/.claude/CLAUDE.md` → strip `<!-- second-brain:* -->` block |
| Codex agents | `~/.codex/AGENTS.md` → strip marked block |
| Codex MCP | `~/.codex/config.toml` → strip `# --- ai-mcp-brain MCP server ---` … end marker |
| Zed MCP | `context_servers.ai-mcp-brain` in Zed `settings.json` |
| Zed agents | Zed `AGENTS.md` → strip marked block |
| Orchesto skill (optional) | `~/.cursor/skills/orchesto/`, `~/.agents/skills/orchesto/`, `~/.claude/skills/orchesto/` |
| Vault | keep by default |

Re-install later: [`INSTALL.md`](INSTALL.md).
