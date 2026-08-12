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

## Related

- [Work desk feature](../features/work-desk.md)  
- [MCP tools](../reference/mcp-tools.md)  
