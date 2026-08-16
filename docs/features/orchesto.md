# Feature: Orchesto & personas

## Overview

**Orchesto** is a multi-phase delivery skill (installed with Hem Vault): optional brainstorm → always-ask PRD gate → optional CPO → architect → implementor → reviewer → fix loop (≤3 **per phase**) → summary.

It is for shipping a feature end-to-end with plan, validations, and review — not tiny one-off edits or a lone PR review. It is **not** Orca / orca-cli.

On a **large** ask, the architect may split work into stacked **capability phases**. The user agrees to the split; the architect writes every phase’s `plan.md` + `validations.md` in one sitting; implementor and reviewer run **one phase at a time**. Approving a phase’s plan is the go to build it. Later phases do **not** auto-start.

| Owned by | What |
|----------|------|
| **Vault (MCP)** | Persona bodies, setup/repair playbook, skill template note, coding/PR process via `resolve_action` |
| **Global skill** | Pipeline procedure only — who seats when, gates, artifact paths, per-phase fix-loop cap (installed by `setup` / `inject`) |

## Personas

| Seat | Role | In Orchesto? |
|------|------|--------------|
| **Brainstormer** | Sharpens the product/change idea (design-tree grill; every question must improve it); handoff brief on proceed | Optional pre-step (user-invoked only) |
| **CPO** | PRD / product requirements | Optional (user yes at PRD gate) |
| **Architect** | `plan.md` + `validations.md` (optional `phases.md` + per-phase folders) | Required |
| **Implementor** | Build against the **current** plan contract | Required |
| **Reviewer** | Change gate vs current validations → `review-report.md` | Required |
| **Auditor** | Holistic repo/area audit → `.audits/` | Standalone (not Orchesto) |

Personas are workflows under `workflows/global/` (project overlays win). They are **not** `resolve_action` ids.

## How it works

```
[brainstormer?] ──proceed──► PRD gate (always ask)
                              │ yes → CPO → prd.md → user approves
                              │ no  ──────────────────────────────┐
                              ▼                                   ▼
                          architect
                              │ unphased → root plan + validations
                              │ phased → suggest split → user agrees
                              │        → phases.md + all phase folders (one sitting)
                              ▼
                          user approves **current** plan  (go to build that phase / unphased feature)
                              ▼
                          implementor → code (current contract only)
                              ▼
                          reviewer → review-report.md (next to that plan)
                              │ changes_required & rounds < 3 → implementor ↔ reviewer
                              │ pass + later phase remains → **stop**; wait to approve next phase
                              │ pass + last / unphased → summary
                              │ still failing after 3 → stop with blockers
```

**Hard stops:** brainstormer proceed-yes; CPO PRD approval (if opted in); architect plan/validation approval **per phase** (unphased: once); after a phase review `pass` when more phases remain.

**Artifacts** under `.plans/<feature-slug>/` (gitignored):

| File | Author | When |
|------|--------|------|
| `brainstorm.md` | brainstormer | Handoff only |
| `prd.md` | CPO | If opted in |
| `plan.md` + `validations.md` | architect | Unphased (no `phases.md`) |
| `review-report.md` | reviewer | Unphased (each round) |
| `phases.md` | architect | Phased |
| `<NN>-<phase-slug>/plan.md` + `validations.md` | architect | Phased (all written in one sitting) |
| `<NN>-<phase-slug>/review-report.md` | reviewer | Phased (each round of that phase) |

A phase is a **nameable capability**, not a stack layer. Schema-only is a phase only when that *is* the work. Phased features have **no** root `plan.md` as the implementor contract.

Auditor writes `.audits/<scope-slug>/report.md` separately.

## Capabilities

- Sized plans with checkable validations  
- Optional product shaping (brainstormer and/or CPO)  
- Optional capability phasing on large asks (all phase plans in one architect sitting)  
- Per-phase implementation and review; 3-round fix cap **per phase**  
- Validation-driven review with `pass` / `changes_required`  
- Per-repo persona overlays without changing the skill DAG  
- Standalone auditor; standalone `resolve_action` still works without Orchesto  

## How to use

See [Orchesto guide](../guides/orchesto.md) for setup, ship, brainstorm, and audit flows.

**Quick phrases**

- Ship a feature end-to-end — skill matches (installed with Hem Vault); answer the PRD ask  
- **setup orchesto** — optional repair / ensure `.plans/` / project-local skill copy  
- **brainstorm** / seat **brainstormer** — conversation seat (never auto)  
- **audit** — standalone auditor  

## Edge cases

- Never web-search for Orchesto setup — vault playbook only  
- Brainstormer and CPO are never auto-seated without an explicit user yes  
- PRD ask is mandatory before architect (hinting OK; skipping not)  
- Default skill home is **global** (`~/.cursor/skills`, `~/.agents/skills`, `~/.claude/skills`) — project-local copies are optional  
- Reviewer ≠ auditor  
- After 3 failed review rounds **on a phase**: stop; summarize blockers; do not start the next phase  
- Do **not** auto-start the next phase after `pass`  
- Do **not** implement every phase then review once  

## Related

- [Orchesto guide](../guides/orchesto.md)  
- [Guidance system](guidance.md)  
- Vault: `workflows/global/setup-orchesto.md`, `persona-*.md`  
- Contributor skill: `templates/skills/orchesto/`  
