---
name: orchesto-update
description: >-
  Update Orchesto skill packs on this machine: pull the ai-mcp-brain clone,
  then refresh global orchesto / orchesto-update / orchesto-remove skill files
  and bundled personas. Use when the user says update orchesto, sync orchesto,
  or pull orchesto skill. Not for shipping a feature (that is the orchesto
  skill) and not for updating Hem Vault itself.
---

# Update Orchesto

Refresh **global Orchesto skill adapters** from the repository that owns this code. Do **not** change the Orchesto delivery DAG in this skill.

## Do not

- `git pull` the current workspace unless that repo’s `package.json` `"name"` is `ai-mcp-brain`.
- `git stash`, `git pull --rebase`, or `git pull --force`.
- Run `brain inject` without `--orchesto-only` (that rewrites harness MCP/config).
- Delete vault notes or product-repo `.plans/`.

## Procedure

1. **Resolve the ai-mcp-brain clone** (stop if you cannot):
   - If the current repo’s `package.json` `"name"` is `ai-mcp-brain`, use this repo.
   - Else read the `ai-mcp-brain` MCP server `cwd` from the harness MCP config (e.g. `~/.cursor/mcp.json`).
   - Else stop and tell the user you cannot find the clone.
2. From **that clone only**, run:

```bash
npm run brain -- orchesto-update
# or: bun run brain -- orchesto-update
```

Optional: `--target cursor|claude|codex|zed|all` (default `all`).

3. Report the CLI output (paths wrote / updated / skipped / failed). If git refused (dirty tree or non-fast-forward), report that and stop — do not stash or force.
4. Tell the user to **reload the editor** if the next skill load still looks stale.

Repair without pulling: from the same clone, `npm run brain -- inject --orchesto-only`.
