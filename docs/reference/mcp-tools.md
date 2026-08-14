# Reference: MCP tools

Server name: **`ai-mcp-brain`**. Stdio MCP. Logs go to stderr only.

Call tools through your editor’s MCP integration. Prefer these over inventing vault facts or process.

---

## Diagnostics

### `vault_info`

Diagnostics: resolved vault path, whether readable, note count, `AGENTS.md` presence.

**Params:** none  

**Use when:** install smoke-check, vault access looks broken  

---

## Memory

### `search_notes`

Full-text keyword search across the vault. Ranked paths, titles, snippets.

| Param | Required | Notes |
|-------|----------|--------|
| `query` | yes | Keywords |
| `limit` | no | 1–50, default 10 |

**Not** semantic/embedding search. All terms must appear.

### `read_note`

Read one note by relative vault path.

| Param | Required | Notes |
|-------|----------|--------|
| `path` | yes | e.g. `projects/my-repo/decisions.md` |

Absolute paths and `../` escapes are blocked.

### `remember`

Write durable knowledge (create or append).

| Param | Required | Notes |
|-------|----------|--------|
| `title` | yes | Note title |
| `content` | yes | Markdown body |
| `scope` | no | `global` \| `project` — ask if unclear |
| `project` | if project | Git repo slug |
| `projectFile` | no | `README` \| `decisions` \| `tools` \| `gotchas` (default decisions) |
| `folder` | global only | `inbox` \| `projects` \| `patterns` \| `stack` \| `media` \| `agents` |
| `tags` | no | string[] |
| `filename` | no | Global filename stem |

Do not store secrets. Soft prefs → `upsert_guidance`; binding process → instructions.

### `get_project_context`

Ensure `projects/<slug>/` pack exists and return its related notes.

| Param | Required | Notes |
|-------|----------|--------|
| `project` | yes | Git repo slug (usually folder name) |
| `limit` | no | 1–50, default 20 |

---

## Tool radar

### `track_tool`

Upsert `stack/catalog/<slug>.md`, prepend `stack/recent.md`, optionally update project `tools.md`.

| Param | Required | Notes |
|-------|----------|--------|
| `name` | yes | Tool or SaaS name |
| `summary` | yes | What/why or what you learned |
| `slug` | no | Catalog filename slug |
| `project` | no | Also updates that pack’s `tools.md` |
| `tags` | no | string[] |

### `list_recent`

Newest entries from `stack/recent.md`.

| Param | Required | Notes |
|-------|----------|--------|
| `limit` | no | 1–50, default 20 |

---

## Guidance & actions

### `resolve_action`

**Primary** entry for coding / PR review / commit / git. Reads `actions/registry.md`, expands linked instructions + soft suggestions (+ workflows). Project overlays merge in. Prefer over inventing process.

| Param | Required | Notes |
|-------|----------|--------|
| `action` | preferred | `coding` \| `pr-review` \| `commit` \| `git` \| custom |
| `intent` | fallback | Free text if id unknown |
| `project` | no | Git slug |
| `pointers_only` | no | Paths only if true; default expands markdown |

Call at **mode start**; reuse same-action bundle already in the thread.

### `list_actions`

List action ids from the registry (+ project overlay if provided).

| Param | Required | Notes |
|-------|----------|--------|
| `project` | no | Git slug for overlay |

### `resolve_guidance`

Look up instruction / suggestion / workflow by kind, `workflow_id`, and/or intent.

| Param | Required | Notes |
|-------|----------|--------|
| `kind` | no | e.g. `coding`, `commit` |
| `workflow_id` | no | Under `workflows/` |
| `type` | no | `instruction` \| `suggestion` \| `workflow` |
| `intent` | no | Free-text fallback |
| `project` | no | Project overlays |

With `kind` and no `type`, loads instruction + suggestion.

### `list_guidance`

List instruction kinds, suggestion kinds, and workflow ids (global + optional project).

| Param | Required | Notes |
|-------|----------|--------|
| `project` | no | If set, include that project’s overlays; if omitted, may include all projects |

### `upsert_guidance`

Create or surgically update guidance.

| Param | Required | Notes |
|-------|----------|--------|
| `type` | yes | `instruction` \| `suggestion` \| `workflow` |
| `scope` | yes | `global` \| `project` |
| `content` | usually | Required except `remove_section` |
| `kind` | for instr/sugg | e.g. `coding` |
| `workflow_id` | for workflow | id under `workflows/` |
| `project` | if project | Git slug |
| `mode` | no | `append` (default) \| `replace` \| `replace_section` \| `remove_section` |
| `section` | for `*_section` | Heading text to target |
| `title`, `tags` | no | |

Soft standing prefs → `suggestion`. Binding → `instruction` only for hard rules.

---

## Work desk

### `jira_assigned`

Fetch or return cached assigned issues. Default `scope=sprint`. Does not modify `work/today.md`.

### `work_today`

Vault-only today list. `op=list|add|complete`. Never calls Jira.

### `work_plate`

Diff Jira snapshot vs today. Never auto-adds.

### `work_log`

Daily time ledger at `work/log/YYYY-MM-DD.md`.

| `op` | What |
|------|------|
| `event` | Append a timestamped event. Pass `key` only when the user supplied it — never infer. |
| `review` | Derive 15m activity buckets, harvest today's git commits, fetch **your** Jira worklogs for the day, flag overlaps. |
| `push` | Post native Jira worklogs for an **explicit** `entries` array. Default is delta (`requested − already_logged`). `force=true` is the only override. Refuses if today's worklogs cannot be fetched. |

Time is activity buckets, not elapsed session span. Hooks are optional.

### `jira_release`

User-initiated sprint releases. Needs *Manage Versions* / *Administer Projects*.

| `op` | What |
|------|------|
| `sprints` | List sprints for a project |
| `preview` | List a sprint's issues (no selection) |
| `create` | Requires user-supplied `name` + `keys`. Creates an **unreleased** version, stamps `fixVersion` per key. |
| `release` | Mark a version released (`versionId`, optional `releaseDate`) |

Never invent a version name or choose issues.

---

## Related

- [How it works](../how-it-works.md)  
- [Features index](../README.md#features)  
- [Getting started](../guides/getting-started.md)  
