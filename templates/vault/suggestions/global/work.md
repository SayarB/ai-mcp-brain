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
| what’s on my plate / on my plate today | `work_plate` |
| what’s left on the list / todos for the day / today’s todos | `work_today` op=list |
| pull/get/refresh Jira | `jira_assigned` refresh=true (or `work_plate` refresh=true) |
| add X to today / I’ll handle this today | `work_today` op=add |
| yes (to a tick-off ask) | `work_today` op=complete |

Do **not** raw Read+Write `work/today.md` on the happy path. Do **not** call Jira except for plate (cache-aware) or explicit pull. Do **not** auto-add Jira issues to today. Do **not** silent-tick — ask yes/no first when work looks done and matches an open today item.
