---
type: workflow
id: orchesto-skill-template
scope: global
tags: [orchesto, skill-template]
updated: 2026-08-16
---

# Orchesto skill template

Hem Vault **INSTALL** / `setup` / `inject` copies the fenced `SKILL.md` body below into **global** harness paths (including YAML frontmatter): Cursor → `~/.cursor/skills/orchesto/SKILL.md`; Zed/Codex → `~/.agents/skills/orchesto/SKILL.md`; Claude → `~/.claude/skills/orchesto/SKILL.md`. Optional project-local copies via **setup orchesto** repair playbook. Keep this note in sync with ai-mcp-brain `templates/skills/orchesto/SKILL.md`.

```markdown
---
name: orchesto
description: >-
  Multi-phase feature delivery using vault personas: optional brainstormer
  (conversation) then optional CPO writes a PRD, architect writes plan and
  validations (optionally as stacked capability phases), implementor builds,
  reviewer checks against validations with at most three fix rounds per phase.
  Use when shipping a feature end-to-end with plan, validations, and review —
  not for tiny one-off edits or a lone PR review.
---

# Orchesto

Procedure only. Persona bodies and action process live in the second-brain vault (MCP). Do not inline them here.

## Prerequisites

- ai-mcp-brain MCP available (`BRAIN_VAULT`)
- Vault personas readable (shipped with Hem Vault install): `workflows/global/persona-cpo.md`, `persona-architect.md`, `persona-implementor.md`, `persona-reviewer.md`, `persona-brainstormer.md` (project overlays under `projects/<slug>/workflows/` win when present)

## Artifacts

All under `.plans/<feature-slug>/` (create slug from the feature; ensure `.plans/` is in `.gitignore`):

**Always (when those seats ran):**

| File | Author |
|------|--------|
| `brainstorm.md` | brainstormer (optional — handoff only, after user proceed-yes) |
| `prd.md` | CPO (optional — only if user says yes to PRD) |

**Unphased** (default — no `phases.md`):

| File | Author |
|------|--------|
| `plan.md` | architect |
| `validations.md` | architect |
| `review-report.md` | reviewer (each round) |

**Phased** (after the user agrees to a split — no root `plan.md` / `validations.md`):

| File | Author |
|------|--------|
| `phases.md` | architect (order, capability sentences, status) |
| `<NN>-<phase-slug>/plan.md` | architect |
| `<NN>-<phase-slug>/validations.md` | architect |
| `<NN>-<phase-slug>/review-report.md` | reviewer (each round of that phase) |

**Current plan contract:** if `phases.md` exists, `.plans/<feature-slug>/<current-phase>/`; else `.plans/<feature-slug>/`. Current phase = the folder the user just approved to build. Coordinator may set that row’s status in `phases.md` (`pending-approval` → `in-progress` when implementor starts; `pass` / `changes_required` from review). Never advance to the next folder without a new user approval of that phase’s plan.

## Pipeline

### Optional: Brainstormer (user-invoked only)

If the user asks to **brainstorm** / seat **brainstormer** / talk through an idea before CPO or architect:

1. `read_note` `workflows/global/persona-brainstormer.md` (project overlay if present)
2. Seat brainstormer (inject persona body) — **conversation** across turns; do not ticket-close
3. Stay until the user proceeds or aborts (per persona)
4. On proceed-yes → continue to **0. PRD gate** (if not already answered in-thread); on abort → stop

**Do not** always-ask for brainstormer. **Do not** auto-seat it.

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
3. `resolve_action action=coding` if not already resolved this thread for coding
4. If approved `prd.md` exists for this feature, plan against it
5. Produce the plan contract (per architect): unphased root `plan.md` + `validations.md`, **or** suggest capability phases and wait; on agree, write `phases.md` + every phase folder in one sitting
6. Wait for user approval of the **current** plan/validations before implementor. Approving that pair is the go to build **that phase only** (or the whole unphased feature). Do not auto-start later phases.

### 2. Implementor

1. `read_note` `persona-implementor` (project overlay then global)
2. Seat implementor
3. Reuse or `resolve_action action=coding`
4. Implement against the **current plan contract** only (`phases.md` → current phase folder; else root `plan.md` + `validations.md`)

### 3. Reviewer

1. `read_note` `persona-reviewer`
2. Seat reviewer
3. Reuse or `resolve_action action=pr-review`
4. Review against the current contract’s `validations.md`; write `review-report.md` next to that plan (phase folder or feature root)

### 4. Fix loop (max 3 rounds per phase)

A **round** = implementor applies review feedback → reviewer re-reviews.

Count rounds on the **current phase** (or the unphased feature). Reset to 0 when a new phase starts.

- If `review-report.md` says `changes_required` and rounds so far **< 3**: go to implementor, then reviewer again
- If **pass** and `phases.md` lists a later phase not yet `pass`: **stop**. Ask the user to approve the **next** phase’s plan/validations. Do **not** auto-seat implementor.
- If **pass** and unphased or last phase: continue to summary
- If still failing after **3** rounds: **stop**; summarize remaining blockers; do not loop further; do not start the next phase

### 5. Summary

Short coordinator note: what shipped, whether brainstormer/CPO/PRD was used, whether the work was phased (how many phases shipped / remaining), validation status, rounds used, open follow-ups.

## Do not

- Always-ask for or auto-seat brainstormer
- Skip the PRD ask, or seat CPO without a user yes
- Start architect before PRD approval when the user opted into CPO
- Skip plan/validation approval, validations, or the review report
- Auto-start the next phase after review `pass`
- Skip per-phase approval or per-phase review
- Implement every phase then review once
- Load personas outside this skill’s pipeline unless the user asks
- Duplicate vault persona / pr-review / coding essays into this file
```
