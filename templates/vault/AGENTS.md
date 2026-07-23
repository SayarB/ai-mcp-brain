# Agent guide — My Brain vault

This Obsidian vault is the source of truth for durable work memory.

## Scopes

- **Project** = one **git repository** → `projects/<slug>/`
- **Global** = cross-repo → `stack/`, `patterns/`, `media/`, `agents/`
- **When in doubt, ask** whether a fact belongs in global or project memory.

## Where to write

| Kind | Folder |
|------|--------|
| Quick capture / unsorted | `inbox/` |
| User-dropped files (before ingest) | `external/` |
| Git-repo context | `projects/<slug>/` |
| Cross-repo approaches | `patterns/` |
| Tools & SaaS (any stack) | `stack/catalog/` + `stack/recent.md` |
| Distilled talk takeaways | `media/` |
| Agent/orchestrator playbooks | `agents/` |
| Schema / indexes | `_meta/` |

## When to write

- Durable decisions, preferences, gotchas, corrected misconceptions
- Tools/SaaS you use or try (catalog + recent)
- Patterns worth another session

## When not to write

- Ephemeral debug noise
- Secrets, tokens, credentials
- One-off task chatter with no lasting value

## How to write

1. Prefer updating an existing note over creating a duplicate.
2. Use light frontmatter — see `_meta/schema.md`.
3. Link related notes with `[[wikilinks]]` when useful.
4. Put raw user drops in `external/`; promote via `brain ingest`.
