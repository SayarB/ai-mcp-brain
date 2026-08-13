# Guide: Orchesto

## Setup (ships with Hem Vault)

Prerequisites: ai-mcp-brain installed via [`INSTALL.md`](../../INSTALL.md) — Orchesto global skill + vault personas are included. MCP up (`vault_info` → `readable: true`).

No separate **setup orchesto** prompt is required for day-to-day use.

| Harness | Global skill path |
|---------|-------------------|
| Cursor | `~/.cursor/skills/orchesto/SKILL.md` |
| Zed / Codex-style | `~/.agents/skills/orchesto/SKILL.md` |
| Claude Code | `~/.claude/skills/orchesto/SKILL.md` |

Optional repair / ensure `.plans/` / project-local skill copy: say **setup orchesto** → agent follows vault `workflows/global/setup-orchesto.md`.

## Ship a feature

1. Ask for the feature (skill may match without saying “run orchesto”)  
2. Answer the PRD gate: *Does this feature need a PRD / CPO pass?*  
3. If yes: review `prd.md` + CPO approval packet; approve or reject for revise  
4. Review architect `plan.md` + `validations.md`; approve to unlock implementor  
5. Implementor → reviewer; up to **3** fix rounds if `changes_required`  
6. Read the coordinator summary  

## Brainstorm

1. Say **brainstorm** / seat **brainstormer** / talk through an idea  
2. Stay in multi-turn critical dialogue  
3. On proceed-yes: `.plans/<slug>/brainstorm.md`, then Orchesto (PRD ask if unanswered)  
4. On abort: stay in seat; no CPO/architect  

Brainstormer is never auto-offered.

## Audit (standalone)

1. Say **audit** a repo/path/feature (or seat **auditor**)  
2. Agent writes `.audits/<scope-slug>/report.md`  
3. Ensure `.audits/` is gitignored  
4. Report-first — not an Orchesto fix loop  

## When not to use Orchesto

- Tiny one-off edits  
- A lone PR review → `resolve_action action=pr-review` (or seat reviewer only if you ask)  
- Whole-repo vulnerability hunts as part of shipping → use **auditor**  
- Skipping approval gates “because the ask was build X”  

## Related

- [Orchesto feature](../features/orchesto.md)  
- Vault: `workflows/global/setup-orchesto.md`  
- Contributor template: `templates/skills/orchesto/`  
