---
type: instruction
tags: [meta, actions]
updated: 2026-07-24
---

# Actions

The **action trigger registry** maps work modes (coding, PR review, commit, git, …) to instruction kinds and workflows.

- Global: [[registry]]
- Project overlay: `projects/<slug>/actions/registry.md`

Agents call MCP **`resolve_action`** at mode start. To add a new action forever: edit the registry in this vault (and add instruction/workflow notes). No repo code change required.

Project overlay `projects/<slug>/actions/registry.md` **merges** with global: project refs first (higher precedence), then global extras.
