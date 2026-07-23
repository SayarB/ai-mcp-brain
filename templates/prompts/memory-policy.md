# Second brain memory policy

Vault: `{{VAULT_PATH}}`

MCP: `resolve_action` · `list_actions` · `resolve_guidance` · `list_guidance` · `upsert_guidance` · `search_notes` · `read_note` · `remember` · `get_project_context` · `list_recent` · `track_tool` · `vault_info`

Full policy: repo `templates/prompts/agent-memory.md`.

## Project = git repo

`projects/<slug>/` = one git repository (slug = git root folder name, or `_meta/projects-index.md` override).

## Actions (process) — mode start only

Call **`resolve_action`** when **entering a mode** (PR review, commit, git ops, non-trivial feature/refactor), on mode switch, if not yet resolved this thread, or if the user asks to reload rules.

- Prefer explicit `action` id; soft intent is fallback.
- Follow returned guidance. **Project overrides / precedes global.**
- Empty instruction bodies are normal — do **not** invent or fill process docs unless the user asks.
- Skip on same-mode follow-ups and tiny one-off edits.

Miss → say so. Do not invent process.

Extend in the vault only: `actions/registry.md` (+ instruction/workflow notes). Project overlay: `projects/<slug>/actions/registry.md` (merged; project refs first).

## Empty until the user adds

Instruction/workflow notes start empty. **Only** create or fill them when the user explicitly asks (e.g. “remember this as my commit rules”, “add coding instructions”). Never seed process from vibes.

## Global vs project

- Project pack / project instructions have **precedence** over global for the same kind/action.
- Tool/SaaS → `stack/catalog/` + `recent`
- **Unclear scope → ask** before writing.

## Read before invent

Non-trivial work: `get_project_context` + search; process → `resolve_action` at mode start. Never fabricate vault facts.

## Write when durable (non-process)

Decisions, preferences, gotchas, tools, skills, corrections, patterns — when warranted. Process docs only on user request.

## Do not write

Secrets, ephemeral debug, one-off chatter, unverified guesses; do not auto-fill empty instructions.

## Folders

`actions/` · `instructions/` · `workflows/` · `inbox/` · `external/` · `projects/<slug>/` · `patterns/` · `stack/` · `media/` · `agents/`
