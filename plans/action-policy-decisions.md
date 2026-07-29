# Action policy decisions (locked)

Agreed in discussion (2026-07-24):

1. **Call `resolve_action` on mode start only** — not every coding turn.
   - Call when: entering PR review / commit / git / non-trivial feature; mode switch; not yet resolved this thread; user asks to reload rules.
   - Skip: same-mode follow-ups; tiny one-off edits.
   - **Reuse if already in context (2026-07-29):** before calling, check this chat for an earlier successful bundle for the **same action**; if present and mode unchanged, do not call MCP again. Re-resolve only on mode switch, user reload, or missing bundle.
2. **Prefer explicit `action` id**; soft intent matching as fallback.
3. **No new actions yet** beyond coding / pr-review / commit / git (extend via vault registry later).
4. **Project overlay merges with precedence:** project instruction/workflow refs first, then global extras not already listed. Expanded notes still list project bodies before global for the same kind.
5. **Instructions start empty / stay binding-only.** Agents must not invent or fill coding/PR/commit/git (or workflow) docs unless the user explicitly means hard process rules.
6. **Soft suggestions layer (2026-07-24):** standing prefs (“prefer / try to / when making…”) auto-log to `suggestions/` via `upsert_guidance` `type=suggestion` same turn — no “remember this” required. `resolve_action` surfaces them under a soft section (prefer, not must). Suggestion kinds auto-pair with instruction kinds on the action.
