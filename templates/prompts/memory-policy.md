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
- **Instructions** = binding. **Suggestions** = soft (prefer, not must).
- Empty instruction bodies are normal — do **not** invent binding process.
- Skip on same-mode follow-ups and tiny one-off edits.

Miss → say so. Do not invent process.

Extend in the vault only: `actions/registry.md` (+ instruction/suggestion/workflow notes).

## Soft suggestions — auto-log (no magic words)

When the user states a **standing** preference/default (signals: “prefer”, “try to”, “lean”, “when making/doing”, “from now on”, soft “always”), **same turn** call `upsert_guidance` with `type: suggestion`, matching kind (`coding`, `commit`, …). Confirm briefly after logging.

Do **not** wait for “remember this” / “add to brain”.

## Binding instructions — explicit only

`instructions/` only when the user means hard process (“must”, “required”, “add as my coding rules”, “never skip”). Never seed instructions from vibes.

## Global vs project

- Project pack / project guidance have **precedence** over global for the same kind/action.
- Tool/SaaS → `stack/catalog/` + `recent`
- **Unclear scope → ask** before writing.

## Read before invent

Non-trivial work: `get_project_context` + search; process → `resolve_action` at mode start. Never fabricate vault facts.

## Write when durable (non-process)

Decisions, gotchas, tools, skills, corrections, patterns — when warranted. Soft prefs → suggestions (above). Binding process → instructions on explicit hard-rule ask only.

## Do not write

Secrets, ephemeral debug, one-off chatter, unverified guesses; do not invent binding instructions.

## Folders

`actions/` · `instructions/` · `suggestions/` · `workflows/` · `inbox/` · `external/` · `projects/<slug>/` · `patterns/` · `stack/` · `media/` · `agents/`
