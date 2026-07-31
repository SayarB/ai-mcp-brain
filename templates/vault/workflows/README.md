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

**Orchesto personas** (`persona-cpo` optional, `persona-architect`, `persona-implementor`, `persona-reviewer`) are behavioral seats used by the project **orchesto** skill. CPO runs only when the user says the feature needs a PRD; Orchesto always asks first.

**Standalone personas** (`persona-brainstormer`, `persona-auditor`) are seated on demand — not fixed Orchesto pipeline steps. Brainstormer is a **conversation** seat (critical tech-manager dialogue before CPO/architect; handoff brief only when the user proceeds). Auditor runs holistic audits (security, secrets, privacy, correctness, deps, code quality) of a repo or scoped area and writes `.audits/<scope-slug>/report.md`.

Personas are not `resolve_action` ids. Edit global defaults here; override per repo under `projects/<slug>/workflows/`.

Agents: `read_note` / `resolve_guidance` with `workflow_id`. Prefer existing playbooks over inventing new process.
