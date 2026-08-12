# Hem Vault — Product docs

Portable second brain for coding agents: an Obsidian markdown vault plus MCP tools that give Cursor, Claude, Codex, and Zed durable memory, standing process, and optional delivery workflows.

Open-source repository: **ai-mcp-brain**. Browse these docs on the Hem Vault site (`site/`) or as markdown in this folder.

You browse and edit the vault in Obsidian. Agents read and write through MCP under a shared memory policy. Process lives in vault markdown — extend it without changing server code.

## Start here

| If you want… | Go to |
|--------------|--------|
| Mental model & architecture | [How it works](how-it-works.md) |
| Install on a machine | [INSTALL.md](../INSTALL.md) — agent one-liner / curl |
| Feature list | [Features](#features) below |
| Day-to-day how-tos | [Guides](#guides) below |
| Full MCP tool reference | [MCP tools](reference/mcp-tools.md) |

## Features

| Feature | What it does |
|---------|----------------|
| [Vault & memory](features/vault-and-memory.md) | Search, read, remember; project packs keyed to git repos |
| [Guidance system](features/guidance.md) | Instructions, soft suggestions, workflows, action registry |
| [Tool radar](features/tool-radar.md) | Catalog tools/SaaS and a newest-first recent log |
| [Orchesto & personas](features/orchesto.md) | Multi-phase feature delivery; brainstormer; standalone auditor |

## Guides

| Guide | Use when |
|-------|----------|
| [Getting started](guides/getting-started.md) | First install and smoke-check |
| [Daily memory](guides/daily-memory.md) | Capture decisions, load project context, search before inventing |
| [Orchesto](guides/orchesto.md) | Setup skill, ship a feature, brainstorm, audit |
| [Extending guidance](guides/extending-guidance.md) | Add actions, soft prefs, binding rules, playbooks |

## What this product is not

- Not semantic RAG (yet) — search is keyword full-text
- Not Orca / orca-cli — Orchesto is this product’s delivery skill; setup lives in the vault
- Not a substitute for tiny one-off edits — Orchesto is for end-to-end plan → validate → review

## Repo vs vault

| Lives in | Examples |
|----------|----------|
| **This repo** | MCP server, install/inject scripts, vault templates, Orchesto skill template |
| **Your vault** | Your notes, project packs, instructions, suggestions, workflows |

The vault path defaults to something like `~/Obsidian/My Brain` (override with `BRAIN_VAULT` or `config.toml`). Prefer a normal home-directory path — avoid iCloud / `Mobile Documents` if the editor sandbox returns `EPERM`.
