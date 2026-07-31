# Second brain memory policy

Vault: `{{VAULT_PATH}}`

MCP: `resolve_action` · `list_actions` · `resolve_guidance` · `list_guidance` · `upsert_guidance` · `search_notes` · `read_note` · `remember` · `get_project_context` · `list_recent` · `track_tool` · `vault_info`

Full policy: repo `templates/prompts/agent-memory.md`.

## Project = git repo

`projects/<slug>/` = one git repository (slug = git root folder name, or `_meta/projects-index.md` override).

## Actions (process) — mode start only

Call **`resolve_action`** when **entering a mode** (PR review, commit, git ops, non-trivial feature/refactor), on mode switch, if not yet resolved this thread, or if the user asks to reload rules.

**Reuse if already in context:** Before calling `resolve_action`, check this chat for an earlier successful bundle for the **same action** (tool result or quoted guidance). If it is already present and you have not switched mode, **do not call MCP again** — follow that bundle. Re-resolve only on mode switch, user reload request, or when this thread has no bundle for that action yet.

- Prefer explicit `action` id; soft intent is fallback.
- Follow returned guidance. **Project overrides / precedes global.**
- **Instructions** = binding. **Suggestions** = soft (prefer, not must).
- Empty instruction bodies are normal — do **not** invent binding process.
- Skip on same-mode follow-ups and tiny one-off edits.

Miss → say so. Do not invent process.

Extend in the vault only: `actions/registry.md` (+ instruction/suggestion/workflow notes).

## Soft suggestions — auto-log (no magic words)

When the user states a **standing** preference/default (signals: “prefer”, “try to”, “lean”, “when making/doing”, “from now on”, soft “always”), **same turn** call `upsert_guidance` with `type: suggestion`, matching kind (`coding`, `planning`, `commit`, …). Confirm briefly after logging.

Do **not** wait for “remember this” / “add to brain”.

To **fix** wrongly placed or incorrect guidance: prefer `upsert_guidance` with `mode: replace_section` or `remove_section` and `section: "<heading text>"` so other sections stay untouched. Use `mode: replace` when intentionally rewriting the **entire** note. Default remains append.

## Plans (every git repo)

When the user asks to **plan** something: write/update a markdown file under **`.plans/`** at the repo root, and ensure **`.plans/`** is in that repo’s **`.gitignore`**. Do not rely on chat-only or `~/.cursor/plans` as the sole copy.

## Setup orchesto

When the user asks to **setup orchesto**: call MCP `read_note` on `workflows/global/setup-orchesto.md` and follow it. **Do not web-search.** Orchesto ≠ Orca/orca-cli.

## Brainstormer (conversation persona)

When the user asks to **brainstorm** / seat **brainstormer** / talk through an idea: `read_note` `workflows/global/persona-brainstormer.md` (project overlay if present), seat that persona, and stay in multi-turn critical conversation. Do not auto-seat. On proceed-yes: write `.plans/<slug>/brainstorm.md`, then continue Orchesto (PRD gate if unanswered). Brainstormer is **not** a fixed Orchesto pipeline step and is **not** CPO/architect.

## Audit (auditor persona)

When the user asks to **audit** a repo/area (or to seat **auditor**): `read_note` `workflows/global/persona-auditor.md` (project overlay if present), seat that persona, and write `.audits/<scope-slug>/report.md`. Ensure `.audits/` is in that repo’s `.gitignore`. Auditor is **not** Orchesto and is **not** the PR reviewer — holistic findings, report-first.

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
