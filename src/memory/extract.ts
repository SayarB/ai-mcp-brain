/**
 * Smart atomic memory operations:
 * - Unicode-safe semantic + lexical deduplication on `addMemorySmart`
 * - Conflict candidate surfacing (`similarExisting`)
 * - Content-verified SQLite vector cache reuse (never uses stale vectors after external edits)
 * - Scoped hybrid search over atomic memories (`searchMemories`) with status filtering (active by default)
 */
import {
  decodeEmbedding,
  dotProduct,
  openIndexDb,
  resolveDefaultEmbedder,
  syncVaultIndex,
  tokenizeForFts,
  type Embedder,
  type SearchMode,
} from "../index/index.ts";
import { resolveProjectSlug } from "../vault.ts";
import { assertNoSecrets } from "./guard.ts";
import {
  addMemoryRaw,
  listMemories,
  sanitizeMemoryContent,
  sanitizeMemoryTitle,
  supersedeMemory,
  touchMemory,
  type AddMemoryRawInput,
  type AtomicMemory,
  type MemoryCategory,
  type MemoryScope,
  type MemoryStatus,
} from "./store.ts";

export type DedupeMode = "dedupe" | "force";

export type AddMemorySmartInput = AddMemoryRawInput & {
  dedupe?: DedupeMode;
  /** If set, atomically supersedes this existing memory ID (inherits scope/project from the old memory). */
  supersedeId?: string;
  /** Optional custom/null embedder (defaults to local ONNX embedder). */
  embedder?: Embedder | null;
  dbPath?: string;
  /** Skip triggering an index sync after write (useful in batch scripts). */
  skipSync?: boolean;
};

export type SimilarCandidate = {
  id: string;
  title: string;
  path: string;
  similarity: number;
  snippet: string;
};

export type AddMemorySmartResult = {
  action: "added" | "noop" | "superseded";
  memory: AtomicMemory;
  superseded?: AtomicMemory;
  duplicateOf?: SimilarCandidate;
  similarExisting: SimilarCandidate[];
  message: string;
};

export type SearchMemoriesOptions = {
  limit?: number;
  mode?: SearchMode;
  scope?: MemoryScope;
  project?: string;
  category?: MemoryCategory;
  app?: string;
  tags?: string[];
  status?: MemoryStatus | "all";
  embedder?: Embedder | null;
  dbPath?: string;
  skipSync?: boolean;
  minVectorScore?: number;
};

export type MemorySearchHit = {
  memory: AtomicMemory;
  score: number;
  matchedBy: ("fts" | "vector")[];
  vectorScore: number | null;
};

/** Unicode-safe normalization (preserves Latin, CJK, Hindi, Cyrillic, Arabic, digits). */
function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenizeForFts(a));
  const setB = new Set(tokenizeForFts(b));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Canonical embedding text matching how `syncVaultIndex` embeds a memory chunk,
 * so fresh and cached vectors live in the exact same text distribution.
 */
function formatMemoryForEmbedding(mem: {
  title: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
}): string {
  const tagLine = mem.tags.length ? ` [${mem.tags.join(", ")}]` : "";
  return `${mem.title} — ${mem.category}${tagLine}\n${mem.content}`;
}

/**
 * Load cached Float32 embeddings from SQLite ONLY when the cached chunk's metadata and body
 * still match the current Markdown memory (prevents stale vectors after external Obsidian/CLI edits).
 */
async function loadVerifiedCachedMemoryVectors(
  vaultPath: string,
  memories: AtomicMemory[],
  embedModel: string,
  dbPath?: string,
): Promise<Map<string, Float32Array>> {
  const result = new Map<string, Float32Array>();
  if (!memories.length) return result;
  try {
    const { db } = await openIndexDb(vaultPath, { dbPath });
    try {
      const byFile = new Map<string, Map<string, AtomicMemory>>();
      for (const m of memories) {
        const map = byFile.get(m.path) ?? new Map<string, AtomicMemory>();
        map.set(m.id, m);
        byFile.set(m.path, map);
      }

      for (const [filePath, memMap] of byFile.entries()) {
        const rows = db
          .prepare(
            `SELECT content, embedding FROM chunks
             WHERE file_path = ? AND embedding IS NOT NULL AND embed_model = ?`,
          )
          .all<{ content: string; embedding: Uint8Array }>(filePath, embedModel);
        for (const row of rows) {
          const idMatch = row.content.match(/<!--\s*mem:[^\n]*?\bid=([^\s<>]+)/);
          const id = idMatch?.[1];
          if (!id || result.has(id)) continue;
          const mem = memMap.get(id);
          if (!mem) continue;
          // Verify cached chunk matches current metadata (title, category, tags, updated) AND body
          const updMatch = row.content.match(/<!--\s*mem:[^\n]*?\bupdated=([^\s<>]+)/);
          const catMatch = row.content.match(/<!--\s*mem:[^\n]*?\bcategory=([^\s<>]+)/);
          const tagsMatch = row.content.match(/<!--\s*mem:[^\n]*?\btags=([^\s<>]+)/);
          const expectedTags = mem.tags.join(",");
          if (updMatch?.[1] !== mem.updated) continue;
          if (catMatch?.[1] !== mem.category) continue;
          if ((tagsMatch?.[1] ?? "") !== expectedTags) continue;
          if (
            !row.content
              .split(/\r?\n/)
              .some((l) => l.trim() === `### ${mem.title}`)
          ) {
            continue;
          }
          const bodyHead = mem.content.slice(0, 120).trim();
          const bodyTail = mem.content.slice(-80).trim();
          if (
            (!bodyHead || row.content.includes(bodyHead)) &&
            (!bodyTail || row.content.includes(bodyTail))
          ) {
            result.set(id, decodeEmbedding(row.embedding));
          }
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* ignore cache read error; caller embeds directly */
  }
  return result;
}

async function resolveMemoryVectors(
  vaultPath: string,
  memories: AtomicMemory[],
  embedder: Embedder,
  dbPath?: string,
): Promise<Map<string, Float32Array>> {
  const cached = await loadVerifiedCachedMemoryVectors(
    vaultPath,
    memories,
    embedder.model,
    dbPath,
  );
  const missing = memories.filter((m) => !cached.has(m.id));
  if (missing.length > 0) {
    const vecs = await embedder.embed(
      missing.map((m) => formatMemoryForEmbedding(m)),
      "document",
    );
    for (let i = 0; i < missing.length; i++) {
      cached.set(missing[i]!.id, vecs[i]!);
    }
  }
  return cached;
}

async function findSimilarMemories(
  vaultPath: string,
  incoming: { title: string; content: string; category: MemoryCategory; tags: string[] },
  existing: AtomicMemory[],
  embedder: Embedder | null,
  dbPath?: string,
): Promise<{ scores: { memory: AtomicMemory; sim: number }[]; usedVectors: boolean }> {
  if (!existing.length) return { scores: [], usedVectors: false };

  const incomingFullNorm = normalizeText(`${incoming.title} ${incoming.content}`);
  const incomingBodyNorm = normalizeText(incoming.content);

  // Exact normalized check — require non-trivial length so empty/punctuation-only strings never collide
  if (incomingFullNorm.length >= 4) {
    const exactHit = existing.find((m) => {
      const mFull = normalizeText(`${m.title} ${m.content}`);
      const mBody = normalizeText(m.content);
      return (
        (mFull.length >= 4 && mFull === incomingFullNorm) ||
        (incomingBodyNorm.length >= 12 && mBody === incomingBodyNorm)
      );
    });
    if (exactHit) {
      return {
        scores: [{ memory: exactHit, sim: 1.0 }],
        usedVectors: false,
      };
    }
  }

  if (embedder) {
    try {
      const [qVec] = await embedder.embed(
        [formatMemoryForEmbedding(incoming)],
        "document",
      );
      const vecMap = await resolveMemoryVectors(vaultPath, existing, embedder, dbPath);
      if (qVec) {
        const scored = existing
          .map((memory) => {
            const v = vecMap.get(memory.id);
            return {
              memory,
              sim: v ? Math.round(dotProduct(qVec, v) * 1000) / 1000 : 0,
            };
          })
          .sort((a, b) => b.sim - a.sim);
        return { scores: scored, usedVectors: true };
      }
    } catch {
      /* fall through to lexical similarity */
    }
  }

  const incomingText = `${incoming.title} ${incoming.content}`;
  const scored = existing.map((memory) => ({
    memory,
    sim:
      Math.round(
        jaccardSimilarity(incomingText, `${memory.title} ${memory.content}`) * 1000,
      ) / 1000,
  }));
  scored.sort((a, b) => b.sim - a.sim);
  return { scores: scored, usedVectors: false };
}

export async function addMemorySmart(
  vaultPath: string,
  input: AddMemorySmartInput,
): Promise<AddMemorySmartResult> {
  const title = sanitizeMemoryTitle(input.title);
  const content = sanitizeMemoryContent(input.content);
  assertNoSecrets(title, content);

  const embedder =
    input.embedder !== undefined ? input.embedder : resolveDefaultEmbedder();

  // Explicit supersede path (inherits scope/project from the superseded memory)
  if (input.supersedeId) {
    const { superseded, created } = await supersedeMemory(
      vaultPath,
      input.supersedeId,
      {
        title,
        content,
        tags: input.tags,
        app: input.app,
        category: input.category,
      },
    );
    if (!input.skipSync) {
      await syncVaultIndex(vaultPath, { dbPath: input.dbPath, embedder }).catch(
        () => {},
      );
    }
    return {
      action: "superseded",
      memory: created,
      superseded,
      similarExisting: [],
      message: `Superseded ${superseded.id} with ${created.id} in ${created.path}`,
    };
  }

  const scope: MemoryScope =
    input.scope ?? (input.project ? "project" : "global");
  const category: MemoryCategory =
    input.category ?? (scope === "project" ? "decisions" : "facts");
  const resolvedProject =
    scope === "project" && input.project
      ? await resolveProjectSlug(vaultPath, input.project)
      : undefined;

  const dedupeMode: DedupeMode = input.dedupe ?? "dedupe";
  const similarExisting: SimilarCandidate[] = [];

  if (dedupeMode === "dedupe") {
    const existing = await listMemories(vaultPath, {
      scope,
      project: resolvedProject,
      status: "active",
    });

    const { scores, usedVectors } = await findSimilarMemories(
      vaultPath,
      { title, content, category, tags: input.tags ?? [] },
      existing,
      embedder,
      input.dbPath,
    );

    const isBge = usedVectors && embedder ? /bge-/i.test(embedder.model) : false;
    const dupThreshold = usedVectors ? (isBge ? 0.91 : 0.88) : 0.82;
    const conflictThreshold = usedVectors ? (isBge ? 0.78 : 0.72) : 0.45;

    const top = scores[0];
    if (top && top.sim >= dupThreshold) {
      // Preserve original `app`, bump `updated`, merge any new tags, and sync index
      const refreshed = await touchMemory(vaultPath, top.memory.id, input.tags);
      if (!input.skipSync) {
        await syncVaultIndex(vaultPath, { dbPath: input.dbPath, embedder }).catch(
          () => {},
        );
      }
      const dup: SimilarCandidate = {
        id: refreshed.id,
        title: refreshed.title,
        path: refreshed.path,
        similarity: top.sim,
        snippet: refreshed.content.slice(0, 160),
      };
      return {
        action: "noop",
        memory: refreshed,
        duplicateOf: dup,
        similarExisting: [],
        message: `Duplicate of existing active memory ${refreshed.id} (sim=${top.sim}); refreshed updated date without duplicating.`,
      };
    }

    for (const s of scores) {
      if (s.sim >= conflictThreshold) {
        similarExisting.push({
          id: s.memory.id,
          title: s.memory.title,
          path: s.memory.path,
          similarity: s.sim,
          snippet: s.memory.content.slice(0, 160),
        });
      }
      if (similarExisting.length >= 3) break;
    }
  }

  const created = await addMemoryRaw(vaultPath, {
    ...input,
    title,
    content,
    scope,
    category,
    project: resolvedProject ?? input.project,
  });

  if (!input.skipSync) {
    await syncVaultIndex(vaultPath, { dbPath: input.dbPath, embedder }).catch(
      () => {},
    );
  }

  const conflictHint = similarExisting.length
    ? ` (${similarExisting.length} similar active memory candidate(s) found — call supersede_memory if this replaces an older entry)`
    : "";

  return {
    action: "added",
    memory: created,
    similarExisting,
    message: `Added memory ${created.id} in ${created.path}${conflictHint}`,
  };
}

/**
 * Search atomic memories with hybrid lexical + vector similarity + strict status/category/app filters.
 * Defaults to `status: "active"` so superseded memories never pollute active recall.
 */
export async function searchMemories(
  vaultPath: string,
  query: string,
  opts: SearchMemoriesOptions = {},
): Promise<{ hits: MemorySearchHit[]; modeUsed: SearchMode; searchMs: number }> {
  const started = performance.now();
  const limit = opts.limit ?? 10;
  const requestedMode: SearchMode = opts.mode ?? "hybrid";
  if (!query.trim()) {
    return { hits: [], modeUsed: requestedMode, searchMs: 0 };
  }

  const candidates = await listMemories(vaultPath, {
    scope: opts.scope,
    project: opts.project,
    category: opts.category,
    app: opts.app,
    tags: opts.tags,
    status: opts.status ?? "active",
  });

  if (!candidates.length) {
    return {
      hits: [],
      modeUsed: requestedMode,
      searchMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }

  // Channel 1: Lexical match over atomic memory entries (Unicode-safe)
  const queryTokens = tokenizeForFts(query);
  const ftsScored: { memory: AtomicMemory; score: number }[] = [];

  if (requestedMode !== "vector" && queryTokens.length) {
    for (const mem of candidates) {
      const hay = `${mem.title} ${mem.content} ${mem.tags.join(" ")} ${mem.category}`.toLowerCase();
      const titleLower = mem.title.toLowerCase();
      let matchedTokens = 0;
      let rawScore = 0;
      for (const tok of queryTokens) {
        const stem =
          /^[a-z]+$/.test(tok) && tok.length > 4
            ? tok.slice(0, Math.max(4, tok.length - 2))
            : tok;
        if (hay.includes(stem)) {
          matchedTokens++;
          rawScore += 2;
          if (titleLower.includes(stem)) rawScore += 3;
        }
      }
      const minNeeded = queryTokens.length >= 4 ? 2 : 1;
      if (matchedTokens >= minNeeded) {
        if (matchedTokens === queryTokens.length) rawScore += 4;
        ftsScored.push({ memory: mem, score: rawScore });
      }
    }
    ftsScored.sort((a, b) => b.score - a.score);
  }

  // Channel 2: Vector cosine similarity over atomic memories (reuses content-verified SQLite cache)
  const embedder =
    requestedMode === "fts"
      ? null
      : opts.embedder !== undefined
        ? opts.embedder
        : resolveDefaultEmbedder();

  let vecScored: { memory: AtomicMemory; cosine: number }[] = [];
  let modeUsed: SearchMode = requestedMode;

  if (requestedMode !== "fts" && embedder) {
    const minSim =
      opts.minVectorScore ?? (/bge-/i.test(embedder.model) ? 0.6 : 0.35);
    try {
      if (!opts.skipSync) {
        await syncVaultIndex(vaultPath, { dbPath: opts.dbPath, embedder }).catch(
          () => {},
        );
      }
      const [qVec] = await embedder.embed([query], "query");
      const vecMap = await resolveMemoryVectors(
        vaultPath,
        candidates,
        embedder,
        opts.dbPath,
      );
      if (qVec) {
        for (const mem of candidates) {
          const v = vecMap.get(mem.id);
          if (!v) continue;
          const cosine = dotProduct(qVec, v);
          if (cosine >= minSim) {
            vecScored.push({ memory: mem, cosine });
          }
        }
        vecScored.sort((a, b) => b.cosine - a.cosine);
      }
    } catch {
      if (requestedMode === "hybrid") modeUsed = "fts";
    }
  } else if (requestedMode === "hybrid" && !embedder) {
    modeUsed = "fts";
  }

  // RRF fusion by memory ID
  const RRF_K = 60;
  const agg = new Map<
    string,
    {
      memory: AtomicMemory;
      score: number;
      matchedBy: Set<"fts" | "vector">;
      vectorScore: number | null;
    }
  >();

  for (let i = 0; i < ftsScored.length; i++) {
    const item = ftsScored[i]!;
    agg.set(item.memory.id, {
      memory: item.memory,
      score: 1 / (RRF_K + i + 1),
      matchedBy: new Set(["fts"]),
      vectorScore: null,
    });
  }

  for (let i = 0; i < vecScored.length; i++) {
    const item = vecScored[i]!;
    const contrib = 1 / (RRF_K + i + 1);
    const prev = agg.get(item.memory.id);
    if (prev) {
      prev.score += contrib;
      prev.matchedBy.add("vector");
      prev.vectorScore = Math.round(item.cosine * 1000) / 1000;
    } else {
      agg.set(item.memory.id, {
        memory: item.memory,
        score: contrib,
        matchedBy: new Set(["vector"]),
        vectorScore: Math.round(item.cosine * 1000) / 1000,
      });
    }
  }

  const hits: MemorySearchHit[] = [...agg.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit))
    .map((x) => ({
      memory: x.memory,
      score: Math.round(x.score * 10000) / 10000,
      matchedBy: [...x.matchedBy],
      vectorScore: x.vectorScore,
    }));

  return {
    hits,
    modeUsed,
    searchMs: Math.round((performance.now() - started) * 100) / 100,
  };
}
