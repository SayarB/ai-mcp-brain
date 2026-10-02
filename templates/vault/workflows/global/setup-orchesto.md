---
type: workflow
id: setup-orchesto
scope: global
tags: [orchesto, setup]
updated: 2026-09-21
---

# Setup orchesto

**Orchesto ≠ Orca / orca-cli.** Do not web-search. Follow this note only.

Hem Vault **INSTALL** / `bun run setup` already installs Orchesto **out of the box** (global skill packs + vault persona safe-sync). Day-to-day: ship features — no separate setup prompt required.

Use this playbook when the user asks to **setup orchesto** to **repair**, **reinstall**, ensure `.plans/` in the current repo, or optionally add a **project-local** skill copy.

**Update Orchesto** (pull the brain clone + refresh packs): match skill `orchesto-update` (`npm run brain -- orchesto-update`). Do not use this repair playbook for that.

**Remove Orchesto** from the skills list: match skill `orchesto-remove` (or `npm run brain -- orchesto-remove` from the clone).

## 1. Prefer inject from the clone

From the **ai-mcp-brain checkout**:

```bash
npm run brain -- inject --orchesto-only
# or: bun run brain -- inject --orchesto-only
```

That copies `skills/orchesto/`, `orchesto-update/`, and `orchesto-remove/` to global harness skill dirs **and** safe-syncs `workflows/global/persona-{brainstormer,cpo,architect,implementor,reviewer}.md` from `skills/orchesto/references/`. Unmodified notes take upstream; local edits are skipped and reported. Project overlays (`projects/<slug>/workflows/`) are never overwritten. It does **not** rewrite harness MCP/config.

`git pull` of the clone does **not** update the Obsidian vault by itself — use `orchesto-update` (pull + packs) or `inject --orchesto-only` (packs only).

If MCP `vault_info` is available, expect `readable: true`. Vault/MCP is **not** required for the skill pack itself.

## 2. Manual pack copy (only if inject is unavailable)

Copy `<clone>/skills/orchesto/`, `orchesto-update/`, and `orchesto-remove/` (directories, not a single `SKILL.md`) to matching **global** paths:

| Harness | Global skill directories |
|---------|--------------------------|
| **Cursor** | `~/.cursor/skills/orchesto/` (and `orchesto-update/`, `orchesto-remove/`) |
| **Zed** / **Codex** / **OpenCode** | `~/.agents/skills/` same three names |
| **Claude Code** | `~/.claude/skills/` same three names |

Do **not** reconstruct SKILL.md from this vault’s `orchesto-skill-template.md` note (that note is a pointer only).

**Optional project-local** (only if the user asks) — delivery skill unless they also asked for lifecycle copies:

| Harness | Project skill path |
|---------|-------------------|
| **Zed** / **Codex** / **OpenCode** | `<repo>/.agents/skills/orchesto/` |
| **Cursor** | `<repo>/.cursor/skills/orchesto/` |
| **Claude Code** | `<repo>/.claude/skills/orchesto/` |

## 3. Plans folder

- Ensure `<this-git-repo>/.plans/` exists.

## 4. Report

Tell the user:

- Skill path(s) installed (global by default; project-local only if requested) — delivery + update + remove
- Vault personas safe-synced: `workflows/global/persona-*.md` (customize per repo under `projects/<slug>/workflows/persona-*.md`)
- Runtime: Orchesto **always asks** whether a PRD/CPO pass is needed before architect; CPO is optional
- Optional: user may seat **brainstormer** before CPO/architect — not auto-run
- Reminder: Orchesto already ships with Hem Vault install — this playbook is repair / extras. **update orchesto** / **remove orchesto** are sibling skills.

## Day-to-day (after install)

The skill runs optional CPO (PRD) → architect → plan + validations → implementor → reviewer (fix loop ≤ 3). User does not need to say “run orchesto” or “setup orchesto.”

Optional pre-step: user asks to **brainstorm** / seat **brainstormer** — conversation until they proceed, then the normal pipeline (PRD ask → …).

Standalone `resolve_action` (e.g. `pr-review`) still works without this skill or any persona. If MCP is missing, skip `resolve_action` and continue.
