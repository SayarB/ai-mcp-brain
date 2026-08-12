# Guide: Daily memory

## Load context before inventing

At the start of non-trivial work in a git repo:

1. Project slug = git root folder name (check `_meta/projects-index.md` if the folder name is wrong)  
2. `get_project_context` with that slug  
3. `search_notes` for the topic  
4. Answer from vault facts; if empty, say so — do not fabricate decisions  

**Example**

> Load project context for this repo, then search for auth decisions.

## Capture durable facts

| Situation | Scope | Where |
|-----------|-------|-------|
| Decision for this repo | `project` | `projectFile=decisions` |
| Gotcha / pitfall | `project` | `projectFile=gotchas` |
| Tool used here | prefer `track_tool` with `project` | also updates `tools.md` |
| Unsorted park | `global` | `folder=inbox` |
| Cross-repo pattern | `global` | `folder=patterns` |

If global vs project is unclear, **ask** before writing.

**Example**

> Remember for this repo: we rejected cookie auth for the public API — use bearer tokens.

## Soft prefs vs hard rules

| You say | Agent does |
|---------|------------|
| Prefer / lean / try to / from now on… | `upsert_guidance` `type=suggestion` same turn |
| Must / required / never skip / “add as my coding rules” | `upsert_guidance` `type=instruction` only then |

See [Extending guidance](extending-guidance.md).

## Process at mode start

Entering coding, PR review, commit, or git work:

```
resolve_action  action=coding|pr-review|commit|git  project=<slug>
```

Reuse the bundle already in the chat for the same action. Do not re-call every turn.

## Tool radar

When you adopt or learn a tool:

```
track_tool  name=…  summary=…  project=<slug optional>
```

Check recent use with `list_recent`.

## Do not store

- Secrets, tokens, credentials  
- Ephemeral debug noise  
- One-off task chatter with no lasting value  

## Related

- [Vault & memory](../features/vault-and-memory.md)  
- [Tool radar](../features/tool-radar.md)  
- [Guidance](../features/guidance.md)  
