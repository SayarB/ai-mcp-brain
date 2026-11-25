---
type: memory
scope: global
tags: [memory, index]
---

# Atomic memories

Portable, ID-tracked memories written by coding harnesses via MCP (`add_memory`, `search_memory`, `update_memory`, `supersede_memory`, `delete_memory`).

Files here are grouped by category (`profile.md`, `preferences.md`, `decisions.md`, `facts.md`, `gotchas.md`). Repo-specific atomic memories live in `projects/<slug>/memories.md`.

Each entry uses an invisible metadata comment (`<!-- mem:id=... status=active ... -->`) so Obsidian renders clean Markdown while tools preserve stable IDs, provenance, and supersede history.
