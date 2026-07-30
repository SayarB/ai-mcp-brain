# Note schema

Use YAML frontmatter on notes when practical:

```yaml
---
type: inbox | project | pattern | stack | media | agent | external | instruction | suggestion | workflow
kind: coding | pr-review | commit | git | <extensible>   # instructions / suggestions
id: optional-workflow-id                                 # workflows
weight: soft                                             # suggestions only
scope: global | project
project: optional-git-repo-slug
tags: []
updated: YYYY-MM-DD
---
```

## Types

- `inbox` — unsorted capture
- `project` — one **git repository**
- `pattern` — reusable approach (cross-repo)
- `stack` — tool or SaaS note
- `media` — distilled takeaway from a talk/video
- `agent` — agent/orchestrator learning
- `external` — stub pointing at a dropped file
- `instruction` — binding standing rules for a kind of work (coding, commit, …)
- `suggestion` — soft preferences for a kind (prefer / lean; not must)
- `workflow` — multi-step playbook **or** persona profile (`id: persona-*` for seats: Orchesto or standalone)

## Scope

- `global` — applies across repos unless a project overrides
- `project` — true only for the git repo in `project:`

## Guidance resolution

1. Prefer **`resolve_action`** via `actions/registry.md` for coding / PR / commit / git
2. Else project `instructions/` / `suggestions/` / `workflows/` for kind/id
3. Else global `instructions/global/`, `suggestions/global/`, or `workflows/global/`
4. Else search; if still none, say so — do not invent process

Authority: **instructions** are binding when present; **suggestions** are soft defaults (prefer, may bend for quality).

### Actions registry

See `actions/registry.md` (`schema: actions/v1`). Extend in the vault without changing code. Suggestion kinds auto-pair with instruction kinds on the action (no separate registry field).

Keep bodies short and factual. Prefer append/update over rewrite when agents edit.

**When scope is unclear, ask** — do not assume global vs project.
