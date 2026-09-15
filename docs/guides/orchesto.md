# Guide: Orchesto

## Setup

**Skill-only (no vault)**

```bash
npx skills add SayarB/ai-mcp-brain --skill orchesto -g
npx skills update orchesto -g
```

Use **`-g`**. That writes user-global skill dirs (`~/.cursor/skills/orchesto`, etc.), not a product repo.

**Hem Vault**

Prerequisites: ai-mcp-brain installed via [`INSTALL.md`](../../INSTALL.md). Orchesto pack + vault persona safe-sync are included. MCP is optional for running the skill.

No separate **setup orchesto** prompt is required for day-to-day use.

| Harness | Global skill directory |
|---------|------------------------|
| Cursor | `~/.cursor/skills/orchesto/` |
| Zed / Codex-style | `~/.agents/skills/orchesto/` |
| Claude Code | `~/.claude/skills/orchesto/` |

Update after you **pull this clone**: `npm run brain -- inject`. `git pull` alone does **not** update Obsidian. After **push**, `scripts/restart-mcp.sh` (post-push hook) runs inject then restarts MCP.

In chat: **sync orchesto** / **update orchesto personas** / **setup orchesto** → agent follows vault `workflows/global/setup-orchesto.md` (prefer inject from the clone).

## Ship a feature

1. Ask for the feature (skill may match without saying “run orchesto”)  
2. Answer the PRD gate: *Does this feature need a PRD / CPO pass?*  
3. If yes: review `prd.md` + CPO approval packet; approve or reject for revise  
4. Architect: small ask → root `plan.md` + `validations.md`. Large ask may **suggest capability phases**; if you agree, every phase folder is written in one sitting (`phases.md` + `<NN>-<slug>/plan.md` + `validations.md`)  
5. Approve the **current** plan/validations (phase 1 first when phased). That approval is the go to build **that** phase (or the unphased feature)  
6. Implementor → reviewer against that contract; up to **3** fix rounds **per phase** if `changes_required`  
7. On review `pass` with later phases remaining: **stop**. Approve the next phase’s plan when you want it built. Do not expect auto-start  
8. Read the coordinator summary when the last phase (or unphased feature) passes  

## Brainstorm

1. Say **brainstorm** / seat **brainstormer** / talk through an idea  
2. Grill until the idea is clear (questions that improve it; you answer). On a **large app**, map parts and go deep on each (nooks, edges, seams) — not surface-only.  
3. Then **ideate**: discussion with new ideas, products, and methods (on ask and unprompted) **per part** as well as whole.  
4. On proceed-yes: `.plans/<slug>/brainstorm.md`, then Orchesto (PRD ask if unanswered)  
5. On abort: stay in seat; no CPO/architect  

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
- Letting an agent auto-start the next capability phase after review `pass`  

## Related

- [Orchesto feature](../features/orchesto.md)  
- Vault: `workflows/global/setup-orchesto.md`  
- Canonical pack: [`skills/orchesto/`](../../skills/orchesto/)  
