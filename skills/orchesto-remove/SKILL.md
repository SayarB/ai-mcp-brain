---
name: orchesto-remove
description: >-
  Remove Orchesto from the harness skills list: uninstall the orchesto,
  orchesto-update, and orchesto-remove global skill directories. Use when the
  user says remove orchesto or uninstall orchesto skill. Does not uninstall
  Hem Vault or delete vault personas. Not for shipping a feature.
---

# Remove Orchesto

Take Orchesto **off the skills list**. No extra confirmation after the user asked to remove Orchesto.

## Do not

- Delete vault `workflows/global/persona-*.md` or product-repo `.plans/`.
- Delete project-local skill copies in other repos.
- Uninstall Hem Vault / MCP / the brain clone.

## Procedure

1. **Resolve the ai-mcp-brain clone** (same as update): current repo if `package.json` `"name"` is `ai-mcp-brain`, else the `ai-mcp-brain` MCP server `cwd`, else stop.
2. From **that clone**, run (no extra confirm):

```bash
npm run brain -- orchesto-remove
# or: bun run brain -- orchesto-remove
```

Optional: `--target cursor|claude|codex|zed|all` (default `all`).

3. Report which directories were removed. Tell the user to reload the editor so the skills list drops them. Dirs reported `managed elsewhere (link -> …)` were left in place: remove those with the tool that manages them.

## Project-local copies

Only if the user is **in that repo** and **asked** to remove a local copy, delete:

- `<repo>/.cursor/skills/orchesto/`
- `<repo>/.cursor/skills/orchesto-update/`
- `<repo>/.cursor/skills/orchesto-remove/`
- and the same under `.agents/skills/` and `.claude/skills/`

Do **not** do this from the CLI command above — that command is global homes only.

Reinstall later: Hem Vault [`INSTALL.md`](../../INSTALL.md) / `brain inject --orchesto-only` / vault `setup-orchesto`.
