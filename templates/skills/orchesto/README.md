# Orchesto skill template

Canonical **project** skill for multi-persona feature delivery. Source of truth for *new* setups: [`SKILL.md`](./SKILL.md) in this folder.

Personas and action process live in the Obsidian vault (MCP), not in this skill.

## Setup orchesto (any git repo)

When the user asks to **setup orchesto** in a project:

1. Confirm MCP brain vault works (`vault_info` → readable).
2. **Ensure personas** (idempotent — never overwrite existing vault notes):
   - From this repo’s `templates/vault/workflows/global/`:
     - `persona-architect.md`
     - `persona-implementor.md`
     - `persona-reviewer.md`
   - Copy into the vault’s `workflows/global/` only if missing.
3. **Install project skill** (Cursor):
   - Copy `templates/skills/orchesto/SKILL.md` → `<project>/.cursor/skills/orchesto/SKILL.md`
   - If the destination exists and differs, **ask** before overwrite.
4. Ensure `<project>/.plans/` exists and `.plans/` is listed in `<project>/.gitignore`.
5. Tell the user:
   - Skill path (edit DAG per project here)
   - Persona paths (edit who/behavior in the vault; per-repo overlays: `projects/<slug>/workflows/persona-*.md`)

### Other harnesses

v1 primary path is Cursor project skills. For Claude/Codex/Zed: same steps for vault personas + `.plans/`; place an equivalent skill/block only if that harness has a clear project-skill location — otherwise point the user at Cursor or paste `SKILL.md` into a project agent file they choose.

## Day-to-day

After setup, the project skill runs the DAG (architect → implementor → reviewer, fix loop ≤3). User does not need to say “run orchesto.”

Standalone `resolve_action` (e.g. `pr-review`) still works without this skill or any persona.
