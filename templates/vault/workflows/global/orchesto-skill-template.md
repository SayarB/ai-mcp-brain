---
type: workflow
id: orchesto-skill-template
scope: global
tags: [orchesto, skill-template]
updated: 2026-07-31
---

# Orchesto skill template (for project install)

When **setup orchesto** runs, copy the fenced `SKILL.md` body below into the harness adapter path (including the YAML frontmatter): Zed → `<git-repo>/.agents/skills/orchesto/SKILL.md`; Cursor → `<git-repo>/.cursor/skills/orchesto/SKILL.md`. Keep this note in sync with ai-mcp-brain `templates/skills/orchesto/SKILL.md`.

```markdown
---
name: orchesto
description: >-
  Multi-phase feature delivery using vault personas: optional CPO writes a PRD,
  architect writes plan and validations, implementor builds, reviewer checks
  against validations with at most three fix rounds. Use when shipping a feature
  end-to-end with plan, validations, and review — not for tiny one-off edits or
  a lone PR review.
---

# Orchesto

Procedure only. Persona bodies and action process live in the second-brain vault (MCP). Do not inline them here.

## Prerequisites

- ai-mcp-brain MCP available (`BRAIN_VAULT`)
- Vault personas readable (after **setup orchesto**): `workflows/global/persona-cpo.md`, `persona-architect.md`, `persona-implementor.md`, `persona-reviewer.md` (project overlays under `projects/<slug>/workflows/` win when present)

## Artifacts

All under `.plans/<feature-slug>/` (create slug from the feature; ensure `.plans/` is in `.gitignore`):

| File | Author |
|------|--------|
| `prd.md` | CPO (optional — only if user says yes to PRD) |
| `plan.md` | architect |
| `validations.md` | architect |
| `review-report.md` | reviewer (each round) |

## Pipeline

### 0. PRD gate (always ask)

Before architect, **always ask** the user (neutral):

> Does this feature need a PRD / CPO pass?

- You may hint that a change looks small, but **do not skip the ask** and **do not auto-seat CPO**.
- If **no** → go to **1. Architect**.
- If **yes** → seat CPO:

  1. `read_note` `workflows/global/persona-cpo.md` (project overlay if present)
  2. Seat CPO (inject persona body)
  3. Produce `.plans/<feature-slug>/prd.md` and the CPO approval packet
  4. **Stop** until the user explicitly approves the PRD (on reject: CPO revises and re-asks; on abort: stop Orchesto)
  5. After approval → **1. Architect** (architect must treat approved `prd.md` as product source of truth)

### 1. Architect

1. `read_note` persona (project path if exists, else `workflows/global/persona-architect.md`)
2. Seat that persona (same session or subagent — inject persona body into the worker prompt)
3. `resolve_action action=coding` if not already in this thread for coding
4. If approved `prd.md` exists for this feature, plan against it
5. Produce `plan.md` + `validations.md` and wait for user approval before implementor (per architect persona)

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

Short coordinator note: what shipped, whether CPO/PRD was used, validation status, rounds used, open follow-ups.

## Do not

- Skip the PRD ask, or seat CPO without a user yes
- Start architect before PRD approval when the user opted into CPO
- Skip plan/validation approval, validations, or the review report
- Load personas outside this skill’s pipeline unless the user asks
- Duplicate vault persona / pr-review / coding essays into this file

```
