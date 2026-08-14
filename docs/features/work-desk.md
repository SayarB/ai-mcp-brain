# Feature: Work desk

> **WIP — not published on the Hem Vault site.** Kept in-repo for development. Site docs hide `features/work-desk` and `guides/work-desk`.

## Overview

Work desk is a **curated daily focus** layer: a vault checklist at `work/today.md`, optionally grounded against Jira assignments. It is not a full Jira client and not automatic task sync.

| Tool | Role |
|------|------|
| `work_today` | Vault-only today list: list / add / complete |
| `jira_assigned` | Fetch or return cached assigned issues |
| `work_plate` | Diff Jira snapshot vs today — **never** mutates today |
| `work_log` | Day ledger: `event` / `review` / `push` (Jira worklogs, overlap-aware) |
| `jira_release` | User-initiated sprint versions: `sprints` / `preview` / `create` / `release`. Needs *Manage Versions* / *Administer Projects*. |

Jira is optional. Without credentials, `work_today` still works; plate/Jira tools degrade or error cleanly.

## How it works

### Vault layout

| Path | Purpose |
|------|---------|
| `work/today.md` | Curated focus checklist (`date` + `- [ ]` / `- [x]`) |
| `work/cache/jira-assigned.json` | Machine cache (do not hand-edit) |
| `work/log/YYYY-MM-DD.md` | Append-only day ledger (events + optional Jira receipts) |

**Rollover:** if frontmatter `date` ≠ local calendar day, completed items archive to that day’s log, open items carry forward, file restamps to today.

**Plate:** compares open today items to the Jira snapshot → `on_today` / `jira_only` / `today_only`. Promotion onto today is always an explicit `work_today` add after you choose.

**Jira defaults**

- Scope `sprint` (default): assignee = me, not Done, in `openSprints()`  
- Scope `all`: every assigned not-Done issue — **agents must ask first**  
- Cache TTL: 1 hour (filter-aware; wrong-scope cache is not reused)  

## Capabilities

- Focus list independent of backlog noise  
- Day rollover that preserves open items  
- Optional sprint-scoped Jira grounding  
- Cheap repeated “what’s on my plate” via cache  
- Free-text chores alongside issue keys  
- No ambient Jira polling; no silent tick-off; no auto-add from plate  

## How to use

| You say | Tool |
|---------|------|
| what’s on my plate | `work_plate` (`scope=sprint`) |
| what’s left on the list / today’s todos | `work_today` `op=list` |
| pull / refresh Jira | `jira_assigned` `refresh=true` |
| add X to today | `work_today` `op=add` |
| yes (to a tick-off ask) | `work_today` `op=complete` |
| log this session / note | `work_log` `op=event` |
| what did I do today / log to Jira | `work_log` `op=review` then `op=push` (after you confirm keys + minutes) |
| cut a release | `jira_release` `op=sprints` → `preview` → you pick name + keys → `create` |

Setup and flows: [Work desk guide](../guides/work-desk.md).

## Edge cases

- Sprint scope omits non-sprint assignments — ask before `scope=all`  
- Never auto-add `jira_only` issues  
- Agents ask yes/no before `complete`  
- Prefer MCP tools over raw edits of `today.md`  
- Secrets live in `.env`, not the vault; restart MCP after env changes  
- Fetch caps around ~500 issues (5×100 pages)  

## Related

- [Work desk guide](../guides/work-desk.md)  
- [MCP tools](../reference/mcp-tools.md)  
- `.env.example`, `config.example.toml` `[jira]`  
