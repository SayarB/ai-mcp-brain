# Agent install prompt — ai-mcp-brain (prompt-first)

Paste everything under **Prompt** into any coding agent on macOS, Linux, or Windows.

No install shell scripts are required. Runtime: **Bun (preferred)** or **Node.js 20+** (via local `tsx`).

**Maintainer rule:** any change that affects how this system is installed on a new device must update **this file** and the install path in code (`src/setup.ts`, `src/init.ts`, `src/inject.ts`, `src/runtime.ts`, `src/vault-layout.ts`, `package.json` scripts) in the **same change**. See [Maintaining install](#maintaining-install-contributors).

---

## Prompt

Install my second-brain from the `ai-mcp-brain` repo into a vault path I choose, and wire MCP + memory policy into the coding harnesses I use.

### Goals

1. Create an Obsidian-compatible markdown vault from `templates/vault/` (idempotent: do not overwrite existing notes).
2. Point MCP at that vault via `BRAIN_VAULT`.
3. Inject a short memory policy into Cursor / Claude / Codex / Zed **if those config locations exist**.
4. Leave `instructions/global/*.md` bodies empty unless I mean binding process. Soft prefs go to `suggestions/`.
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
- Ensure dirs exist (must match `REQUIRED_VAULT_DIRS` in `src/vault-layout.ts`):
  `inbox`, `external`, `projects`, `patterns`, `stack`, `stack/catalog`, `media`, `agents`, `instructions`, `instructions/global`, `suggestions`, `suggestions/global`, `workflows`, `workflows/global`, `actions`, `_meta`.

Prefer the scripted path when available:

```bash
npm run setup -- --vault "<vault-path>"
# or
bun run setup -- --vault "<vault-path>"
```

That runs vault init + harness inject and writes `config.toml`.

#### C. Local config (optional but useful)

Write repo `config.toml` (gitignored) with:

```toml
vault_path = "<absolute-or-~/vault-path>"
```

See `config.example.toml`.

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

(Or run `npm run setup` / `bun run setup`, which picks Bun vs Node automatically via `resolveMcpLaunch` in `src/runtime.ts`.)

Example shape: `mcp.cursor.example.json` (placeholders only — never commit machine-specific absolute paths as the canonical example).

#### E. Wire harnesses (only if the path exists or can be created)

Policy text comes from `templates/prompts/memory-policy.md` with `{{VAULT_PATH}}` (and other placeholders) replaced. Injected slim policy must mention: `resolve_action` mode-start, reuse bundle already in this chat for the same action (no repeat MCP call), soft suggestions auto-log, binding instructions explicit-only.

**Cursor**

- Merge into `~/.cursor/mcp.json` under `mcpServers.ai-mcp-brain` (preserve other servers).
- Also write `<repo>/.cursor/mcp.json` the same way (optional project config).
- Write `~/.cursor/rules/second-brain.mdc` with frontmatter `alwaysApply: true` and the rendered memory-policy text.

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

- List vault top-level folders (include `suggestions/`, `instructions/`, `actions/`, `workflows/`).
- Confirm `actions/registry.md` exists.
- Confirm empty-ish shells for kinds `coding`, `pr-review`, `commit`, `git` under both:
  - `instructions/global/<kind>.md`
  - `suggestions/global/<kind>.md`
- Confirm MCP config uses absolute paths + `BRAIN_VAULT`.
- Tell me to restart editors and run MCP tool `vault_info` → expect `readable: true`.
- Optional: `resolve_action` with `action=coding` should return instructions + a soft-suggestions section (bodies may be empty on a fresh install).

### Policy reminders to leave in place

- `resolve_action` on **mode start only** (not every turn). Reuse an earlier same-action bundle already in this chat; re-resolve only on mode switch / reload / missing bundle.
- Project guidance precedes global.
- Soft standing prefs → `upsert_guidance` `type=suggestion` (no magic words).
- Do not fill binding instructions unless I explicitly ask for hard rules.
- When asked to **setup orchesto**: `read_note` `workflows/global/setup-orchesto.md` (do not web-search; Orchesto ≠ Orca).

### Done criteria

Report: vault path, which harnesses were wired, Bun vs Node MCP launch, and that MCP uses `BRAIN_VAULT`.

---

## Setup orchesto (any product repo)

After the second brain is installed, in **any** git repo the user can say **setup orchesto**. The agent should **`read_note` `workflows/global/setup-orchesto.md`** in the vault and follow it (personas + project skill + `.plans/`). Source templates also live under `templates/vault/workflows/global/` in this repo for vault init.

Canonical skill text for contributors: [`templates/skills/orchesto/`](templates/skills/orchesto/) (kept in sync with vault `orchesto-skill-template.md`).

---

## Optional shortcut (same repo)

```bash
bun install && bun run setup -- --vault "~/Obsidian/My Brain"
# or
npm install && npm run setup -- --vault "~/Obsidian/My Brain"
```

(Use quotes when the path has spaces.) Prefer the prompt steps above when setup scripts are unavailable or undesirable.

---

## Maintaining install (contributors)

When you change **how install works** on a new machine, update **all** of the following in the same PR/change:

| Surface | Role |
|---------|------|
| [`INSTALL.md`](INSTALL.md) (this file) | Agent/human install prompt — portable truth |
| [`src/setup.ts`](src/setup.ts) | One-shot: config + init + inject |
| [`src/init.ts`](src/init.ts) / [`src/vault-layout.ts`](src/vault-layout.ts) | Vault seed dirs + template copy |
| [`src/inject.ts`](src/inject.ts) / [`src/runtime.ts`](src/runtime.ts) | Harness MCP launch (Bun or Node+tsx) |
| [`templates/vault/`](templates/vault/) | What a fresh vault contains (includes persona workflows) |
| [`templates/skills/orchesto/`](templates/skills/orchesto/) | Project orchesto skill template + setup README |
| [`templates/prompts/memory-policy.md`](templates/prompts/memory-policy.md) | Injected slim policy |
| [`package.json`](package.json) scripts | `setup` / `brain` / `mcp` / `restart-mcp` entrypoints |
| [`.githooks/post-push`](.githooks/post-push) + [`scripts/restart-mcp.sh`](scripts/restart-mcp.sh) | After push, kill local MCP so the harness respawns with new schemas (`git config core.hooksPath .githooks`) |
| [`config.example.toml`](config.example.toml), [`mcp.cursor.example.json`](mcp.cursor.example.json) | Portable examples (placeholders) |
| [`README.md`](README.md) install blurb | Points here |

After install-path edits: reinject locally (`npm run brain -- inject --target all`) and sanity-check that a **clean** vault path + Node-only (or Bun-only) launch still matches this document.
