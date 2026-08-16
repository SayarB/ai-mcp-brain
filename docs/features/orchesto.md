# Feature: Orchesto & personas

## Overview

**Orchesto** is a multi-phase delivery skill (installed with Hem Vault): optional brainstorm → always-ask PRD gate → optional CPO → architect → implementor → reviewer → fix loop (≤3) → summary.

It is for shipping a feature end-to-end with plan, validations, and review — not tiny one-off edits or a lone PR review. It is **not** Orca / orca-cli.

| Owned by | What |
|----------|------|
| **Vault (MCP)** | Persona bodies, setup/repair playbook, skill template note, coding/PR process via `resolve_action` |
| **Global skill** | Pipeline procedure only — who seats when, gates, artifact paths, fix-loop cap (installed by `setup` / `inject`) |

## Personas

| Seat | Role | In Orchesto? |
|------|------|--------------|
| **Brainstormer** | Sharpens the product/change idea (design-tree grill; every question must improve it); handoff brief on proceed | Optional pre-step (user-invoked only) |
| **CPO** | PRD / product requirements | Optional (user yes at PRD gate) |
| **Architect** | `plan.md` + `validations.md` | Required |
| **Implementor** | Build against plan/validations | Required |
| **Reviewer** | Change gate vs validations → `review-report.md` | Required |
| **Auditor** | Holistic repo/area audit → `.audits/` | Standalone (not Orchesto) |

Personas are workflows under `workflows/global/` (project overlays win). They are **not** `resolve_action` ids.

## How it works

```
[brainstormer?] ──proceed──► PRD gate (always ask)
                              │ yes → CPO → prd.md → user approves
                              │ no  ──────────────────────────────┐
                              ▼                                   ▼
                          architect → plan + validations → user approves
                              ▼
                          implementor → code
                              ▼
                          reviewer → review-report.md
                              │ changes_required & rounds < 3 → implementor ↔ reviewer
                              │ pass → summary
                              │ still failing after 3 → stop with blockers
```

**Hard stops:** brainstormer proceed-yes; CPO PRD approval (if opted in); architect plan/validation approval.

**Artifacts** under `.plans/<feature-slug>/` (gitignored):

| File | Author |
|------|--------|
| `brainstorm.md` | brainstormer (handoff only) |
| `prd.md` | CPO (if opted in) |
| `plan.md` | architect |
| `validations.md` | architect |
| `review-report.md` | reviewer (each round) |

Auditor writes `.audits/<scope-slug>/report.md` separately.

## Capabilities

- Sized plans with checkable validations  
- Optional product shaping (brainstormer and/or CPO)  
- Validation-driven review with `pass` / `changes_required`  
- Bounded fix loop  
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
- After 3 failed review rounds: stop; summarize blockers  

## Related

- [Orchesto guide](../guides/orchesto.md)  
- [Guidance system](guidance.md)  
- Vault: `workflows/global/setup-orchesto.md`, `persona-*.md`  
- Contributor skill: `templates/skills/orchesto/`  
