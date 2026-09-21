# Orchesto

Self-contained Agent Skill: plan → validations → implement → review. **No Obsidian vault or MCP required.**

## Skill-only (no vault)

Install **globally** (`-g`). Do not copy this into a product repo as the tester path.

```bash
npx skills add SayarB/ai-mcp-brain --skill orchesto -g
```

Update after we ship persona or DAG changes:

```bash
npx skills update orchesto -g
```

That refreshes `~/.cursor/skills/orchesto` (and other agents), **not** an Obsidian vault.

## Hem Vault

The vault is a different directory from this git clone. `git pull` of the clone is not enough.

From the **ai-mcp-brain clone**:

```bash
npm run brain -- inject
# or: bun run setup
```

That copies this pack to global skill dirs **and** safe-syncs the five global vault personas (`workflows/global/persona-*.md`). Unmodified notes take upstream; local edits are skipped. Project overlays (`projects/<slug>/workflows/`) are never overwritten.

Sibling skills `orchesto-update` and `orchesto-remove` install beside this pack (`brain orchesto-update` / `brain orchesto-remove`, or in chat **update orchesto** / **remove orchesto**).

After `git push` of this repo, with `git config core.hooksPath .githooks`, `scripts/restart-mcp.sh` runs inject (fail-open) then restarts MCP.

In chat: **update orchesto** / **sync orchesto** → `orchesto-update`. **remove orchesto** → `orchesto-remove`. Repair: **setup orchesto** / `inject --orchesto-only`.

## Layout

```
skills/orchesto/
  SKILL.md
  references/persona-*.md   # loaded one seat at a time
  README.md
```
