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
| log this / note what I did | `work_log` op=event (key only if I supplied it) |
| log everything I did today | `work_log` op=review, then ask me to confirm keys/minutes, then op=push |
| cut a release | `jira_release` — list, preview, then wait for my name + keys |

## Sprint vs all assigned

- **Default:** open sprints only (`sprint in openSprints()`, assignee=me, not Done).
- If the user may want **every** assigned open issue (including backlog / no sprint): **ask first**, then `scope=all`.
- Do not silently fetch all assignments.

Do **not** raw Read+Write `work/today.md` on the happy path. Do **not** auto-add Jira issues to today. Do **not** silent-tick — ask yes/no first when work looks done and matches an open today item.

When a session has unattributed work, ask which Jira key it belongs to (every turn until answered, including “leave it for EOD”). Never infer a key from a branch, commit, or note text. After I confirm a branch-key candidate once, reuse it for that session.

Time worklogs go through `work_log` at end of day only — not per completed task. Comments / status transitions may still be immediate.

On `work_log` review: show derived minutes, evidence, already-logged Jira time, and overlaps. Wait for my edited list before `op=push`.

On `jira_release`: never pick issues or invent a version name. Create unreleased; release only when I say so.
