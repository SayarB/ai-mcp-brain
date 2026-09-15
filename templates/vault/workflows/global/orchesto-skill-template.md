---
type: workflow
id: orchesto-skill-template
scope: global
tags: [orchesto, skill-template]
updated: 2026-09-15
---

# Orchesto skill template

Pointer only — **do not** copy this note as `SKILL.md`.

Canonical pack (DAG + bundled personas):

`skills/orchesto/` in the ai-mcp-brain clone (`SKILL.md` + `references/persona-*.md`).

Hem **INSTALL** / `setup` / `inject` copies that **directory** to global harness paths:

| Harness | Global skill directory |
|---------|------------------------|
| Cursor | `~/.cursor/skills/orchesto/` |
| Zed / Codex | `~/.agents/skills/orchesto/` |
| Claude | `~/.claude/skills/orchesto/` |

To update the vault after `git pull` of the clone: `npm run brain -- inject` (or **sync orchesto** / **setup orchesto**). See `setup-orchesto.md`.
