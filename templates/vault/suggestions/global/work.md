---
type: suggestion
kind: work
weight: soft
scope: global
tags: [work, jira, today]
updated: 2026-08-04
---

# Work desk suggestions (global)

## Phrases → tools

| You say | Tool |
|---------|------|
| what’s on my plate / on my plate today | `work_plate` (default **scope=sprint**) |
| what’s left on the list / todos for the day / today’s todos | `work_today` op=list |
| pull/get/refresh Jira | `jira_assigned` refresh=true (default sprint) |
| add X to today / I’ll handle this today | `work_today` op=add |
| yes (to a tick-off ask) | `work_today` op=complete |

## Sprint vs all assigned

- **Default:** open sprints only (`sprint in openSprints()`, assignee=me, not Done).
- If the user may want **every** assigned open issue (including backlog / no sprint): **ask first**, then `scope=all`.
- Do not silently fetch all assignments.

Do **not** raw Read+Write `work/today.md` on the happy path. Do **not** call Jira except for plate (cache-aware) or explicit pull. Do **not** auto-add Jira issues to today. Do **not** silent-tick — ask yes/no first when work looks done and matches an open today item.
