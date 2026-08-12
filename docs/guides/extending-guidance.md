# Guide: Extending guidance

Process is vault markdown. Edit notes and the action registry — no MCP code change.

## Soft preference (auto-log)

When you state a standing default:

> Prefer Conventional Commits for this brain repo.

Agent should same-turn:

```
upsert_guidance
  type: suggestion
  scope: project          # or global — ask if unclear
  project: ai-mcp-brain   # when scope=project
  kind: commit
  content: Prefer Conventional Commits…
```

Signals: prefer / try to / lean / when making… / from now on / soft “always”.

## Binding instruction (explicit only)

Only when you mean hard process:

> Never skip typecheck before commit — add that as my coding rules.

```
upsert_guidance
  type: instruction
  scope: …
  kind: coding
  content: …
```

Empty instruction bodies in the seed vault are intentional. Do not invent binding rules from vibes.

## Upsert modes

| Mode | Use |
|------|-----|
| `append` (default) | Add an `## Update YYYY-MM-DD` section, or create the note |
| `replace_section` | Fix one heading block (`section` = heading text) |
| `remove_section` | Drop one heading block |
| `replace` | Rewrite the entire note — intentional full rewrite only |

Prefer section modes to correct bad appends.

## Add a custom action

1. Edit `actions/registry.md` inside the YAML fence (`schema: actions/v1`)  
2. Add an action id, aliases, `instructions: […]`, optional `workflows: […]`  
3. Create matching `instructions/global/<kind>.md` and/or `suggestions/global/<kind>.md`  
4. Optionally add `workflows/global/<id>.md` and link it from the registry  
5. Optionally overlay under `projects/<slug>/actions/registry.md`  

Agents pick it up on the next `resolve_action` / `list_actions`.

## Project overlays

Same kind under `projects/<slug>/instructions|suggestions|workflows/` precedes global. Both may be returned — agents apply project first.

## Workflows & personas

Multi-step playbooks and persona seats are `type=workflow` notes. Orchesto personas live under `workflows/global/persona-*.md`. Seat them via `read_note` / Orchesto — they are not action ids.

## Discover what exists

```
list_actions
list_guidance  project=<slug optional>
resolve_guidance  kind=coding
resolve_action  action=coding  project=<slug>
```

## Related

- [Guidance feature](../features/guidance.md)  
- [MCP tools](../reference/mcp-tools.md)  
- Vault: `actions/README.md`, `instructions/README.md`, `suggestions/README.md`, `workflows/README.md`  
