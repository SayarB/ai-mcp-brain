# Second brain memory policy

Vault: `{{VAULT_PATH}}`

MCP: `search_notes` · `read_note` · `remember` · `get_project_context` · `list_recent` · `track_tool`

Full policy: repo `templates/prompts/agent-memory.md`.

## Project = git repo

`projects/<slug>/` = one git repository (slug = git root folder name, or `_meta/projects-index.md` override).

## Global vs project

- This repo only → project pack (`decisions` / `tools` / `gotchas`)
- Tool/SaaS → `stack/catalog/` + `stack/recent.md` (`track_tool`)
- Cross-repo “always / in general” → `patterns/` / `agents/`
- **Unclear → ask** before writing (global vs this git repo). Park in `inbox/` only if asked.

## Read before invent

On non-trivial work: `get_project_context` + search. Never fabricate vault facts.

## Write when durable

Decisions, preferences, gotchas, tools you use/try, skills learned, corrections, cross-repo patterns, agent learnings. Short and factual.

## Do not write

Secrets, ephemeral debug, one-off chatter, unverified guesses. Prefer update over duplicate. Do not promote repo-only decisions to global without confirmation.

## Folders

`inbox/` · `external/` · `projects/<slug>/` · `patterns/` · `stack/catalog/` + `stack/recent.md` · `media/` · `agents/`
