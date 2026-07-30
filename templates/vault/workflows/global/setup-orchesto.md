---
type: workflow
id: setup-orchesto
scope: global
tags: [orchesto, setup]
updated: 2026-07-31
---

# Setup orchesto

**Orchesto ≠ Orca / orca-cli.** Do not web-search. Follow this note only.

When the user asks to **setup orchesto** in a git repo, do the following in that repo.

## 1. Vault + MCP

- Call `vault_info` — expect `readable: true`.
- Personas and this playbook live in the vault. The pipeline skill is **project-only** (never global user skill dirs).

## 2. Ensure personas (idempotent)

These vault notes must exist (create from brain templates only if **missing** — never overwrite existing):

- `workflows/global/persona-cpo.md`
- `workflows/global/persona-architect.md`
- `workflows/global/persona-implementor.md`
- `workflows/global/persona-reviewer.md`

If missing: copy from the ai-mcp-brain checkout that runs this MCP (`templates/vault/workflows/global/persona-*.md`). Discover that checkout via the MCP server working directory if needed. Prefer `read_note` on the paths above once present.

## 3. Install project skill (harness adapter)

1. Read the skill body from vault note `workflows/global/orchesto-skill-template.md` (or from ai-mcp-brain `templates/skills/orchesto/SKILL.md` if that note is missing).
2. Detect the coding harness (user said which editor, or project markers). Install the **same** `SKILL.md` body to the matching **project-local** path(s):

| Harness | Project skill path |
|---------|-------------------|
| **Zed** | `<repo>/.agents/skills/orchesto/SKILL.md` |
| **Cursor** | `<repo>/.cursor/skills/orchesto/SKILL.md` |

3. If the user named a harness (e.g. “this is zed”), install that path only. If unclear or they use both, install both.
4. If a target file already exists and differs, **ask** before overwrite.
5. Do **not** install under `~/.agents/skills/` or `~/.cursor/skills/`.

## 4. Plans folder

- Ensure `<this-git-repo>/.plans/` exists.
- Ensure `.plans/` is listed in `<this-git-repo>/.gitignore`.

## 5. Report

Tell the user:

- Skill path(s) installed (Zed and/or Cursor as above — edit DAG per project there)
- Personas: `workflows/global/persona-*.md` (per-repo overlays: `projects/<slug>/workflows/persona-*.md`)
- Runtime: Orchesto **always asks** whether a PRD/CPO pass is needed before architect; CPO is optional

## Day-to-day (after setup)

The project skill runs optional CPO (PRD) → architect → plan + validations → implementor → reviewer (fix loop ≤ 3). User does not need to say “run orchesto.”

Standalone `resolve_action` (e.g. `pr-review`) still works without this skill or any persona.
