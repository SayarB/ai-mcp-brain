# Note schema

Use YAML frontmatter on notes when practical:

```yaml
---
type: inbox | project | pattern | stack | media | agent | external | instruction | workflow
kind: coding | pr-review | commit | git | <extensible>   # instructions
id: optional-workflow-id                                 # workflows
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
- `instruction` — standing rules for a kind of work (coding, commit, …)
- `workflow` — multi-step playbook

## Scope

- `global` — applies across repos unless a project overrides
- `project` — true only for the git repo in `project:`

## Guidance resolution

1. Prefer **`resolve_action`** via `actions/registry.md` for coding / PR / commit / git
2. Else project `instructions/` or `workflows/` for kind/id
3. Else global `instructions/global/` or `workflows/global/`
4. Else search; if still none, say so — do not invent process

### Actions registry

See `actions/registry.md` (`schema: actions/v1`). Extend in the vault without changing code.

Keep bodies short and factual. Prefer append/update over rewrite when agents edit.

**When scope is unclear, ask** — do not assume global vs project.
