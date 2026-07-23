# Action policy decisions (locked)

Agreed in discussion (2026-07-24):

1. **Call `resolve_action` on mode start only** — not every coding turn.
   - Call when: entering PR review / commit / git / non-trivial feature; mode switch; not yet resolved this thread; user asks to reload rules.
   - Skip: same-mode follow-ups; tiny one-off edits.
2. **Prefer explicit `action` id**; soft intent matching as fallback.
3. **No new actions yet** beyond coding / pr-review / commit / git (extend via vault registry later).
4. **Project overlay merges with precedence:** project instruction/workflow refs first, then global extras not already listed. Expanded notes still list project bodies before global for the same kind.
5. **Instructions start empty.** Agents must not invent or fill coding/PR/commit/git (or workflow) docs unless the user explicitly prompts to add them.
