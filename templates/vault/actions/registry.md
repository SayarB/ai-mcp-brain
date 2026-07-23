---
type: instruction
tags: [actions, registry]
updated: 2026-07-24
---

# Action registry

Machine-readable map of actions → instructions / workflows. Schema `actions/v1`.

Edit this file in Obsidian to extend the system. Project overlays may live at `projects/<slug>/actions/registry.md`.

```yaml
schema: actions/v1
actions:
  coding:
    description: Implementation and code changes
    aliases:
      - implement
      - code
      - refactor
    instructions:
      - coding
    workflows: []
  pr-review:
    description: Review a pull request
    aliases:
      - review-pr
      - code-review
      - pull-request-review
    instructions:
      - pr-review
    workflows: []
  commit:
    description: Write commit messages
    aliases:
      - commit-message
      - git-commit
    instructions:
      - commit
    workflows: []
  git:
    description: Branching and git operations
    aliases:
      - branch
      - rebase
      - git-ops
    instructions:
      - git
    workflows: []
```
