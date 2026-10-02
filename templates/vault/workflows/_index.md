# Workflow index

| id | path | description |
|----|------|-------------|
| setup-orchesto | `workflows/global/setup-orchesto.md` | Repair / sync Orchesto packs; inject + vault personas; ensure `.plans/` (update/remove are sibling skills) |
| orchesto-skill-template | `workflows/global/orchesto-skill-template.md` | Pointer to repo `skills/orchesto/` (not a SKILL.md body) |
| persona-cpo | `workflows/global/persona-cpo.md` | Optional Orchesto seat: PRD / product requirements |
| persona-architect | `workflows/global/persona-architect.md` | Orchesto seat: plan + validations (optional capability phases) |
| persona-implementor | `workflows/global/persona-implementor.md` | Orchesto seat: build against current plan contract |
| persona-reviewer | `workflows/global/persona-reviewer.md` | Orchesto seat: review against current validations |
| persona-brainstormer | `workflows/global/persona-brainstormer.md` | Standalone: grill + ideate, including deep per-part coverage on large apps |
| persona-auditor | `workflows/global/persona-auditor.md` | Standalone: holistic repo/area audit (not Orchesto) |

Project overrides: `projects/<slug>/workflows/<id>.md`

Day-to-day pipeline: Orchesto skill pack at `skills/orchesto/` — global `~/.cursor/skills/orchesto/`, `orchesto-update/`, `orchesto-remove/` (and `~/.agents/skills/`, `~/.claude/skills/`). Vault global personas are safe-synced by inject; project overlays win. Orchesto **always asks** whether a PRD/CPO pass is needed before architect.

Optional pre-step: seat **brainstormer** on demand (`read_note` `persona-brainstormer`) — grill + ideate (per-part depth on large apps), then proceed into normal Orchesto.

Standalone: seat **auditor** on demand (`read_note` `persona-auditor`) — writes `.audits/<scope-slug>/report.md`.
