---
type: workflow
id: orchesto-skill-template
scope: global
tags: [orchesto, skill-template]
updated: 2026-07-29
---

# Orchesto skill template (for project install)

When **setup orchesto** runs, copy the fenced `SKILL.md` body below into `<git-repo>/.cursor/skills/orchesto/SKILL.md` (including the YAML frontmatter). Keep this note in sync with ai-mcp-brain `templates/skills/orchesto/SKILL.md`.

```markdown
---
name: orchesto
description: >-
  Multi-phase feature delivery using vault personas: architect writes plan and
  validations, implementor builds, reviewer checks against validations with at
  most three fix rounds. Use when shipping a feature end-to-end with plan,
  validations, and review — not for tiny one-off edits or a lone PR review.
---

# Orchesto

Procedure only. Persona bodies and action process live in the second-brain vault (MCP). Do not inline them here.

## Prerequisites

- ai-mcp-brain MCP available (`BRAIN_VAULT`)
- Vault personas readable (after **setup orchesto**): `workflows/global/persona-architect.md`, `persona-implementor.md`, `persona-reviewer.md` (project overlays under `projects/<slug>/workflows/` win when present)

## Artifacts

All under `.plans/<feature-slug>/` (create slug from the feature; ensure `.plans/` is in `.gitignore`):

| File | Author |
|------|--------|
| `plan.md` | architect |
| `validations.md` | architect |
| `review-report.md` | reviewer (each round) |

## Pipeline

### 1. Architect

1. `read_note` persona (project path if exists, else `workflows/global/persona-architect.md`)
2. Seat that persona (same session or subagent — inject persona body into the worker prompt)
3. `resolve_action action=coding` if not already in this thread for coding
4. Produce `plan.md` + `validations.md`

### 2. Implementor

1. `read_note` `persona-implementor` (project overlay then global)
2. Seat implementor
3. Reuse or `resolve_action action=coding`
4. Implement against `plan.md` + `validations.md`

### 3. Reviewer

1. `read_note` `persona-reviewer`
2. Seat reviewer
3. Reuse or `resolve_action action=pr-review`
4. Review against `validations.md`; write `review-report.md`

### 4. Fix loop (max 3 rounds)

A **round** = implementor applies review feedback → reviewer re-reviews.

- If `review-report.md` says `changes_required` and rounds so far **< 3**: go to implementor, then reviewer again
- If **pass**: continue to summary
- If still failing after **3** rounds: **stop**; summarize remaining blockers; do not loop further

### 5. Summary

Short coordinator note: what shipped, validation status, rounds used, open follow-ups.

## Do not

- Skip validations or the review report
- Load personas outside this skill’s pipeline unless the user asks
- Duplicate vault persona / pr-review / coding essays into this file
```
