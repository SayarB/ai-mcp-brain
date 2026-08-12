# Feature: Guidance system

## Overview

Guidance is how ai-mcp-brain stores **how work should be done** without baking process into MCP code.

Three vault layers:

| Layer | Authority | Typical content |
|--------|-----------|-----------------|
| **Instructions** | Binding | Hard process (“must / required / never”) |
| **Suggestions** | Soft | Standing prefs (“prefer / lean / try to”) |
| **Workflows** | Playbooks | Multi-step procedures and persona seats |

An **action registry** (`actions/registry.md`) maps modes such as `coding`, `pr-review`, `commit`, and `git` to instruction kinds (and optional workflows). Agents enter a mode once with `resolve_action`, get a bundle, and follow it.

Extend forever by editing vault markdown. No server change required.

## How it works

**Paths**

- Global: `instructions/global/<kind>.md`, `suggestions/global/<kind>.md`, `workflows/global/<id>.md`
- Project: same under `projects/<slug>/…`
- Registry: `actions/registry.md` (+ optional `projects/<slug>/actions/registry.md`)

**Resolution**

1. Prefer `resolve_action` for coding / PR / commit / git (and custom registered actions)  
2. Else exact kind / `workflow_id` via `resolve_guidance`  
3. Else intent synonym or search inside guidance trees  
4. Miss → say so; do not invent process  

**Project overlays**

- Project notes precede global; when both exist, both may be returned — apply project first  
- Project action registry merges with global (project refs first, then global extras)  

**Suggestions auto-pair**

Registry lists `instructions:` and optional `workflows:`. Soft suggestion kinds mirror the instruction kinds on that action — there is no separate `suggestions:` field in v1.

**Mode-start policy**

Call `resolve_action` when entering a mode, switching mode, if this thread has no bundle yet, or on explicit reload. **Reuse** a same-action bundle already in the chat — do not re-call every turn. Skip tiny one-off edits.

## Capabilities

- Vault-owned process that grows over time  
- Mode bundles in one call  
- Soft vs binding semantics enforced in policy and tool messaging  
- Surgical upserts: append, replace section, remove section, full replace  
- Auto-log soft standing prefs the same turn (no “remember this” required)  
- Discovery via `list_actions` / `list_guidance`  
- Personas as workflows (Orchesto seats), not action ids  

## How to use

**Agent at mode start**

```
resolve_action  action=coding  project=<git-slug>
```

Follow the bundle: instructions = must; suggestions = prefer. Empty instruction bodies are normal.

**User states a soft preference**

> Prefer conventional commits from now on.

Agent same-turn: `upsert_guidance` with `type=suggestion`, `kind=commit` (ask scope if unclear).

**User states a hard rule**

> Never skip typecheck before commit — add that as my coding rules.

→ `type=instruction`, `kind=coding` (only when they mean binding).

**Extend with no code change**

1. Edit `actions/registry.md` (YAML fence, `schema: actions/v1`)  
2. Add instruction / suggestion / workflow notes  
3. Optionally add project overlays  
4. Next `resolve_action` picks it up  

See [Extending guidance](../guides/extending-guidance.md).

## Edge cases

- Empty instructions are intentional — agents must not fill from vibes  
- “Override” does not delete global; both expand, project first  
- Suggestion-only kinds (e.g. `planning`) do not appear in `resolve_action` unless an action lists that kind — use `resolve_guidance`  
- Personas ≠ actions — no `orchesto` action id  
- Prefer section edit modes to fix bad appends; full `replace` rewrites the whole note  
- Long notes may truncate in tool output — use `read_note` or `pointers_only` when needed  

## Related

- [Extending guidance](../guides/extending-guidance.md)  
- [Orchesto](orchesto.md)  
- [MCP tools](../reference/mcp-tools.md)  
- Vault: `actions/`, `instructions/`, `suggestions/`, `workflows/`  
