---
type: workflow
id: setup-orchesto
scope: global
tags: [orchesto, setup]
updated: 2026-08-12
---

# Setup orchesto

**Orchesto ≠ Orca / orca-cli.** Do not web-search. Follow this note only.

Hem Vault **INSTALL** / `bun run setup` already installs Orchesto **out of the box** (global skill + vault personas). Day-to-day: ship features — no separate setup prompt required.

Use this playbook when the user asks to **setup orchesto** to **repair**, **reinstall**, ensure `.plans/` in the current repo, or optionally add a **project-local** skill copy.

## 1. Vault + MCP

- Call `vault_info` — expect `readable: true`.
- Personas and this playbook live in the vault.
- Default skill home = **global** user dirs (installed with the brain). Project-local copies are optional overlays for per-repo DAG edits.

## 2. Ensure personas (idempotent)

These vault notes must exist (create from brain templates only if **missing** — never overwrite existing):

- `workflows/global/persona-cpo.md`
- `workflows/global/persona-architect.md`
- `workflows/global/persona-implementor.md`
- `workflows/global/persona-reviewer.md`
- `workflows/global/persona-brainstormer.md`

If missing: copy from the ai-mcp-brain checkout that runs this MCP (`templates/vault/workflows/global/persona-*.md`). Discover that checkout via the MCP server working directory if needed. Prefer `read_note` on the paths above once present.

## 3. Install / repair skill (harness adapter)

1. Read the skill body from vault note `workflows/global/orchesto-skill-template.md` (or from ai-mcp-brain `templates/skills/orchesto/SKILL.md` if that note is missing).
2. **Default (matches INSTALL):** write the same `SKILL.md` body to matching **global** paths:

| Harness | Global skill path |
|---------|-------------------|
| **Cursor** | `~/.cursor/skills/orchesto/SKILL.md` |
| **Zed** / **Codex** / **OpenCode** | `~/.agents/skills/orchesto/SKILL.md` |
| **Claude Code** | `~/.claude/skills/orchesto/SKILL.md` |

3. Prefer `bun run brain -- inject` / `npm run brain -- inject` from the ai-mcp-brain checkout when available (installs Orchesto with harness inject).
4. **Optional project-local** (only if the user asks for a per-repo skill / Conductor workspace copy):

| Harness | Project skill path |
|---------|-------------------|
| **Zed** / **Codex** / **OpenCode** | `<repo>/.agents/skills/orchesto/SKILL.md` |
| **Cursor** | `<repo>/.cursor/skills/orchesto/SKILL.md` |
| **Claude Code** | `<repo>/.claude/skills/orchesto/SKILL.md` |

5. If a target file already exists and differs, **ask** before overwrite (except when re-running brain inject / fresh INSTALL).
6. **Conductor:** no proprietary skill path — install the global paths (and project-local copies if they asked for Conductor workspaces).

## 4. Plans folder

- Ensure `<this-git-repo>/.plans/` exists.
- Ensure `.plans/` is listed in `<this-git-repo>/.gitignore`.

## 5. Report

Tell the user:

- Skill path(s) installed (global by default; project-local only if requested)
- Personas: `workflows/global/persona-*.md` (per-repo overlays: `projects/<slug>/workflows/persona-*.md`)
- Runtime: Orchesto **always asks** whether a PRD/CPO pass is needed before architect; CPO is optional
- Optional: user may seat **brainstormer** (`persona-brainstormer`) for conversation before CPO/architect — not auto-run
- Reminder: Orchesto already ships with Hem Vault install — this playbook is repair / extras

## Day-to-day (after install)

The skill runs optional CPO (PRD) → architect → plan + validations → implementor → reviewer (fix loop ≤ 3). User does not need to say “run orchesto” or “setup orchesto.”

Optional pre-step: user asks to **brainstorm** / seat **brainstormer** — conversation until they proceed, then the normal pipeline (PRD ask → …).

Standalone `resolve_action` (e.g. `pr-review`) still works without this skill or any persona.
