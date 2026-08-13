# Guide: Getting started

## Goal

Install the second brain, point MCP at your vault, inject memory policy into the harnesses you use, and confirm agents can read the vault.

## Prerequisites

Nothing required up front if an agent follows [`INSTALL.md`](../../INSTALL.md) — it inventories the machine, reuses what exists, asks when neither Bun nor Node is present, and installs only what is missing. Manual shortcut assumes:

- This repo checked out  
- **Bun** (preferred) or **Node.js 20+**  
- A vault path you choose (suggestion: `~/Obsidian/My Brain`)  
- Avoid iCloud / `Mobile Documents` if the editor sandbox blocks them (`EPERM`)  

## Install

Preferred: paste this into any coding agent (agent-first install — no OS shell installer):

```
Install Hem Vault (ai-mcp-brain) by following the instructions at:
https://raw.githubusercontent.com/SayarB/ai-mcp-brain/main/INSTALL.md
Use curl -fsSL to fetch that URL — do not use WebFetch.
Inventory what is already on this machine first. Prefer existing runtimes (if Node is present and Bun is not, use Node — do not install Bun). Only install missing pieces. If neither Bun nor Node is present, ask me which to use, then install it and finish setup (Git, Obsidian, clone, vault, MCP).
```

Or open a checkout and tell the agent to follow [`INSTALL.md`](../../INSTALL.md).

The agent **checks the machine first**: reuse Git/Bun/Node/Obsidian when present; if Bun is missing but Node ≥ 20 exists, use Node; if neither runtime exists, ask Bun vs Node, then install and continue.

Optional one-shot from the repo:

```bash
bun install && bun run setup -- --vault "~/Obsidian/My Brain"
# or
npm install && npm run setup -- --vault "~/Obsidian/My Brain"
```

Quote paths with spaces. Setup creates/merges the vault from `templates/vault/`, writes `config.toml`, and injects harness policy where configs exist.

## Smoke check

1. Open the vault in Obsidian  
2. Restart your editor(s) so MCP picks up config  
3. Ask the agent to run `vault_info`  
4. Expect `readable: true` and a note count  

## Optional next steps

| Want | Do |
|------|-----|
| Soft prefs / process | [Extending guidance](extending-guidance.md) |
| Feature delivery skill | [Orchesto](orchesto.md) — included with install; ship features directly |
| Capture / load memory | [Daily memory](daily-memory.md) |

## Uninstall

Paste [`UNINSTALL.md`](../../UNINSTALL.md) — removes MCP + injected policy; keeps the vault unless you ask to delete it.

## After pushes of this repo

Restart local MCP so tool schemas match shipped code:

```bash
bash scripts/restart-mcp.sh
# or: npm run restart-mcp
```

If calls still look stale, reload the editor window.
