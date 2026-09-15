---
type: workflow
tags: [meta]
updated: 2026-07-31
---

# Workflows

Multi-step playbooks and **persona profiles** (who the agent acts as).

- Global: `workflows/global/<id>.md`
- Per git repo: `projects/<slug>/workflows/<id>.md`
- Registry: [[_index]]

**Orchesto personas** (`persona-cpo` optional, `persona-architect`, `persona-implementor`, `persona-reviewer`) are behavioral seats. Shipped defaults live in the **orchesto** skill pack (`skills/orchesto/references/`). Hem inject safe-syncs the same files into `workflows/global/`. Customize per repo under `projects/<slug>/workflows/` (never auto-overwritten). CPO runs only when the user says the feature needs a PRD; Orchesto always asks first. Architect may split a large ask into **capability phases**; implementor and reviewer run one phase at a time. Next phase starts only when the user approves that phase’s plan.

**Standalone personas** (`persona-brainstormer`, `persona-auditor`) are seated on demand — not fixed Orchesto pipeline steps. Brainstormer is a **conversation** seat (grill then ideate; on a large app, map parts and go deep on each until nooks are handled; handoff brief only when the user proceeds). Auditor runs holistic audits (security, secrets, privacy, correctness, deps, code quality) of a repo or scoped area and writes `.audits/<scope-slug>/report.md`.

Personas are not `resolve_action` ids. Edit global defaults here; override per repo under `projects/<slug>/workflows/`.

Agents: `read_note` / `resolve_guidance` with `workflow_id`. Prefer existing playbooks over inventing new process.
