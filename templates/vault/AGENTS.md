# Agent guide — My Brain vault

This Obsidian vault is the source of truth for durable work memory.

## Scopes

- **Project** = one **git repository** → `projects/<slug>/`
- **Global** = cross-repo → `stack/`, `patterns/`, `instructions/`, `workflows/`, `media/`, `agents/`
- **When in doubt, ask** whether a fact belongs in global or project memory.

## Where to write

| Kind | Folder |
|------|--------|
| Quick capture / unsorted | `inbox/` |
| User-dropped files (before ingest) | `external/` |
| Git-repo context | `projects/<slug>/` |
| Standing process rules | `instructions/global/<kind>.md` |
| Multi-step playbooks | `workflows/global/<id>.md` |
| Action → guidance map | `actions/registry.md` |
| Cross-repo approaches | `patterns/` |
| Tools & SaaS (any stack) | `stack/catalog/` + `stack/recent.md` |
| Distilled talk takeaways | `media/` |
| Agent/orchestrator learnings | `agents/` |
| Schema / indexes | `_meta/` |

## Guidance first

Before coding / PR review / commits / git process: resolve existing instruction/workflow (`resolve_guidance`). Follow hits; do not invent conflicting process.

## When to write

- Durable decisions, preferences, gotchas, corrected misconceptions
- Tools/SaaS you use or try (catalog + recent)
- Patterns and new/updated instructions & workflows

## When not to write

- Ephemeral debug noise
- Secrets, tokens, credentials
- One-off task chatter with no lasting value

## How to write

1. Prefer updating an existing note over creating a duplicate.
2. Use light frontmatter — see `_meta/schema.md`.
3. Link related notes with `[[wikilinks]]` when useful.
4. Put raw user drops in `external/`; promote via `brain ingest`.
