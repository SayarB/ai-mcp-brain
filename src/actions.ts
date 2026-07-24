import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseYaml, readText } from "./runtime.ts";
import {
  noteToSummary,
  resolveGuidance,
  slugify,
  type VaultNote,
} from "./vault.ts";

const REGISTRY_GLOBAL = "actions/registry.md";
const MAX_NOTE_CHARS = 4000;

export type ActionDef = {
  description?: string;
  aliases?: string[];
  instructions?: string[];
  workflows?: string[];
};

export type ActionRegistry = {
  schema: string;
  actions: Record<string, ActionDef>;
};

type CacheEntry = { mtimeMs: number; text: string };

const textCache = new Map<string, CacheEntry>();

async function readCached(vaultPath: string, relPath: string): Promise<string | null> {
  const abs = resolve(vaultPath, relPath);
  try {
    const st = await stat(abs);
    const key = abs;
    const hit = textCache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
    const text = await readText(abs);
    textCache.set(key, { mtimeMs: st.mtimeMs, text });
    return text;
  } catch {
    return null;
  }
}

function extractYamlFence(markdown: string): string | null {
  const match = markdown.match(/```ya?ml\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() || null;
}

function parseRegistryMarkdown(markdown: string): ActionRegistry {
  const fence = extractYamlFence(markdown);
  if (!fence) {
    throw new Error("actions registry missing ```yaml``` fence (schema actions/v1)");
  }
  const parsed = parseYaml<{
    schema?: string;
    actions?: Record<string, ActionDef>;
  }>(fence);
  if (!parsed?.actions || typeof parsed.actions !== "object") {
    throw new Error("actions registry YAML must contain an actions: map");
  }
  return {
    schema: parsed.schema ?? "actions/v1",
    actions: parsed.actions,
  };
}

function uniqPreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Project fields win; instruction/workflow lists = project first, then global extras. */
function mergeActionDef(globalDef: ActionDef, projectDef: ActionDef): ActionDef {
  return {
    description: projectDef.description ?? globalDef.description,
    aliases: uniqPreserveOrder([
      ...(projectDef.aliases ?? []),
      ...(globalDef.aliases ?? []),
    ]),
    instructions: uniqPreserveOrder([
      ...(projectDef.instructions ?? []),
      ...(globalDef.instructions ?? []),
    ]),
    workflows: uniqPreserveOrder([
      ...(projectDef.workflows ?? []),
      ...(globalDef.workflows ?? []),
    ]),
  };
}

function mergeRegistries(
  globalReg: ActionRegistry,
  projectReg: ActionRegistry | null,
): ActionRegistry {
  if (!projectReg) return globalReg;
  const actions: Record<string, ActionDef> = { ...globalReg.actions };
  for (const [id, projectDef] of Object.entries(projectReg.actions)) {
    const globalDef = globalReg.actions[id];
    actions[id] = globalDef
      ? mergeActionDef(globalDef, projectDef)
      : projectDef;
  }
  return {
    schema: projectReg.schema || globalReg.schema,
    actions,
  };
}

async function loadRegistry(
  vaultPath: string,
  project?: string,
): Promise<{ registry: ActionRegistry; sources: string[] }> {
  const sources: string[] = [];
  const globalText = await readCached(vaultPath, REGISTRY_GLOBAL);
  if (!globalText) {
    throw new Error(`Missing ${REGISTRY_GLOBAL} — run brain init or create the file in the vault`);
  }
  sources.push(REGISTRY_GLOBAL);
  const globalReg = parseRegistryMarkdown(globalText);

  let projectReg: ActionRegistry | null = null;
  if (project) {
    const rel = join("projects", slugify(project), "actions", "registry.md");
    const posix = rel.split("\\").join("/");
    const text = await readCached(vaultPath, posix);
    if (text) {
      sources.push(posix);
      projectReg = parseRegistryMarkdown(text);
    }
  }

  return { registry: mergeRegistries(globalReg, projectReg), sources };
}

function matchAction(
  registry: ActionRegistry,
  action?: string,
  intent?: string,
): { id: string; def: ActionDef } | null {
  const actions = registry.actions;
  if (action) {
    const key = action.trim().toLowerCase();
    if (actions[key]) return { id: key, def: actions[key]! };
    for (const [id, def] of Object.entries(actions)) {
      const aliases = (def.aliases ?? []).map((a) => a.toLowerCase());
      if (aliases.includes(key)) return { id, def };
    }
  }

  const hay = (intent ?? "").toLowerCase();
  if (!hay) return null;

  // Prefer longer alias / id matches
  const candidates: { id: string; def: ActionDef; score: number }[] = [];
  for (const [id, def] of Object.entries(actions)) {
    let score = 0;
    if (hay.includes(id.replace(/-/g, " ")) || hay.includes(id)) score += 5;
    for (const alias of def.aliases ?? []) {
      if (hay.includes(alias.toLowerCase())) score += 4 + alias.length / 10;
    }
    if (def.description && hay.includes(def.description.toLowerCase().slice(0, 20))) {
      score += 1;
    }
    // Synonyms for seeded actions
    if (
      id === "pr-review" &&
      ((/\b(pr|pull[- ]?request)\b/.test(hay) && /\breview\b/.test(hay)) ||
        /\bcode[- ]?review\b/.test(hay))
    ) {
      score += 8;
    }
    if (id === "commit" && /\bcommit(\s+message)?s?\b/.test(hay)) score += 8;
    if (id === "coding" && /\b(implement|refactor)\b/.test(hay)) score += 6;
    if (
      id === "coding" &&
      /\b(cod(e|ing))\b/.test(hay) &&
      !/\breview\b/.test(hay)
    ) {
      score += 6;
    }
    if (id === "git" && /\b(git|branch|rebase|merge)\b/.test(hay)) score += 6;
    if (score > 0) candidates.push({ id, def, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ? { id: candidates[0].id, def: candidates[0].def } : null;
}

function truncateNote(note: VaultNote): string {
  const summary = noteToSummary(note, MAX_NOTE_CHARS);
  if (note.body.length > MAX_NOTE_CHARS) {
    return `${summary}\n\n…(truncated at ${MAX_NOTE_CHARS} chars)`;
  }
  return summary;
}

export type ResolveActionInput = {
  action?: string;
  intent?: string;
  project?: string;
  pointers_only?: boolean;
};

export type ResolveActionResult = {
  actionId: string | null;
  description?: string;
  sources: string[];
  refs: { instructions: string[]; suggestions: string[]; workflows: string[] };
  pointers: { scope: string; type: string; kindOrId: string; path: string }[];
  bundle: string;
  message: string;
};

export async function resolveAction(
  vaultPath: string,
  input: ResolveActionInput,
): Promise<ResolveActionResult> {
  const { registry, sources } = await loadRegistry(vaultPath, input.project);
  const matched = matchAction(registry, input.action, input.intent);

  if (!matched) {
    return {
      actionId: null,
      sources,
      refs: { instructions: [], suggestions: [], workflows: [] },
      pointers: [],
      bundle: "",
      message:
        "No action matched. Edit vault actions/registry.md to add one, or pass action= coding|pr-review|commit|git.",
    };
  }

  const instructionKinds = matched.def.instructions ?? [];
  const refs = {
    instructions: instructionKinds,
    // v1: suggestions auto-pair with instruction kinds on the action
    suggestions: instructionKinds,
    workflows: matched.def.workflows ?? [],
  };
  const pointers: ResolveActionResult["pointers"] = [];
  const parts: string[] = [
    `# Action: ${matched.id}`,
    matched.def.description ? `_${matched.def.description}_` : "",
    "",
  ];

  const pushHits = (
    hits: Awaited<ReturnType<typeof resolveGuidance>>["hits"],
    heading: (hit: (typeof hits)[number]) => string,
  ) => {
    for (const hit of hits) {
      pointers.push({
        scope: hit.scope,
        type: hit.type,
        kindOrId: hit.kindOrId,
        path: hit.path,
      });
      if (!input.pointers_only) {
        parts.push(heading(hit), "", truncateNote(hit.note), "");
      }
    }
  };

  for (const kind of refs.instructions) {
    const resolved = await resolveGuidance(vaultPath, {
      kind,
      type: "instruction",
      project: input.project,
    });
    pushHits(
      resolved.hits,
      (hit) => `## ${hit.scope} instruction \`${hit.kindOrId}\` (${hit.path})`,
    );
  }

  const suggestionHits: Awaited<
    ReturnType<typeof resolveGuidance>
  >["hits"] = [];
  for (const kind of refs.suggestions) {
    const resolved = await resolveGuidance(vaultPath, {
      kind,
      type: "suggestion",
      project: input.project,
    });
    suggestionHits.push(...resolved.hits);
  }
  if (suggestionHits.length && !input.pointers_only) {
    parts.push(
      "## Soft suggestions (prefer, not must)",
      "",
      "_Lean toward these defaults; bend when quality or structure requires it._",
      "",
    );
  }
  pushHits(
    suggestionHits,
    (hit) => `### ${hit.scope} suggestion \`${hit.kindOrId}\` (${hit.path})`,
  );

  for (const workflowId of refs.workflows) {
    const resolved = await resolveGuidance(vaultPath, {
      workflow_id: workflowId,
      project: input.project,
    });
    pushHits(
      resolved.hits,
      (hit) => `## ${hit.scope} workflow \`${hit.kindOrId}\` (${hit.path})`,
    );
  }

  if (!pointers.length) {
    return {
      actionId: matched.id,
      description: matched.def.description,
      sources,
      refs,
      pointers,
      bundle: "",
      message:
        "Action matched but no instruction/suggestion/workflow notes found for its refs. Add the notes or fix registry paths.",
    };
  }

  return {
    actionId: matched.id,
    description: matched.def.description,
    sources,
    refs,
    pointers,
    bundle: input.pointers_only ? "" : parts.filter(Boolean).join("\n"),
    message: input.pointers_only
      ? "Pointers only. Follow listed paths (project over global). Instructions binding; suggestions soft."
      : "Follow binding instructions. Prefer soft suggestions without treating them as must. Project overrides global. Do not invent conflicting process.",
  };
}

export async function listActions(
  vaultPath: string,
  project?: string,
): Promise<{ sources: string[]; actions: Record<string, ActionDef> }> {
  const { registry, sources } = await loadRegistry(vaultPath, project);
  return { sources, actions: registry.actions };
}
