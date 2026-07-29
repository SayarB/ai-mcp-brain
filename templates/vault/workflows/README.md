---
type: workflow
tags: [meta]
updated: 2026-07-24
---

# Workflows

Multi-step playbooks and **persona profiles** (who the agent acts as).

- Global: `workflows/global/<id>.md`
- Per git repo: `projects/<slug>/workflows/<id>.md`
- Registry: [[_index]]

**Personas** (`persona-architect`, `persona-implementor`, `persona-reviewer`) are behavioral seats used by the project **orchesto** skill. They are not `resolve_action` ids. Edit global defaults here; override per repo under `projects/<slug>/workflows/`.

Agents: `read_note` / `resolve_guidance` with `workflow_id`. Prefer existing playbooks over inventing new process.
