# Guide: Work desk

> **WIP — not published on the Hem Vault site.** Kept in-repo for development.

## Without Jira

You can still use a curated today list:

| Phrase | Call |
|--------|------|
| what’s left on the list / today’s todos | `work_today` `op=list` |
| add “ship docs” to today | `work_today` `op=add` `text=ship docs` |
| mark it done (after you confirm) | `work_today` `op=complete` |

Prefer tools over hand-editing `work/today.md` on the happy path.

## With Jira

1. Copy `.env.example` → `.env`  
2. Set `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`  
3. Optionally uncomment `[jira]` in `config.toml`  
4. Restart MCP  

| Phrase | Call |
|--------|------|
| what’s on my plate | `work_plate` (default `scope=sprint`) |
| pull / refresh Jira | `jira_assigned` `refresh=true` |
| show every assigned open issue | ask first, then `scope=all` |
| put AD-206 on today | `work_today` `op=add` `key=AD-206` |

## Agent rules (product policy)

- Do not ambient-poll Jira  
- Do not auto-add from `jira_only`  
- Ask yes/no before `complete` when work looks done  
- Default scope = sprint; ask before `all`  
- Prefer `work_*` / `jira_assigned` over raw vault edits  

## Reading a plate result

- **on_today** — in Jira and open on today  
- **jira_only** — assigned but not on today (informational)  
- **today_only** — on today but not in the Jira snapshot (free-text or non-matching keys)  

Promote only what you choose:

> Add AD-210 and AD-211 to today from the plate.

## Day log

Completes (and rollover of prior-day completions) append to `work/log/YYYY-MM-DD.md`. Optional `log` param customizes the complete line.

### End-of-day Jira worklogs (`work_log`)

Capture is explicit and harness-agnostic: `brain work-event` CLI, `work_log op=event`, and a git-commit harvest at review. Cursor session hooks are optional.

Time is **activity buckets** (15m), not how long a chat stayed open. Parallel work splits a shared bucket.

At review the tool also fetches **your** Jira worklogs for that day. Keys that already have time show `overlap` and `already_logged_minutes`. Push posts only the **delta** unless you set `force: true`. If that fetch fails, push refuses — better a missed log than a duplicate.

Do **not** log time from the per-task Jira rule anymore; comments and status transitions can stay immediate. Time is EOD-batch only.

### Sprint releases (`jira_release`)

You initiate every release. The agent lists sprints and issues; you supply the version name and the exact keys. The version is created unreleased; releasing it is a separate step. Needs *Manage Versions* / *Administer Projects* on the project.

## Related

- [Work desk feature](../features/work-desk.md)  
- [MCP tools](../reference/mcp-tools.md)  
