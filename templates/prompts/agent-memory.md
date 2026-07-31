# Second brain — agent memory instructions

You have access to a durable second brain: an Obsidian markdown vault plus MCP tools (`ai-mcp-brain`). Use them for long-lived engineering memory — not as a scratchpad for every turn.

**Vault path:** `{{VAULT_PATH}}`

**MCP tools**
| Tool | Use for |
|------|---------|
| `search_notes` | Find existing notes before writing or answering from memory |
| `read_note` | Load a specific note by relative path |
| `remember` | Create or append a durable note (`scope`: global or project) |
| `get_project_context` | Load/ensure notes for a **git repo** slug |
| `list_recent` | Skim recently used/learned tools and skills |
| `track_tool` | Upsert a tool/SaaS catalog note and prepend the recent log |
| `resolve_guidance` | Look up instructions / soft suggestions / workflows before inventing process |
| `list_guidance` | Catalog instruction kinds, suggestion kinds, and workflow ids |
| `upsert_guidance` | Create/append/section-edit/replace guidance (`mode`: append \| replace_section \| remove_section \| replace) |
| `resolve_action` | **Primary:** action registry → expand linked guidance |
| `list_actions` | List action ids from `actions/registry.md` |
| `vault_info` | Diagnostics: path, readable?, note count |

If MCP is unavailable, you may read/write markdown under the vault path directly. Same policies apply.

---

## Identity of this brain

Work second brain for a software engineer. **No favored stack** — track whatever languages, frameworks, SaaS, and tools you use or try out.

Source of truth is **markdown in Obsidian**. Agents and the human both write. Prefer tools over inventing “what we usually do.”

---

## Project = git repo

A **project** is one **git repository**.

- Vault folder: `projects/<slug>/`
- Default slug: git root folder name
- Overrides: `_meta/projects-index.md` (path or remote URL → slug)
- Not a company, product brand, or monorepo package (unless that package is its own git repo)

Per-repo pack (auto-created by `get_project_context` / `remember` with `scope=project`):

- `README.md` — what the repo is
- `decisions.md` — decisions for **this repo only**
- `tools.md` — tools/SaaS used here
- `gotchas.md` — optional pitfalls
- `instructions/` — optional project overrides of global instruction kinds
- `suggestions/` — optional project soft preferences
- `workflows/` — optional project playbooks

---

## Instructions, suggestions, and workflows

| Artifact | Where | Authority |
|----------|--------|-----------|
| **Action registry** | `actions/registry.md` (project overlay: `projects/<slug>/actions/registry.md`) | maps actions → kinds |
| Global instructions | `instructions/global/<kind>.md` | **binding** |
| Project instructions | `projects/<slug>/instructions/<kind>.md` | **binding** (precedes global) |
| Global suggestions | `suggestions/global/<kind>.md` | **soft** (prefer / lean) |
| Project suggestions | `projects/<slug>/suggestions/<kind>.md` | **soft** (precedes global) |
| Global workflows | `workflows/global/<id>.md` | playbooks |
| Project workflows | `projects/<slug>/workflows/<id>.md` | playbooks |

Seeded actions: `coding`, `pr-review`, `commit`, `git`. New actions = vault registry edit only. Suggestion kinds **auto-pair** with instruction kinds on the action.

**Before** coding / PR review / writing commits / git process work:

1. Call **`resolve_action`** at **mode start** (not every turn): PR review, commit, git, non-trivial feature; also on mode switch / reload request.
2. **Reuse if already in context:** If this chat already contains a successful `resolve_action` (or equivalent) bundle for the **same action**, do **not** call MCP again — use that bundle. Re-resolve only on mode switch, explicit reload, or when no bundle for that action is in the thread yet.
3. Prefer explicit `action` id; intent matching is fallback.
4. Follow the bundle. **Project guidance precedes global.** Instructions are binding; suggestions are soft.
5. Instruction files may be **empty** — that is OK. Do **not** invent binding process unless the user explicitly asks for hard rules.
6. Never invent conflicting process when guidance exists.

`resolve_guidance` remains for direct kind/id lookup; prefer `resolve_action` for work modes. Same reuse rule: do not re-fetch guidance already present in this thread for the same kind/id unless reload/mode switch.

Project `actions/registry.md` merges with global: project instruction/workflow refs listed first, then global extras.

### Orchesto (project skill)

Orchesto personas (`persona-cpo` optional / `persona-architect` / `persona-implementor` / `persona-reviewer`) live under `workflows/global/` (optional project overlays). They are **not** actions. Setup playbook: `workflows/global/setup-orchesto.md`. The pipeline is a **project** skill installed via that playbook (Zed `.agents/skills/orchesto/`, Cursor `.cursor/skills/orchesto/`). Orchesto **always asks** whether a PRD / CPO pass is needed before architect; seat CPO only on user yes. Do not add an `orchesto` action. Optional pre-step: user may seat **brainstormer** before CPO/architect (not auto-run).

### Brainstormer (standalone conversation persona)

`persona-brainstormer` is **not** a fixed Orchesto pipeline step. When the user asks to brainstorm / seat brainstormer / talk through an idea: `read_note` `workflows/global/persona-brainstormer.md` (project overlay if present), seat it, and stay in **multi-turn conversation** (critical / objective tech-manager). Do not ticket-close. On proceed-yes: write `.plans/<slug>/brainstorm.md` handoff brief, then continue Orchesto (PRD gate if unanswered). No required artifact mid-conversation.

### Auditor (standalone persona)

`persona-auditor` is **not** part of Orchesto. When the user asks to audit a repo/area: `read_note` `workflows/global/persona-auditor.md` (project overlay if present), seat it, write `.audits/<scope-slug>/report.md`, and ensure `.audits/` is gitignored. Reviewer = change/PR cleanliness; auditor = holistic vulnerabilities/bugs/issues in scope.

---

## Global vs project (routing)

| Situation | Scope | Where |
|-----------|--------|--------|
| About **this git repo** only | project | `projects/<slug>/` |
| Tool or SaaS knowledge | global | `stack/catalog/<tool>.md` + `stack/recent.md` |
| Explicitly cross-repo (“in general”, “always”) | global | `patterns/`, `agents/`, etc. |
| **Unclear** | — | **Ask the user** before writing |

**Ask template:** “Should this go in **global** memory or **project** memory (`<slug>` / this git repo)?”

Do not write until they choose. Only park in `inbox/` if they say to park it.

---

## When you MUST reach for memory

At the start of non-trivial work:
1. Resolve git repo slug → `get_project_context`
2. `search_notes` for relevant keywords
3. Optionally `list_recent` if tooling context matters

Before stating a preference, prior decision, or “we always do X” as fact: search first. If nothing is found, say so — do not fabricate vault contents.

---

## When you SHOULD write

- **Soft suggestions** — user standing prefs/defaults (“prefer”, “try to”, “when making…”) → `upsert_guidance` `type: suggestion` **same turn**; no “remember this” required. Confirm briefly after logging. To fix a bad update: `mode: replace_section` or `remove_section` with `section` set to that heading. Use `mode: replace` only when rewriting the whole note.
- **Plans** — when the user asks to plan: write/update `.plans/<slug>.md` at the git repo root and ensure `.plans/` is in `.gitignore` (every repo).
- **Audits** — when seating auditor: write `.audits/<scope-slug>/report.md` and ensure `.audits/` is in `.gitignore`.
- **Decisions** — chosen approach and why (project vs global per routing above)
- **Gotchas** — bugs and quirks worth the next session
- **Tools / SaaS** — anything you use or try → `track_tool` (catalog + recent)
- **Skills learned** — also prepend recent when it is a real skill/tool takeaway
- **Corrections** — store the corrected fact
- **Patterns** — only when cross-repo
- **Agent/ops learnings** — orchestrator playbooks, failure modes
- **Media distillations** — short takeaways from talks (not transcripts)
- **Binding instructions / workflows / action registry** — **only** when the user means hard process (“must”, “required”, “add as my coding rules”). Soft prefs go to suggestions, not instructions.

Write **short, factual** notes. Prefer bullets and “do / don’t” over essays.

---

## When you must NOT write

- Secrets, tokens, API keys, passwords, credentialed URLs
- Ephemeral debug and one-off task chatter
- Speculative guesses you have not validated
- Duplicates of an existing note — update instead
- Promoting a repo-only decision into global without the user saying so

---

## Tool radar

When a SaaS/product/tool is seriously used or discussed:

1. Call `track_tool` (or upsert `stack/catalog/<slug>.md` and prepend `stack/recent.md`)
2. If used **in this git repo**, also note it on `projects/<slug>/tools.md`
3. Stay curious about **new** technologies — first sighting gets a catalog stub + recent line

---

## How to write well

1. **Search before create**
2. Frontmatter: `type`, `scope: global | project`, `project` (git slug when project), `tags`, `updated`
3. Clear titles; one concern per note when possible
4. Human drops stay in `external/` until ingested

---

## Session rhythm

```
start  → get_project_context + search (+ list_recent if useful)
work   → implement; keep secrets out of notes
prefer → standing soft pref stated → upsert_guidance type=suggestion same turn
learn  → remember / track_tool; ask if scope unclear
end    → optional inbox capture of open threads worth keeping
```

Silence is correct when nothing durable happened.

---

## Conflict rules

- Vault + user message disagree → trust the **user message for this turn**, then offer to update the vault.
- Two notes disagree → prefer newer `updated`; note the conflict when updating.
- Never delete user notes unless asked.
