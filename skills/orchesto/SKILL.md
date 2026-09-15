---
name: orchesto
description: >-
  Multi-phase feature delivery: optional brainstormer (conversation), then
  optional CPO writes a PRD, architect writes plan and validations (optionally
  as stacked capability phases), implementor builds, reviewer checks against
  validations with at most three fix rounds per phase. Use when shipping a
  feature end-to-end with plan, validations, and review — not for tiny
  one-off edits or a lone PR review.
compatibility: No vault or MCP required. If Hem Vault MCP is present, persona overlays from the vault win.
---

# Orchesto

Procedure only. Persona bodies live in `references/` (this skill) or Hem Vault overlays. Do not inline them here. Do not Read the whole `references/` directory.

## Prerequisites

- This skill directory (`SKILL.md` + `references/`). No vault or MCP required.
- If Hem Vault MCP is readable: project overlay, then vault global, then this pack.

## Seat a persona

When seating `<id>` (`brainstormer` | `cpo` | `architect` | `implementor` | `reviewer`):

1. Load **one** body only. Do not Read `references/` as a folder. Do not load other persona files.
2. If Hem Vault MCP is readable:
   - Try `read_note` `projects/<slug>/workflows/persona-<id>.md`.
   - Else `read_note` `workflows/global/persona-<id>.md`.
   - If that succeeds, inject that body. Do **not** also Read the pack file.
3. Else (MCP missing, tool error, or note missing): Read **only** `references/persona-<id>.md` from this skill directory, then inject.
4. Never fail closed on missing vault.

`resolve_action` (`coding` / `pr-review`): call if MCP is up; if it is not, skip and continue the pipeline.

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

1. Seat `brainstormer` (see **Seat a persona**) — **conversation** across turns; do not ticket-close
2. Stay until the user proceeds or aborts (per persona)
3. On proceed-yes → continue to **0. PRD gate** (if not already answered in-thread); on abort → stop

**Do not** always-ask for brainstormer. **Do not** auto-seat it.

### 0. PRD gate (always ask)

Before architect, **always ask** the user (neutral):

> Does this feature need a PRD / CPO pass?

- You may hint that a change looks small, but **do not skip the ask** and **do not auto-seat CPO**.
- If **no** → go to **1. Architect**.
- If **yes** → seat CPO:

  1. Seat `cpo` (see **Seat a persona**)
  2. Produce `.plans/<feature-slug>/prd.md` and the CPO approval packet
  3. **Stop** until the user explicitly approves the PRD (on reject: CPO revises and re-asks; on abort: stop Orchesto)
  4. After approval → **1. Architect** (architect must treat approved `prd.md` as product source of truth)

### 1. Architect

1. Seat `architect` (see **Seat a persona**)
2. `resolve_action action=coding` if MCP is up and not already resolved this thread for coding; if MCP is unavailable, skip and continue
3. If approved `prd.md` exists for this feature, plan against it
4. Produce the plan contract (per architect): unphased root `plan.md` + `validations.md`, **or** suggest capability phases and wait; on agree, write `phases.md` + every phase folder in one sitting
5. Wait for user approval of the **current** plan/validations before implementor. Approving that pair is the go to build **that phase only** (or the whole unphased feature). Do not auto-start later phases.

### 2. Implementor

1. Seat `implementor` (see **Seat a persona**)
2. Reuse or `resolve_action action=coding` if MCP is up; if MCP is unavailable, skip and continue
3. Implement against the **current plan contract** only (`phases.md` → current phase folder; else root `plan.md` + `validations.md`)

### 3. Reviewer

1. Seat `reviewer` (see **Seat a persona**)
2. Reuse or `resolve_action action=pr-review` if MCP is up; if MCP is unavailable, skip and continue
3. Review against the current contract’s `validations.md`; write `review-report.md` next to that plan (phase folder or feature root)

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
- Duplicate persona / pr-review / coding essays into this file
- Read every file under `references/` up front
- Seat a smallest-solution / lazy-code / ponytail persona, or an always-on lazy mode
- Let implementor replace an approved plan with a smaller invention
