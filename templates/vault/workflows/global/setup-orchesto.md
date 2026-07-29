---
type: workflow
id: setup-orchesto
scope: global
tags: [orchesto, setup]
updated: 2026-07-29
---

# Setup orchesto

**Orchesto ≠ Orca / orca-cli.** Do not web-search. Follow this note only.

When the user asks to **setup orchesto** in a git repo, do the following in that repo.

## 1. Vault + MCP

- Call `vault_info` — expect `readable: true`.
- Personas and this playbook live in the vault. The pipeline skill is **project-only** (never `~/.cursor/skills`).

## 2. Ensure personas (idempotent)

These vault notes must exist (create from brain templates only if **missing** — never overwrite existing):

- `workflows/global/persona-architect.md`
- `workflows/global/persona-implementor.md`
- `workflows/global/persona-reviewer.md`

If missing: copy from the ai-mcp-brain checkout that runs this MCP (`templates/vault/workflows/global/persona-*.md`). Discover that checkout via the MCP server working directory if needed. Prefer `read_note` on the paths above once present.

## 3. Install project skill (Cursor)

1. Read the skill body from vault note `workflows/global/orchesto-skill-template.md` (or from ai-mcp-brain `templates/skills/orchesto/SKILL.md` if that note is missing).
2. Write it to **`<this-git-repo>/.cursor/skills/orchesto/SKILL.md`** (create directories).
3. If that file already exists and differs, **ask** before overwrite.
4. Do **not** install under `~/.cursor/skills/`.

## 4. Plans folder

- Ensure `<this-git-repo>/.plans/` exists.
- Ensure `.plans/` is listed in `<this-git-repo>/.gitignore`.

## 5. Report

Tell the user:

- Skill path: `.cursor/skills/orchesto/SKILL.md` (edit DAG per project here)
- Personas: `workflows/global/persona-*.md` (per-repo overlays: `projects/<slug>/workflows/persona-*.md`)

## Day-to-day (after setup)

The project skill runs architect → plan + validations → implementor → reviewer (fix loop ≤ 3). User does not need to say “run orchesto.”

Standalone `resolve_action` (e.g. `pr-review`) still works without this skill or any persona.
