# Feature: Tool radar

## Overview

Tool radar tracks **tools and SaaS products** you use or try — any stack, no favorites. Each tool gets a catalog note; a newest-first log records what was just learned or used. When work happens inside a git repo, the same entry can also land on that project’s `tools.md`.

## How it works

| Path | Role |
|------|------|
| `stack/catalog/<slug>.md` | One durable note per tool |
| `stack/recent.md` | Newest-first running log |
| `projects/<slug>/tools.md` | Tools used in that git repo |

`track_tool` upserts the catalog note (create or append an `## Update` section), prepends `recent.md`, and optionally updates the project pack. `list_recent` returns the newest entries from `recent.md`.

## Capabilities

- Global tool/SaaS catalog  
- Newest-first recent log for “what did we just touch?”  
- Optional project linkage  
- Append updates instead of duplicating catalog files  

## How to use

**After trying or adopting a tool**

> We used Pinecone for vector search in this repo — track that.

```
track_tool
  name: Pinecone
  summary: Vector search for product docs RAG
  project: <git-slug>   # optional
```

**What did we use lately?**

```
list_recent  limit=20
```

**Browse the catalog**

Search or read `stack/catalog/<slug>.md` via `search_notes` / `read_note`.

## Edge cases

- Slug defaults from the tool name (normalized)  
- Project-specific lists belong under `projects/<slug>/tools.md`, not as the only copy — catalog stays global  
- Do not store API keys or secrets in summaries  

## Related

- [Vault & memory](vault-and-memory.md)  
- [Daily memory](../guides/daily-memory.md)  
- [MCP tools](../reference/mcp-tools.md)  
