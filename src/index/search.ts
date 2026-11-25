/**
 * Hybrid retrieval engine: SQLite FTS5 (BM25 + Porter stemming) + local vector cosine similarity,
 * fused via Reciprocal Rank Fusion (RRF), recency boost, structured filters, and 1-hop [[wikilink]] graph context.
 */
import { slugify } from "../vault.ts";
import { openIndexDb } from "./db.ts";
import {
  decodeEmbedding,
  dotProduct,
  resolveDefaultEmbedder,
  type Embedder,
} from "./embed.ts";
import type { SqlDatabase, SqlValue } from "./sqlite.ts";
import { syncVaultIndex, syncVaultIndexOnDb, type SyncStats } from "./sync.ts";

export type SearchMode = "hybrid" | "fts" | "vector";

export type HybridSearchOptions = {
  limit?: number;
  mode?: SearchMode;
  project?: string;
  scope?: "global" | "project";
  type?: string;
  tags?: string[];
  updatedAfter?: string;
  dbPath?: string;
  skipSync?: boolean;
  embedder?: Embedder | null;
  /** Minimum cosine similarity for a vector-only hit to enter results (default 0.42). */
  minVectorScore?: number;
};

export type HybridSearchHit = {
  path: string;
  title: string;
  heading: string;
  score: number;
  snippet: string;
  type: string | null;
  scope: string | null;
  project: string | null;
  updated: string | null;
  tags: string[];
  matchedBy: ("fts" | "vector")[];
  ftsRank: number | null;
  vectorScore: number | null;
  relatedLinks: string[];
};

export type HybridSearchResult = {
  hits: HybridSearchHit[];
  modeUsed: SearchMode;
  syncStats?: SyncStats;
  embedWarning?: string;
  searchMs: number;
};

const RRF_K = 60;
const FTS_WEIGHT = 1.0;
const VECTOR_WEIGHT = 1.0;
// Calibrated empirically for BGE-small-en-v1.5 (unrelated English pairs cluster ~0.48–0.58; relevant pairs >= 0.62)
const DEFAULT_MIN_VECTOR_SCORE = 0.6;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "for", "from", "get", "gets",
  "had", "has", "have", "how", "if", "in", "into", "is", "it", "its", "just",
  "keep", "keeps", "make", "may", "me", "my", "no", "not", "of", "off", "on",
  "or", "our", "out", "over", "run", "should", "so", "some", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "to", "too",
  "up", "us", "use", "using", "was", "we", "were", "what", "when", "where",
  "which", "who", "why", "will", "with", "would", "you", "your",
]);

/** Tokenize a user query into safe FTS5 terms (no operator injection or syntax errors). */
export function tokenizeForFts(query: string): string[] {
  const all = query
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const filtered = all.filter((t) => !STOPWORDS.has(t));
  // Fall back to unfiltered tokens if the query was exclusively stopwords
  return [...new Set(filtered.length ? filtered : all)];
}

function buildFtsExpr(tokens: string[], op: "AND" | "OR"): string {
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(` ${op} `);
}

function defaultMinVectorScore(model: string | null): number {
  const envRaw = process.env.BRAIN_MIN_VECTOR_SCORE?.trim();
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  if (model && /bge-/i.test(model)) return DEFAULT_MIN_VECTOR_SCORE;
  return 0.38;
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function buildFilterWhere(opts: HybridSearchOptions): {
  clause: string;
  params: SqlValue[];
} {
  const parts: string[] = [];
  const params: SqlValue[] = [];

  if (opts.project) {
    const raw = opts.project.trim();
    const slug = slugify(raw);
    parts.push("(LOWER(f.project) = LOWER(?) OR LOWER(f.project) = LOWER(?))");
    params.push(raw, slug);
  }
  if (opts.scope) {
    parts.push("LOWER(f.scope) = LOWER(?)");
    params.push(opts.scope);
  }
  if (opts.type) {
    parts.push("LOWER(f.type) = LOWER(?)");
    params.push(opts.type.trim());
  }
  if (opts.updatedAfter) {
    parts.push("f.updated IS NOT NULL AND f.updated >= ?");
    params.push(opts.updatedAfter.trim());
  }
  if (opts.tags?.length) {
    for (const tag of opts.tags) {
      const cleaned = tag.trim().toLowerCase();
      if (!cleaned) continue;
      // Match exact JSON-encoded string element inside tags array (e.g. ["backend"]),
      // avoiding partial substring false matches like "back" -> "backend".
      const quoted = JSON.stringify(cleaned);
      parts.push("LOWER(f.tags) LIKE ? ESCAPE '\\'");
      params.push(`%${escapeSqlLike(quoted)}%`);
    }
  }

  return {
    clause: parts.length ? `AND ${parts.join(" AND ")}` : "",
    params,
  };
}

function recencyMultiplier(updated: string | null): number {
  if (!updated) return 1.0;
  const ts = Date.parse(updated);
  if (Number.isNaN(ts)) return 1.0;
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  // Up to +8% boost for fresh notes, decaying smoothly over 1 year
  return 1.0 + 0.08 * Math.exp(-ageDays / 120);
}

function makeSnippet(content: string, tokens: string[], maxLen = 220): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;

  const lower = flat.toLowerCase();
  let bestIdx = -1;
  for (const tok of tokens) {
    const idx = lower.indexOf(tok);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
    }
  }
  if (bestIdx === -1) return `${flat.slice(0, maxLen)}…`;

  const start = Math.max(0, bestIdx - 60);
  const end = Math.min(flat.length, start + maxLen);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return `${prefix}${flat.slice(start, end).trim()}${suffix}`;
}

type ChunkCandidateRow = {
  id: number;
  file_path: string;
  heading: string;
  content: string;
  title: string;
  type: string | null;
  scope: string | null;
  project: string | null;
  tags: string;
  updated: string | null;
};

type FtsRow = ChunkCandidateRow & { bm25_score: number };
type VecRow = ChunkCandidateRow & { embedding: Uint8Array };

function queryFts(
  db: SqlDatabase,
  tokens: string[],
  filter: { clause: string; params: SqlValue[] },
  candidateLimit: number,
): FtsRow[] {
  if (!tokens.length) return [];

  const runExpr = (expr: string, limit: number): FtsRow[] => {
    try {
      return db
        .prepare(
          `SELECT c.id, c.file_path, c.heading, c.content,
                  f.title, f.type, f.scope, f.project, f.tags, f.updated,
                  bm25(chunks_fts, 2.0, 4.0, 3.0, 1.0, 2.5) AS bm25_score
           FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
           JOIN files f ON f.path = c.file_path
           WHERE chunks_fts MATCH ?
           ${filter.clause}
           ORDER BY bm25_score ASC
           LIMIT ?`,
        )
        .all<FtsRow>(expr, ...filter.params, limit);
    } catch {
      return [];
    }
  };

  // Run strict AND first so multi-word exact hits always rank ahead of partial OR hits
  const andRows = runExpr(buildFtsExpr(tokens, "AND"), candidateLimit);
  if (tokens.length === 1 || andRows.length >= candidateLimit) {
    return andRows;
  }

  const orRows = runExpr(buildFtsExpr(tokens, "OR"), candidateLimit);
  // For longer queries (>= 4 content tokens), require at least 2 distinct token prefixes
  // in the matched chunk/title/path so a single accidental word doesn't trigger false positives.
  const minOrMatches = tokens.length >= 4 ? 2 : 1;
  const seen = new Set(andRows.map((r) => r.id));
  const merged = [...andRows];
  for (const row of orRows) {
    if (seen.has(row.id)) continue;
    if (minOrMatches > 1) {
      const hay = `${row.file_path} ${row.title} ${row.heading} ${row.content} ${row.tags}`.toLowerCase();
      let matched = 0;
      for (const tok of tokens) {
        const stem = tok.length > 4 ? tok.slice(0, Math.max(4, tok.length - 2)) : tok;
        if (hay.includes(stem)) matched++;
      }
      if (matched < minOrMatches) continue;
    }
    seen.add(row.id);
    merged.push(row);
    if (merged.length >= candidateLimit) break;
  }
  return merged;
}

function queryVectors(
  db: SqlDatabase,
  queryVec: Float32Array,
  embedModel: string,
  filter: { clause: string; params: SqlValue[] },
  candidateLimit: number,
  minScore: number,
): (ChunkCandidateRow & { cosine: number })[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.file_path, c.heading, c.content, c.embedding,
              f.title, f.type, f.scope, f.project, f.tags, f.updated
       FROM chunks c
       JOIN files f ON f.path = c.file_path
       WHERE c.embedding IS NOT NULL
         AND c.embed_model = ?
       ${filter.clause}`,
    )
    .all<VecRow>(embedModel, ...filter.params);

  const scored: (ChunkCandidateRow & { cosine: number })[] = [];
  for (const row of rows) {
    const vec = decodeEmbedding(row.embedding);
    const cosine = dotProduct(queryVec, vec);
    if (cosine >= minScore) {
      scored.push({
        id: row.id,
        file_path: row.file_path,
        heading: row.heading,
        content: row.content,
        title: row.title,
        type: row.type,
        scope: row.scope,
        project: row.project,
        tags: row.tags,
        updated: row.updated,
        cosine,
      });
    }
  }
  scored.sort((a, b) => b.cosine - a.cosine);
  return scored.slice(0, candidateLimit);
}

function getRelatedLinks(db: SqlDatabase, filePath: string, limit = 6): string[] {
  const outgoing = db
    .prepare(
      `SELECT DISTINCT resolved_path AS p FROM links
       WHERE src_path = ? AND resolved_path IS NOT NULL AND resolved_path != ?`,
    )
    .all<{ p: string }>(filePath, filePath);
  const incoming = db
    .prepare(
      `SELECT DISTINCT src_path AS p FROM links
       WHERE resolved_path = ? AND src_path != ?`,
    )
    .all<{ p: string }>(filePath, filePath);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of [...outgoing, ...incoming]) {
    if (!seen.has(row.p)) {
      seen.add(row.p);
      out.push(row.p);
    }
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchHybrid(
  vaultPath: string,
  query: string,
  opts: HybridSearchOptions = {},
): Promise<HybridSearchResult> {
  const requestedMode: SearchMode = opts.mode ?? "hybrid";
  if (!query.trim()) {
    return {
      hits: [],
      modeUsed: requestedMode,
      searchMs: 0,
    };
  }
  const limit = opts.limit ?? 10;
  const candidateLimit = Math.max(limit * 4, 30);

  const embedder =
    requestedMode === "fts"
      ? null
      : opts.embedder !== undefined
        ? opts.embedder
        : resolveDefaultEmbedder();

  const minVectorScore =
    opts.minVectorScore ?? defaultMinVectorScore(embedder?.model ?? null);

  let syncStats: SyncStats | undefined;
  if (!opts.skipSync && opts.dbPath !== ":memory:") {
    syncStats = await syncVaultIndex(vaultPath, {
      dbPath: opts.dbPath,
      embedder,
    });
  }

  const { db, dbPath, rebuilt } = await openIndexDb(vaultPath, {
    dbPath: opts.dbPath,
  });

  try {
    if (!opts.skipSync && opts.dbPath === ":memory:") {
      syncStats = await syncVaultIndexOnDb(db, vaultPath, dbPath, rebuilt, {
        embedder,
      });
    }
    const searchStarted = performance.now();
    const filter = buildFilterWhere(opts);
    const tokens = tokenizeForFts(query);

    // Channel 1: FTS5 BM25
    const ftsRows =
      requestedMode === "vector"
        ? []
        : queryFts(db, tokens, filter, candidateLimit);

    // Channel 2: Local vector cosine
    let vecRows: (ChunkCandidateRow & { cosine: number })[] = [];
    let embedWarning = syncStats?.embedWarning;
    let modeUsed: SearchMode = requestedMode;

    if (requestedMode !== "fts" && embedder && !embedWarning) {
      try {
        const [queryVec] = await embedder.embed([query], "query");
        if (queryVec) {
          vecRows = queryVectors(
            db,
            queryVec,
            embedder.model,
            filter,
            candidateLimit,
            minVectorScore,
          );
        }
      } catch (err) {
        embedWarning = err instanceof Error ? err.message : String(err);
        if (requestedMode === "hybrid") modeUsed = "fts";
      }
    } else if (requestedMode === "hybrid" && !embedder) {
      modeUsed = "fts";
    }

    // Reciprocal Rank Fusion at chunk level, then aggregate best chunk per note
    type Agg = {
      row: ChunkCandidateRow;
      score: number;
      ftsRank: number | null;
      vectorScore: number | null;
      matchedBy: Set<"fts" | "vector">;
    };
    const byChunk = new Map<number, Agg>();

    for (let i = 0; i < ftsRows.length; i++) {
      const row = ftsRows[i]!;
      const rank = i + 1;
      const contrib = FTS_WEIGHT / (RRF_K + rank);
      byChunk.set(row.id, {
        row,
        score: contrib,
        ftsRank: rank,
        vectorScore: null,
        matchedBy: new Set(["fts"]),
      });
    }

    for (let i = 0; i < vecRows.length; i++) {
      const row = vecRows[i]!;
      const rank = i + 1;
      const contrib = VECTOR_WEIGHT / (RRF_K + rank);
      const prev = byChunk.get(row.id);
      if (prev) {
        prev.score += contrib;
        prev.vectorScore = Math.round(row.cosine * 1000) / 1000;
        prev.matchedBy.add("vector");
      } else {
        byChunk.set(row.id, {
          row,
          score: contrib,
          ftsRank: null,
          vectorScore: Math.round(row.cosine * 1000) / 1000,
          matchedBy: new Set(["vector"]),
        });
      }
    }

    // Deduplicate to best-scoring chunk per file + apply gentle recency multiplier
    const byFile = new Map<string, Agg>();
    for (const agg of byChunk.values()) {
      const adjusted = agg.score * recencyMultiplier(agg.row.updated);
      const prev = byFile.get(agg.row.file_path);
      if (!prev || adjusted > prev.score) {
        byFile.set(agg.row.file_path, { ...agg, score: adjusted });
      }
    }

    const sorted = [...byFile.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const hits: HybridSearchHit[] = sorted.map((agg) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(agg.row.tags) as string[];
      } catch {
        /* ignore */
      }
      return {
        path: agg.row.file_path,
        title: agg.row.title,
        heading: agg.row.heading,
        score: Math.round(agg.score * 10000) / 10000,
        snippet: makeSnippet(agg.row.content, tokens),
        type: agg.row.type,
        scope: agg.row.scope,
        project: agg.row.project,
        updated: agg.row.updated,
        tags,
        matchedBy: [...agg.matchedBy],
        ftsRank: agg.ftsRank,
        vectorScore: agg.vectorScore,
        relatedLinks: getRelatedLinks(db, agg.row.file_path),
      };
    });

    return {
      hits,
      modeUsed,
      syncStats,
      embedWarning,
      searchMs: Math.round((performance.now() - searchStarted) * 100) / 100,
    };
  } finally {
    db.close();
  }
}
