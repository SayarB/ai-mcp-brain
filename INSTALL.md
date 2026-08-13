# Install Hem Vault (ai-mcp-brain)

Agent-first install. There is **no** OS shell installer — this markdown *is* the install script. Paste the one-liner into any coding agent; it fetches this file with `curl` and walks every step.

**Greenfield target:** a machine that may have **only this AI agent** (and a shell). Always **inventory what is already installed** before adding anything. Prefer existing tools (e.g. Node already present → use Node; do not also install Bun). Only install what is missing. If a required choice has no existing option (e.g. neither Bun nor Node), **ask the user** which to use, then install that and continue. Do not tell the user to “install Bun yourself” and quit.

> **For LLM agents: use `curl`, NOT WebFetch / browser fetch.** Those tools summarize and drop env names, absolute paths, MCP snippets, and verify commands. Always:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/SayarB/ai-mcp-brain/main/INSTALL.md
> ```

**Maintainer rule:** any change that affects how this system is installed on a new device must update **this file** and the install path in code (`src/setup.ts`, `src/init.ts`, `src/inject.ts`, `src/runtime.ts`, `src/vault-layout.ts`, `package.json` scripts) in the **same change**. See [Maintaining install](#maintaining-install-contributors).

---

## For humans

**Recommended:** let an agent install it on a blank machine.

### One-liner (paste into any agent)

```
Install Hem Vault (ai-mcp-brain) by following the instructions at:
https://raw.githubusercontent.com/SayarB/ai-mcp-brain/main/INSTALL.md
Use curl -fsSL to fetch that URL — do not use WebFetch.
Inventory what is already on this machine first. Prefer existing runtimes (if Node is present and Bun is not, use Node — do not install Bun). Only install missing pieces. If neither Bun nor Node is present, ask me which to use, then install it and finish setup (Git, Obsidian, clone, vault, MCP).
```

### Already have the repo?

Open this checkout and say: `Follow INSTALL.md in this repo and install Hem Vault.`

### Optional human shortcut (only if repo + Bun/Node already exist)

```bash
bun install && bun run setup -- --vault "~/Obsidian/My Brain"
# or
npm install && npm run setup -- --vault "~/Obsidian/My Brain"
```

---

## Prompt (for agents)

Install Hem Vault (second brain) end-to-end on this machine. **First inventory** what is already installed. Reuse existing Git / Bun / Node / Obsidian / repo checkout. Only install what is missing. Detect the OS, finish setup (clone if needed, vault, MCP + memory policy into harnesses the user has).

### Goals

1. **Inventory** the machine, then ensure **Git**, a **JS runtime**, and the **ai-mcp-brain** checkout exist — reuse when present; install/clone only when missing.
2. Install **Obsidian** only if missing (unless the user declines). MCP works on markdown alone; still offer/install Obsidian for humans when absent.
3. Create an Obsidian-compatible markdown vault from `templates/vault/` (idempotent: never overwrite existing notes).
4. Point MCP at that vault via `BRAIN_VAULT`.
5. Inject memory policy into Cursor / Claude / Codex / Zed when those apps/configs exist (create config files when the harness is installed but files are missing).
6. Install **Orchesto** out of the box (global harness skill adapters + vault personas already seeded). Do **not** leave Orchesto for a separate “setup orchesto” prompt.
7. Leave `instructions/global/*.md` bodies empty unless the user means binding process. Soft prefs → `suggestions/`.
8. Do not invent process/instruction content.
9. **Never abort** solely because something is missing — reuse, ask when required, or install, then continue.

### Agent rules (detect → reuse → ask → install)

- **Always check first** (commands below). Record a short inventory before changing the machine.
- **Reuse** what is already usable. Do not install Bun if Node 20+ is already present and Bun is not. Do not reinstall Git/Obsidian if they already work.
- **Ask the user** when there is no usable option and a real choice exists — especially: **neither Bun nor Node** is present → ask Bun vs Node, then install their choice. Also ask for vault path / clone parent if you cannot use the defaults, or if Obsidian is missing and you need a yes/no.
- Prefer doing installs over asking the user to run installers themselves — once the choice is known.
- After installing Bun/Node/Git, **refresh PATH in this shell** (and use absolute binaries if needed) before continuing.
- On macOS, prefer Homebrew when already present; otherwise use official installers / `curl` scripts below. Do not require Homebrew for Bun.
- Quote paths that contain spaces.
- **Avoid** vaults under iCloud / `Mobile Documents` (editor `EPERM`). Prefer a normal home path.

### Defaults (use unless inventory or user overrides)

| Choice | Default |
|--------|---------|
| Vault | `~/Obsidian/My Brain` (Windows: `%USERPROFILE%\Obsidian\My Brain`) |
| Clone parent | `~/src` or `~/Projects` or `~/code` — whichever exists; else create `~/src` |
| Runtime | See [JS runtime decision](#2-js-runtime--detect-then-choose) — never invent a runtime without checking |
| Obsidian | Install only if missing (ask if unclear) |

---

### Steps

#### 0. Inventory machine (always first)

Detect OS (macOS / Linux / Windows) and package managers (`brew`, `winget`, `apt`, `dnf`, `pacman`). Then check what is already present — **do not install yet**:

```bash
uname -s 2>/dev/null || ver
command -v brew; command -v winget; command -v apt-get; command -v dnf; command -v pacman
git --version
command -v bun; bun --version 2>/dev/null
command -v node; node --version 2>/dev/null
# Obsidian — OS-appropriate checks from section 3
```

Also note: is this directory already `ai-mcp-brain`? Which harness configs exist (`~/.cursor`, `~/.claude`, `~/.codex`, Zed config paths)?

Write a one-line inventory for yourself (and optionally the user), e.g. `macOS | git=yes | bun=no | node=v22 | obsidian=no | brew=yes`. All later steps must follow that inventory.

#### 1. Ensure Git

If `git --version` already works → **reuse it**, skip install.

If missing, install:

| OS | Install |
|----|---------|
| macOS | `xcode-select --install` (if that fails or is too heavy: install Homebrew then `brew install git`) |
| Linux (Debian/Ubuntu) | `sudo apt-get update && sudo apt-get install -y git` |
| Linux (Fedora) | `sudo dnf install -y git` |
| Linux (Arch) | `sudo pacman -S --noconfirm git` |
| Windows | `winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements` |

Re-check `git --version` before continuing.

#### 2. JS runtime — detect, then choose

Run (or reuse inventory from step 0):

```bash
bun --version 2>/dev/null || true
node --version 2>/dev/null || true
```

Treat Node as usable only if the version is **v20 or higher**.

**Decision table (follow exactly):**

| Bun on PATH? | Node ≥ 20 on PATH? | Action |
|--------------|--------------------|--------|
| Yes | either | **Use Bun.** Do not install Node. |
| No | Yes | **Use Node.** Do **not** install Bun. |
| No | No (missing or &lt; 20) | **Ask the user** before installing anything: prefer **Bun** or **Node.js 20+**? Then install **only** their choice (if Node exists but is &lt; 20, say so and ask: upgrade/install Node 20+, or install Bun instead). |

Do **not** auto-install Bun when Node ≥ 20 is already available. Do **not** pick a runtime silently when neither is available — **wait for the user’s answer**.

**Install Bun** (only if chosen or already selected by the table as the thing to add):

- macOS / Linux:

```bash
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
hash -r 2>/dev/null || true
bun --version
```

Persist the two `export` lines in `~/.zshrc` / `~/.bashrc` if missing.

- Windows (PowerShell): `powershell -c "irm bun.sh/install.ps1 | iex"` then use `.bun\bin\bun.exe` / refresh PATH.

**Install Node 20+** (only if chosen or required by the table):

| OS | Install |
|----|---------|
| macOS (Homebrew) | `brew install node@22` or `brew install node` |
| macOS (no brew) | https://nodejs.org LTS, **or** `curl -fsSL https://fnm.vercel.app/install \| bash` then `fnm install 22 && fnm use 22` |
| Linux | NodeSource / distro package / `fnm` — get **v20+** |
| Windows | `winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements` |

Confirm the chosen runtime works (`bun --version` or `node --version` ≥ 20). If the user’s chosen install fails, report the error and ask whether to try the other runtime.

Remember which runtime you selected (`bun` | `node`) for MCP launch and `bun install` vs `npm install`.

#### 3. Ensure Obsidian

Obsidian is the human editor for the vault. MCP does not require it.

If inventory shows Obsidian already installed → **reuse it**, skip install.

If missing: ask briefly whether to install (default **yes**). If the user declines, continue without it and remind them the vault is still plain markdown on disk.

Detect if not already in inventory:

```bash
# macOS
ls /Applications/Obsidian.app 2>/dev/null || mdfind "kMDItemCFBundleIdentifier == md.obsidian" 2>/dev/null | head -1
# Linux
command -v obsidian; ls /usr/bin/obsidian /var/lib/flatpak/app/md.obsidian.Obsidian 2>/dev/null
# Windows: %LOCALAPPDATA%\Obsidian or winget list Obsidian
```

If installing:

| OS | Install |
|----|---------|
| macOS (Homebrew) | `brew install --cask obsidian` |
| macOS (no brew) | Download macOS installer from https://obsidian.md/download — open/mount and install to `/Applications` (agent may use `curl -L` + `open` on the `.dmg` and instruct the user to drag if GUI confirmation is required) |
| Linux (Flatpak) | `flatpak install -y flathub md.obsidian.Obsidian` |
| Linux (AppImage / other) | Follow https://obsidian.md/download for the distro |
| Windows | `winget install --id Obsidian.Obsidian -e --accept-package-agreements --accept-source-agreements` |

If a GUI click is required (Gatekeeper / DMG drag), tell the user exactly what to click, wait for confirmation, then continue. Do not abandon the rest of the install.

#### 4. Ensure repo checkout

If inventory shows this directory (or a known path) is already `ai-mcp-brain` → **reuse it**.

Otherwise:

```bash
mkdir -p "<clone-parent>"   # default ~/src (create if needed)
cd "<clone-parent>"
git clone https://github.com/SayarB/ai-mcp-brain.git
cd ai-mcp-brain
```

If `ai-mcp-brain` already exists there, `cd` into it and `git pull --ff-only` (or leave as-is if dirty — ask before destructive resets).

Remember the **absolute** repo path for MCP `cwd` / args.

#### 5. Install package dependencies

From the repo root, using the **runtime chosen in step 2**:

```bash
# if runtime is Bun
bun install
# if runtime is Node
npm install
```

#### 6. Create vault + inject harnesses

Ask for vault path if unknown; default `~/Obsidian/My Brain`. Resolve to an absolute path (expand `~` / `%USERPROFILE%`). Create parent dirs as needed.

Prefer (same runtime as step 2):

```bash
# Bun
bun run setup -- --vault "<vault-path>"
# Node
npm run setup -- --vault "<vault-path>"
```

That runs vault init + harness inject and writes `config.toml`.

If `setup` fails, do the manual path:

1. Copy everything under `templates/vault/` into the vault root — create missing files/dirs only; **never overwrite** existing files.
2. Ensure dirs exist (must match `REQUIRED_VAULT_DIRS` in `src/vault-layout.ts`):
   `inbox`, `external`, `projects`, `patterns`, `stack`, `stack/catalog`, `media`, `agents`, `instructions`, `instructions/global`, `suggestions`, `suggestions/global`, `workflows`, `workflows/global`, `actions`, `_meta`, `work`, `work/cache`, `work/log`.
3. Write repo `config.toml` (gitignored):

```toml
vault_path = "<absolute-or-~/vault-path>"
```

4. Continue with sections 7–8 (MCP entry + harness wire).

Setup copies `.env.example` → `.env` if missing. MCP loads `.env` at startup.

#### 7. MCP server entry (all harnesses)

Prefer Bun when available; otherwise Node + local `tsx`. Use **absolute** paths (after Bun install, binary is often `$HOME/.bun/bin/bun`).

**If Bun:**

- command: absolute `bun`
- args: `[ "<repo>/src/mcp/server.ts" ]`

**If Node only:**

- command: absolute `node`
- args: `[ "<repo>/node_modules/tsx/dist/cli.mjs", "<repo>/src/mcp/server.ts" ]`

Common for both:

- cwd: `<repo>`
- env: `{ "BRAIN_VAULT": "<absolute-vault-path>" }`

`npm run setup` / `bun run setup` picks Bun vs Node via `resolveMcpLaunch` in `src/runtime.ts`. Example shape: `mcp.cursor.example.json` (placeholders only).

#### 8. Wire harnesses

Policy text comes from `templates/prompts/memory-policy.md` with `{{VAULT_PATH}}` (and other placeholders) replaced. Injected slim policy must mention: `resolve_action` mode-start, reuse bundle already in this chat for the same action (no repeat MCP call), soft suggestions auto-log, binding instructions explicit-only.

Detect which harnesses exist (or which the user is in right now). Wire all that apply. Creating missing config files is OK when the app is installed.

**Cursor**

- Merge into `~/.cursor/mcp.json` under `mcpServers.ai-mcp-brain` (preserve other servers).
- Also write `<repo>/.cursor/mcp.json` the same way (optional project config).
- Write `~/.cursor/rules/second-brain.mdc` with frontmatter `alwaysApply: true` and the rendered memory-policy text.

**Claude**

- Upsert a marked block in `~/.claude/CLAUDE.md` between `<!-- second-brain:start -->` and `<!-- second-brain:end -->`.

**Codex**

- Upsert the same marked block in `~/.codex/AGENTS.md`.
- In `~/.codex/config.toml`, upsert the MCP block with the same command/args/cwd/env as section 7.

**Zed**

- macOS/Linux: `~/.config/zed/settings.json` and `~/.config/zed/AGENTS.md`
- Windows: `%APPDATA%\Zed\settings.json` and `%APPDATA%\Zed\AGENTS.md`
- Set `context_servers.ai-mcp-brain` to `{ "enabled": true, "command": "<runtime>", "args": [...], "env": { "BRAIN_VAULT": "<absolute-vault>" } }` without destroying unrelated keys/comments.
- Upsert the marked policy block into Zed `AGENTS.md`.

Skip only harnesses the user explicitly does not use **and** that are not installed.

#### 9. Install Orchesto (out of the box)

Orchesto ships with Hem Vault. **Do this during install** — do not tell the user to run a separate “setup orchesto” prompt later.

`bun run setup` / `npm run setup` (and `brain inject`) already install the global skill. If you used the manual path in step 6, install it now:

1. Read skill body from `<repo>/templates/skills/orchesto/SKILL.md` (same text as vault `workflows/global/orchesto-skill-template.md`).
2. Write that body (including YAML frontmatter) to the **global** harness skill paths that match wired harnesses:

| Harness | Global skill path |
|---------|-------------------|
| Cursor | `~/.cursor/skills/orchesto/SKILL.md` |
| Zed / Codex / OpenCode-style | `~/.agents/skills/orchesto/SKILL.md` |
| Claude Code | `~/.claude/skills/orchesto/SKILL.md` |

3. Create parent dirs as needed. If a target file already exists and differs, prefer updating to the template on a fresh install; on re-inject, overwrite only if content differs (idempotent skip when identical).
4. Personas are already in the vault from step 6 (`workflows/global/persona-*.md`). Do not web-search; Orchesto ≠ Orca.
5. Product repos still need `.plans/` (gitignored) when shipping a feature — the skill creates that on first use. Optional repair playbook: vault `workflows/global/setup-orchesto.md`.

#### 10. Open vault in Obsidian

- macOS: `open -a Obsidian "<absolute-vault-path>"` or open Obsidian → **Open folder as vault** → select the vault path.
- Linux: launch Obsidian and open the folder as a vault.
- Windows: start Obsidian and open the folder as a vault.

If Obsidian first-run UI blocks automation, give the user one short instruction to open that folder as a vault, then continue verification.

#### 11. Verify

- `bun --version` or `node --version` works in a fresh shell (PATH persisted).
- `git --version` works.
- Repo exists; `node_modules` present (or Bun install tree).
- Vault top-level folders include `suggestions/`, `instructions/`, `actions/`, `workflows/`, `work/`.
- `actions/registry.md` exists.
- Empty-ish shells for kinds `coding`, `pr-review`, `commit`, `git` under both `instructions/global/` and `suggestions/global/`.
- MCP config uses absolute paths + `BRAIN_VAULT`.
- Orchesto global skill present for wired harnesses (e.g. `~/.cursor/skills/orchesto/SKILL.md` and/or `~/.agents/skills/orchesto/SKILL.md`).
- Vault has Orchesto personas under `workflows/global/persona-*.md`.
- Obsidian installed (or user declined) and vault path known.
- Tell the user to **restart / reload** the coding agent/editor, then run MCP tool `vault_info` → expect `readable: true`.
- Optional: `resolve_action` with `action=coding` should return instructions + soft-suggestions (bodies may be empty on a fresh install).

### Policy reminders to leave in place

- `resolve_action` on **mode start only** (not every turn). Reuse an earlier same-action bundle already in this chat; re-resolve only on mode switch / reload / missing bundle.
- Project guidance precedes global.
- Soft standing prefs → `upsert_guidance` `type=suggestion` (no magic words).
- Do not fill binding instructions unless the user explicitly asks for hard rules.
- **Orchesto is already installed** with this brain — ship features without a separate setup prompt. Repair / reinstall / per-repo extras: `read_note` `workflows/global/setup-orchesto.md` (do not web-search; Orchesto ≠ Orca).
- When asked to **brainstorm** / seat **brainstormer**: `read_note` `workflows/global/persona-brainstormer.md`, seat conversation persona; on proceed write `.plans/<slug>/brainstorm.md` then continue Orchesto. Not a fixed pipeline step / not CPO.
- When asked to **audit** a repo/area: `read_note` `workflows/global/persona-auditor.md`, seat auditor, write `.audits/<scope-slug>/report.md` (ensure `.audits/` gitignored). Not Orchesto / not PR reviewer.

### Done criteria

Report:

1. Inventory summary (what was already present)  
2. What you installed vs reused (Git / Bun / Node / Obsidian / clone)  
3. Runtime chosen and **why** (e.g. “Node v22 already present — skipped Bun”)  
4. Absolute repo path  
5. Absolute vault path  
6. Which harnesses were wired  
7. Orchesto global skill path(s) installed  
8. Bun vs Node MCP launch command  
9. That MCP uses `BRAIN_VAULT`  
10. That the user should reload the editor and call `vault_info`

---

## Orchesto (included with install)

Orchesto is installed **during** Hem Vault setup (global skill + vault personas). Users do **not** need a separate “setup orchesto” prompt for day-to-day use.

| Piece | Where |
|-------|--------|
| Global skill | `~/.cursor/skills/orchesto/`, `~/.agents/skills/orchesto/`, `~/.claude/skills/orchesto/` (as applicable) |
| Personas + playbook | Vault `workflows/global/persona-*.md`, `setup-orchesto.md` |
| Contributor template | [`templates/skills/orchesto/`](templates/skills/orchesto/) (kept in sync with vault `orchesto-skill-template.md`) |

Optional: say **setup orchesto** in a product repo to repair the global skill, ensure personas, ensure `.plans/` is gitignored, or install an optional **project-local** skill copy for per-repo DAG edits. Agent follows `workflows/global/setup-orchesto.md`.

---

## Uninstall

Same pattern — agent prompt: [`UNINSTALL.md`](UNINSTALL.md)  
Raw URL: `https://raw.githubusercontent.com/SayarB/ai-mcp-brain/main/UNINSTALL.md`

---

## Maintaining install (contributors)

When you change **how install works** on a new machine, update **all** of the following in the same PR/change:

| Surface | Role |
|---------|------|
| [`INSTALL.md`](INSTALL.md) (this file) | Agent/human install prompt — portable truth (including greenfield deps) |
| [`UNINSTALL.md`](UNINSTALL.md) | Agent/human uninstall prompt — reverse of harness wiring |
| [`src/setup.ts`](src/setup.ts) | One-shot: config + init + inject |
| [`src/init.ts`](src/init.ts) / [`src/vault-layout.ts`](src/vault-layout.ts) | Vault seed dirs + template copy |
| [`src/inject.ts`](src/inject.ts) / [`src/runtime.ts`](src/runtime.ts) | Harness MCP launch (Bun or Node+tsx) |
| [`templates/vault/`](templates/vault/) | What a fresh vault contains (includes persona workflows) |
| [`templates/skills/orchesto/`](templates/skills/orchesto/) | Orchesto skill template (global install via inject) + setup README |
| [`templates/prompts/memory-policy.md`](templates/prompts/memory-policy.md) | Injected slim policy |
| [`package.json`](package.json) scripts | `setup` / `brain` / `mcp` / `restart-mcp` entrypoints |
| [`.githooks/post-push`](.githooks/post-push) + [`scripts/restart-mcp.sh`](scripts/restart-mcp.sh) | After push, kill local MCP so the harness respawns with new schemas (`git config core.hooksPath .githooks`) |
| [`config.example.toml`](config.example.toml), [`mcp.cursor.example.json`](mcp.cursor.example.json), [`.env.example`](.env.example) | Portable examples (placeholders; no secrets) |
| [`README.md`](README.md) / [`docs/guides/getting-started.md`](docs/guides/getting-started.md) | Points here; mention greenfield agent install |

After install-path edits: reinject locally (`npm run brain -- inject --target all`) and sanity-check that a **clean** vault path + Node-only (or Bun-only) launch still matches this document. Mentally walk a blank Mac/Linux/Windows agent session: missing Git, Bun, Obsidian, and repo must still succeed via this file alone.
