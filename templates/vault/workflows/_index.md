# Workflow index

| id | path | description |
|----|------|-------------|
| setup-orchesto | `workflows/global/setup-orchesto.md` | Install project orchesto skill + ensure personas |
| orchesto-skill-template | `workflows/global/orchesto-skill-template.md` | SKILL.md body to copy into a project |
| persona-cpo | `workflows/global/persona-cpo.md` | Optional Orchesto seat: PRD / product requirements |
| persona-architect | `workflows/global/persona-architect.md` | Orchesto seat: plan + validations |
| persona-implementor | `workflows/global/persona-implementor.md` | Orchesto seat: build against plan/validations |
| persona-reviewer | `workflows/global/persona-reviewer.md` | Orchesto seat: review against validations |
| persona-auditor | `workflows/global/persona-auditor.md` | Standalone: holistic repo/area audit (not Orchesto) |

Project overrides: `projects/<slug>/workflows/<id>.md`

Day-to-day pipeline: project skill via **setup orchesto** — Zed `.agents/skills/orchesto/`, Cursor `.cursor/skills/orchesto/`. Orchesto **always asks** whether a PRD/CPO pass is needed before architect.

Standalone: seat **auditor** on demand (`read_note` `persona-auditor`) — writes `.audits/<scope-slug>/report.md`.
