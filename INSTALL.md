# Agent install prompt — ai-mcp-brain (prompt-first)

Paste everything under **Prompt** into any coding agent on macOS, Linux, or Windows.

No install shell scripts are required. Runtime: **Bun (preferred)** or **Node.js 20+** (via local `tsx`).

---

## Prompt

Install my second-brain from the `ai-mcp-brain` repo into a vault path I choose, and wire MCP + memory policy into the coding harnesses I use.

### Goals

1. Create an Obsidian-compatible markdown vault from `templates/vault/` (idempotent: do not overwrite existing notes).
2. Point MCP at that vault via `BRAIN_VAULT`.
3. Inject a short memory policy into Cursor / Claude / Codex / Zed **if those config locations exist**.
4. Leave `instructions/global/*.md` bodies empty (titles/frontmatter only) unless I already filled them.
5. Do not invent process/instruction content.

### Prerequisites

- Working directory = this repo root.
- A JS runtime to run the MCP server:
  - **Bun preferred**: `bun --version`. Install from https://bun.sh if missing
    (macOS/Linux: `curl -fsSL https://bun.sh/install | bash`; Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`).
  - **Or Node.js 20+**: `node --version`. After `npm install` / `bun install`, MCP runs via `tsx` (already a repo dependency).
- Vault path: ask me if unknown. Default suggestion: `~/Obsidian/My Brain` (or `%USERPROFILE%\Obsidian\My Brain` on Windows).
- **Avoid** vaults under iCloud/`Mobile Documents` or other sandboxed cloud folders if the editor blocks them (`EPERM`). Prefer a normal home directory path.
- Quote paths that contain spaces.

### Steps

#### A. Runtime + dependencies

1. Confirm `bun --version` **or** `node --version`.
2. In the repo:

```bash
# either
bun install
# or
npm install
```

#### B. Create vault from templates

Resolve vault to an absolute path (expand `~` / `%USERPROFILE%`).

Copy everything under `templates/vault/` into the vault root:

- Create missing directories and files.
- **Never overwrite** a file that already exists.
- Ensure dirs exist: `inbox`, `external`, `projects`, `patterns`, `stack/catalog`, `media`, `agents`, `instructions/global`, `workflows/global`, `actions`, `_meta`.

#### C. Local config (optional but useful)

Write repo `config.toml` (gitignored) with:

```toml
vault_path = "<absolute-or-~/vault-path>"
```

#### D. MCP server entry (all harnesses)

Prefer Bun when available; otherwise Node + local `tsx`. Absolute paths:

**If Bun:**

- command: absolute `bun` (PATH or `~/.bun/bin/bun` / `bun.exe`)
- args: `[ "<repo>/src/mcp/server.ts" ]`

**If Node only:**

- command: absolute `node`
- args: `[ "<repo>/node_modules/tsx/dist/cli.mjs", "<repo>/src/mcp/server.ts" ]`

Common for both:

- cwd: `<repo>`
- env: `{ "BRAIN_VAULT": "<absolute-vault-path>" }`

(Or run `npm run setup` / `bun run setup`, which picks Bun vs Node automatically.)

#### E. Wire harnesses (only if the path exists or can be created)

**Cursor**

- Merge into `~/.cursor/mcp.json` under `mcpServers.ai-mcp-brain` (preserve other servers).
- Also write `<repo>/.cursor/mcp.json` the same way (optional project config).
- Write `~/.cursor/rules/second-brain.mdc` with frontmatter `alwaysApply: true` and the contents of `templates/prompts/memory-policy.md` after replacing `{{VAULT_PATH}}` with the absolute vault path (ignore other `{{…}}` placeholders or replace with repo path / MCP script path if present).

**Claude**

- Upsert a marked block in `~/.claude/CLAUDE.md` between `<!-- second-brain:start -->` and `<!-- second-brain:end -->` using the same rendered memory-policy text.

**Codex**

- Upsert the same marked block in `~/.codex/AGENTS.md`.
- In `~/.codex/config.toml`, upsert the MCP block with the same command/args/cwd/env as section D.

**Zed**

- macOS/Linux: `~/.config/zed/settings.json` and `~/.config/zed/AGENTS.md`
- Windows: `%APPDATA%\Zed\settings.json` and `%APPDATA%\Zed\AGENTS.md`
- In settings JSON/JSONC, set `context_servers.ai-mcp-brain` to `{ "enabled": true, "command": "<runtime>", "args": [...], "env": { "BRAIN_VAULT": "<absolute-vault>" } }` without destroying unrelated keys/comments.
- Upsert the marked policy block into Zed `AGENTS.md`.

Skip any harness the user does not use.

#### F. Verify

- List vault top-level folders.
- Confirm `actions/registry.md` and empty-ish `instructions/global/{coding,pr-review,commit,git}.md` exist.
- Tell me to restart editors and run MCP tool `vault_info` → expect `readable: true`.

### Policy reminders to leave in place

- `resolve_action` on **mode start only** (not every turn).
- Project guidance precedes global.
- Do not fill empty instructions unless I explicitly ask.

### Done criteria

Report: vault path, which harnesses were wired, and that MCP uses `BRAIN_VAULT`.

---

## Optional shortcut (same repo)

```bash
bun install && bun run setup -- --vault "~/Obsidian/My Brain"
# or
npm install && npm run setup -- --vault "~/Obsidian/My Brain"
```

(Use quotes when the path has spaces.) Prefer the prompt steps above when setup scripts are unavailable or undesirable.
