# Orchesto skill template

Canonical **contributor** copy of the skill: [`SKILL.md`](./SKILL.md).

**Default install:** Hem Vault [`INSTALL.md`](../../../INSTALL.md) / `bun run setup` / `brain inject` writes this body to **global** harness skill dirs:

| Harness | Path |
|---------|------|
| Cursor | `~/.cursor/skills/orchesto/SKILL.md` |
| Zed / Codex / OpenCode | `~/.agents/skills/orchesto/SKILL.md` |
| Claude Code | `~/.claude/skills/orchesto/SKILL.md` |

**Repair / extras:** when the user says **setup orchesto**, follow vault `workflows/global/setup-orchesto.md` (seeded from `templates/vault/workflows/global/`). Skill body also lives in vault `workflows/global/orchesto-skill-template.md`.

Optional project-local copies (per-repo DAG): `.agents/skills/orchesto/`, `.cursor/skills/orchesto/`, `.claude/skills/orchesto/` — only when the user asks.

Keep `SKILL.md` here in sync with that vault skill-template note when editing the DAG.
