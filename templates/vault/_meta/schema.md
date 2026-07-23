# Note schema

Use YAML frontmatter on notes when practical:

```yaml
---
type: inbox | project | pattern | stack | media | agent | external
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

## Scope

- `global` — applies across repos unless a project overrides
- `project` — true only for the git repo in `project:`

Keep bodies short and factual. Prefer append/update over rewrite when agents edit.

**When scope is unclear, ask** — do not assume global vs project.
