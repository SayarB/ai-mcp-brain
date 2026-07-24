# Soft suggestions layer

Decision (2026-07-24): standing soft directions live in `suggestions/`, not `instructions/`.

| Layer | Authority | Write trigger |
|-------|-----------|---------------|
| `instructions/` | Binding | Explicit hard process only |
| `suggestions/` | Soft (prefer / lean) | User standing prefs — auto-log, no magic words |
| `workflows/` | Playbooks | Explicit ask |

MCP: `upsert_guidance` type `suggestion`; `resolve_action` expands suggestions for the same kinds as instructions on the action.
