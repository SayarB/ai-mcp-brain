---
name: System consistency audit
description: Find contradictions and design holes in Hem Vault (policy, MCP, templates, docs) that cause hallucinated memory or wasted agent turns.
enabled: true
mode: report
schedule: "0 2 * * 0"
timezone: UTC
timeout_minutes: 30
notify: findings
outputs:
  report: report.md
---

# System consistency audit

You are auditing **this repository** (Hem Vault / `ai-mcp-brain`): the injected memory policy, MCP tools, vault templates, and docs that tell coding agents how to read and write durable knowledge.

This is `mode: report` only. Write findings. Do **not** edit product files, `git push`, or open PRs.

Write the final report to `/work/out/report.md`.

## Goal

Find **contradictions** and **structural issues** that would make an agent:

1. **Hallucinate** — invent vault facts, process, or “we always do X” when nothing durable exists; or follow two conflicting rules.
2. **Waste work** — extra MCP round-trips, re-reading the same guidance, writing the wrong place, asking scope questions that policy already answered, or skipping writes so the next session repeats the mistake.

“Good” means: one source of truth per concern; policy, tool schemas, templates, and docs agree; agents can search → act → write without guessing.

## Scope (read these; do not wander)

Prioritize diffs **across** these layers (a bug in one file is weaker than two files that disagree):

| Layer | Paths |
|-------|--------|
| Injected policy | `templates/prompts/agent-memory.md`, `templates/prompts/memory-policy.md` |
| MCP behavior | `src/mcp/server.ts`, `src/vault.ts`, related MCP/tool docs |
| Vault seeds | `templates/vault/` (especially `_meta/schema.md`, `actions/`, `instructions/`, `suggestions/`, `workflows/`, `projects/_template/`, `AGENTS.md`) |
| Human docs | `docs/features/vault-and-memory.md`, `docs/features/guidance.md`, `docs/how-it-works.md`, `docs/guides/daily-memory.md`, `docs/reference/mcp-tools.md`, `README.md`, `INSTALL.md` |

Skip Orchesto pipeline design except where it **conflicts** with memory policy (duplicate process, extra `resolve_*` calls, personas vs actions). Skip secrets, unrelated UI, and the marketing site unless they contradict install/runtime.

## What to look for

**Hallucination vectors**

- Policy says “search before invent” but tools/docs imply the agent should know facts without a search miss.
- Empty instruction bodies vs agents filling process from vibes (policy forbids this — check if examples/docs still invite it).
- `_meta/projects-index.md` documented as applied vs MCP not resolving it.
- Keyword search requiring **all** terms vs docs that sound like semantic memory.
- Global vs project: ask-on-unclear vs defaults that skip the ask vs defaults that always ask.
- Facts (`remember` / decisions / gotchas) vs process (`upsert_guidance`) mixed or swapped in examples.
- Corrections / gotchas mentioned as “should write” with no same-turn contract (agents skip → next session fabricates).
- Binding vs soft confused (`instructions` vs `suggestions`).
- Two notes or two docs that state opposite rules (newer vs older, README vs template).

**Efficiency vectors**

- `resolve_action` / `resolve_guidance` called every turn vs mode-start + reuse.
- Loading huge notes when `pointers_only` / `read_note` is the documented escape.
- Duplicate guidance: same rule in policy, AGENTS.md, and a workflow with slightly different wording.
- Overlapping tools (`remember` vs `upsert_guidance` vs `track_tool`) without a crisp router.
- Search that misses (AND of all terms) causing retry spam or fallback invention.
- Project pack load that is ignored, then searched again for the same facts.

**Contradictions**

Quote both sides. A finding without two (or more) concrete locations is a nit, not a contradiction.

## Method

1. Skim the scope files; grep for overlapping claims (`search`, `remember`, `scope`, `gotcha`, `correction`, `resolve_action`, `instruction`, `suggestion`, `projects-index`).
2. Trace one agent loop: start of work → retrieve → act → write on preference / decision / correction.
3. Note where the loop is underspecified (hole) vs specified twice differently (contradiction).
4. Do not file style nits, typos-only, or “could add embeddings.”

## Report format

`/work/out/report.md`:

```markdown
# System consistency audit
Date: <ISO date>
Repo: ai-mcp-brain

## Summary
- Finding count by severity
- One paragraph: hallucination risk vs efficiency risk

## Findings

### [H|E|C] <short title>
- Severity: high | medium | low
- Kind: hallucination | efficiency | contradiction (can combine)
- Evidence: `path` (what it says) vs `path` (what it says) or “hole: policy says X, no tool/docs enforce it”
- Why an agent would fail
- Suggested direction (one sentence, not a patch)

## Clean
What already lines up (short). Do not pad.

## Nothing material
If there are no high/medium findings, say so explicitly here.
```

Severity:

- **high** — two first-class sources disagree on write/read/scope, or a hole that routinely causes invented process/facts.
- **medium** — extra round-trips or likely skipped writes.
- **low** — wording drift with the same intent.

If nothing material, still write the report and say so explicitly.
