---
type: workflow
id: setup-orchesto
scope: global
tags: [orchesto, setup]
updated: 2026-09-15
---

# Setup orchesto

**Orchesto ≠ Orca / orca-cli.** Do not web-search. Follow this note only.

Hem Vault **INSTALL** / `bun run setup` already installs Orchesto **out of the box** (global skill pack + vault persona safe-sync). Day-to-day: ship features — no separate setup prompt required.

Use this playbook when the user asks to **setup orchesto**, **sync orchesto**, or **update orchesto personas** — repair, reinstall, pull upstream personas into the vault, or ensure `.plans/` in the current repo.

## 1. Prefer inject from the clone

From the **ai-mcp-brain checkout** (the clone that was `git pull`ed):

```bash
npm run brain -- inject
# or: bun run setup
```

That copies `skills/orchesto/` to global harness skill dirs **and** safe-syncs `workflows/global/persona-{brainstormer,cpo,architect,implementor,reviewer}.md` from `skills/orchesto/references/`. Unmodified notes take upstream; local edits are skipped and reported. Project overlays (`projects/<slug>/workflows/`) are never overwritten.

`git pull` of the clone does **not** update the Obsidian vault by itself.

If MCP `vault_info` is available, expect `readable: true`. Vault/MCP is **not** required for the skill pack itself.

## 2. Manual pack copy (only if inject is unavailable)

Copy the directory `<clone>/skills/orchesto/` (not a single `SKILL.md`) to matching **global** paths:

| Harness | Global skill directory |
|---------|------------------------|
| **Cursor** | `~/.cursor/skills/orchesto/` |
| **Zed** / **Codex** / **OpenCode** | `~/.agents/skills/orchesto/` |
| **Claude Code** | `~/.claude/skills/orchesto/` |

Do **not** reconstruct SKILL.md from this vault’s `orchesto-skill-template.md` note (that note is a pointer only).

**Optional project-local** (only if the user asks):

| Harness | Project skill path |
|---------|-------------------|
| **Zed** / **Codex** / **OpenCode** | `<repo>/.agents/skills/orchesto/` |
| **Cursor** | `<repo>/.cursor/skills/orchesto/` |
| **Claude Code** | `<repo>/.claude/skills/orchesto/` |

## 3. Plans folder

- Ensure `<this-git-repo>/.plans/` exists.
- Ensure `.plans/` is listed in `<this-git-repo>/.gitignore`.

## 4. Report

Tell the user:

- Skill path(s) installed (global by default; project-local only if requested)
- Vault personas safe-synced: `workflows/global/persona-*.md` (customize per repo under `projects/<slug>/workflows/persona-*.md`)
- Runtime: Orchesto **always asks** whether a PRD/CPO pass is needed before architect; CPO is optional
- Optional: user may seat **brainstormer** before CPO/architect — not auto-run
- Reminder: Orchesto already ships with Hem Vault install — this playbook is repair / sync

## Day-to-day (after install)

The skill runs optional CPO (PRD) → architect → plan + validations → implementor → reviewer (fix loop ≤ 3). User does not need to say “run orchesto” or “setup orchesto.”

Optional pre-step: user asks to **brainstorm** / seat **brainstormer** — conversation until they proceed, then the normal pipeline (PRD ask → …).

Standalone `resolve_action` (e.g. `pr-review`) still works without this skill or any persona. If MCP is missing, skip `resolve_action` and continue.
