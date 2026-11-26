/**
 * `brain dream` — Sleep-time memory consolidation & vault hygiene engine.
 *
 * Safe by default (`apply: false` = dry-run preview).
 * Detects:
 *  1. Near-duplicate active memory clusters (merges tags into canonical keeper, marks duplicates superseded).
 *  2. Potential contradiction / overlap candidates for human review.
 *  3. Old superseded blocks (> pruneDays) — losslessly archived to `_meta/archive/memories-YYYY-MM.md` before pruning.
 *  4. Dangling `superseded_by` references where the replacement ID no longer exists.
 *  5. Broken `[[wikilinks]]` from the local SQLite index.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  canReadTarget,
  canWriteTarget,
  inferNoteScopeAndProject,
  type AppPolicy,
} from "../daemon/acl.ts";
import {
  decodeEmbedding,
  dotProduct,
  openIndexDb,
  syncVaultIndex,
  tokenizeForFts,
  type Embedder,
} from "../index/index.ts";
import { pathExists, writeText } from "../runtime.ts";
import { resolveProjectSlug } from "../vault.ts";
import {
  deleteMemory,
  listMemories,
  markMemorySupersededBy,
  renderMemoryBlock,
  updateMemory,
  type AtomicMemory,
} from "./store.ts";

export type DreamOptions = {
  /** When false (default), computes full consolidation plan without modifying disk. */
  apply?: boolean;
  /** Restrict consolidation to a single project slug/path/remote. */
  project?: string;
  /** Archive & prune `status=superseded` memories older than this many days (default 90; 0 disables pruning). */
  pruneDays?: number;
  /** Optional ACL policy enforced when invoked via MCP. */
  policy?: AppPolicy | null;
  dbPath?: string;
  embedder?: Embedder | null;
};

export type DuplicateCluster = {
  keeper: { id: string; title: string; path: string; updated: string };
  duplicates: { id: string; title: string; path: string; similarity: number }[];
  mergedTags: string[];
};

export type ConflictPair = {
  a: { id: string; title: string; path: string };
  b: { id: string; title: string; path: string };
  similarity: number;
  reason: string;
};

export type StaleSupersededItem = {
  id: string;
  title: string;
  path: string;
  updated: string;
  ageDays: number;
  supersededBy: string | null;
};

export type DanglingLinkItem = {
  srcPath: string;
  rawTarget: string;
};

export type DreamReport = {
  dryRun: boolean;
  project: string | null;
  scannedActive: number;
  scannedSuperseded: number;
  duplicateClusters: DuplicateCluster[];
  conflicts: ConflictPair[];
  staleSuperseded: StaleSupersededItem[];
  danglingSupersedeRefs: { id: string; missingReplacementId: string; path: string }[];
  brokenWikilinks: DanglingLinkItem[];
  actionsApplied: {
    duplicatesConsolidated: number;
    supersededArchivedAndPruned: number;
    archivePath: string | null;
  };
  summary: string;
};

function norm(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a: string, b: string): number {
  const sa = new Set(tokenizeForFts(a));
  const sb = new Set(tokenizeForFts(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

function ageInDays(isoDate: string, nowMs: number): number {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.floor((nowMs - parsed) / (24 * 60 * 60 * 1000)));
}

function pairSimilarity(
  a: AtomicMemory,
  b: AtomicMemory,
  vectors: Map<string, Float32Array>,
): number {
  const na = norm(`${a.title} ${a.content}`);
  const nb = norm(`${b.title} ${b.content}`);
  if (na && na === nb) return 1.0;

  const lex = jaccard(`${a.title} ${a.content}`, `${b.title} ${b.content}`);
  const titleExact = norm(a.title) !== "" && norm(a.title) === norm(b.title);
  const va = vectors.get(a.id);
  const vb = vectors.get(b.id);
  const cos = va && vb && va.length === vb.length ? Math.max(0, dotProduct(va, vb)) : null;

  if (cos !== null) {
    return Math.round(Math.max(lex, cos * 0.85 + lex * 0.15) * 1000) / 1000;
  }
  return Math.round(Math.max(lex, titleExact ? Math.max(lex, 0.76) : lex) * 1000) / 1000;
}

async function loadMemoryVectorsFromIndex(
  vaultPath: string,
  memories: AtomicMemory[],
  dbPath?: string,
): Promise<Map<string, Float32Array>> {
  const map = new Map<string, Float32Array>();
  if (!memories.length) return map;
  let db;
  try {
    ({ db } = await openIndexDb(vaultPath, { dbPath }));
    const rows = db
      .prepare(
        "SELECT file_path, content, embedding FROM chunks WHERE embedding IS NOT NULL",
      )
      .all<{ file_path: string; content: string; embedding: Uint8Array }>();

    const byPath = new Map<string, { content: string; vec: Float32Array }[]>();
    for (const r of rows) {
      if (!r.embedding) continue;
      const list = byPath.get(r.file_path) ?? [];
      list.push({ content: r.content, vec: decodeEmbedding(r.embedding) });
      byPath.set(r.file_path, list);
    }

    for (const m of memories) {
      const chunks = byPath.get(m.path);
      if (!chunks) continue;
      const hit = chunks.find(
        (c) => c.content.includes(`### ${m.title}`) && c.content.includes(m.content.slice(0, 48)),
      );
      if (hit) map.set(m.id, hit.vec);
    }
  } catch {
    // Index absent or unavailable — fall back cleanly to lexical scoring
  } finally {
    db?.close();
  }
  return map;
}

async function queryBrokenWikilinks(
  vaultPath: string,
  opts: { dbPath?: string; project?: string | null; policy?: AppPolicy | null },
): Promise<DanglingLinkItem[]> {
  let db;
  try {
    ({ db } = await openIndexDb(vaultPath, { dbPath: opts.dbPath }));
    const rows = db
      .prepare(
        "SELECT src_path, raw_target FROM links WHERE resolved_path IS NULL ORDER BY src_path, raw_target LIMIT 50",
      )
      .all<{ src_path: string; raw_target: string }>();

    return rows
      .filter((r) => {
        const inf = inferNoteScopeAndProject(r.src_path);
        if (opts.project && inf.project !== opts.project) return false;
        if (opts.policy && !canReadTarget(opts.policy, inf.scope, inf.project)) return false;
        return true;
      })
      .map((r) => ({ srcPath: r.src_path, rawTarget: r.raw_target }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

async function appendToArchive(
  vaultPath: string,
  memories: AtomicMemory[],
): Promise<string> {
  const ym = new Date().toISOString().slice(0, 7);
  const relPath = `_meta/archive/memories-${ym}.md`;
  const absPath = join(vaultPath, relPath);
  await mkdir(dirname(absPath), { recursive: true });

  const existed = await pathExists(absPath);
  const blocks = memories
    .map((m) => `<!-- archived_from: ${m.path} -->\n${renderMemoryBlock(m)}`)
    .join("\n\n");

  if (!existed) {
    const header = [
      "---",
      "type: archive",
      "scope: global",
      `updated: ${new Date().toISOString().slice(0, 10)}`,
      "---",
      "",
      `# Archived Superseded Memories (${ym})`,
      "",
      blocks,
      "",
    ].join("\n");
    await writeText(absPath, header);
  } else {
    await appendFile(absPath, `\n\n${blocks}\n`, "utf8");
  }
  return relPath;
}

export async function runDreamConsolidation(
  vaultPath: string,
  opts: DreamOptions = {},
): Promise<DreamReport> {
  const apply = Boolean(opts.apply);
  const pruneDays = opts.pruneDays === undefined ? 90 : Math.max(0, Math.trunc(opts.pruneDays));
  const policy = opts.policy ?? null;
  const canonicalProject = opts.project?.trim()
    ? await resolveProjectSlug(vaultPath, opts.project.trim())
    : null;

  const allRaw = await listMemories(vaultPath, {
    status: "all",
    project: canonicalProject ?? undefined,
    scope: canonicalProject ? "project" : undefined,
  });

  const visible = policy
    ? allRaw.filter((m) => canReadTarget(policy, m.scope, m.project))
    : allRaw;

  const active = visible.filter((m) => m.status === "active");
  const superseded = visible.filter((m) => m.status === "superseded");
  const allIdSet = new Set(allRaw.map((m) => m.id));

  const vectors = await loadMemoryVectorsFromIndex(vaultPath, active, opts.dbPath);

  // 1. Group active memories by (scope, project, category) and detect duplicate clusters & conflicts
  const buckets = new Map<string, AtomicMemory[]>();
  for (const m of active) {
    const key = `${m.scope}|${m.project ?? ""}|${m.category}`;
    const list = buckets.get(key) ?? [];
    list.push(m);
    buckets.set(key, list);
  }

  const duplicateClusters: DuplicateCluster[] = [];
  const conflicts: ConflictPair[] = [];
  const clusteredIds = new Set<string>();

  for (const group of buckets.values()) {
    // Sort canonical keeper candidates: newest updated first, then longest content
    const sorted = [...group].sort((a, b) => {
      const d = b.updated.localeCompare(a.updated);
      if (d !== 0) return d;
      return b.content.length - a.content.length;
    });

    for (let i = 0; i < sorted.length; i++) {
      const keeper = sorted[i]!;
      if (clusteredIds.has(keeper.id)) continue;

      const dups: { mem: AtomicMemory; sim: number }[] = [];
      for (let j = i + 1; j < sorted.length; j++) {
        const other = sorted[j]!;
        if (clusteredIds.has(other.id)) continue;

        const sim = pairSimilarity(keeper, other, vectors);
        const sameTitleDiffBody =
          norm(keeper.title) !== "" &&
          norm(keeper.title) === norm(other.title) &&
          norm(keeper.content) !== norm(other.content);

        if (sim >= 0.88 && !sameTitleDiffBody) {
          dups.push({ mem: other, sim });
          clusteredIds.add(other.id);
        } else if (sameTitleDiffBody || (sim >= 0.68 && sim < 0.88)) {
          conflicts.push({
            a: { id: keeper.id, title: keeper.title, path: keeper.path },
            b: { id: other.id, title: other.title, path: other.path },
            similarity: sim,
            reason: sameTitleDiffBody
              ? "same title with differing content"
              : "high semantic/lexical overlap",
          });
        }
      }

      if (dups.length) {
        clusteredIds.add(keeper.id);
        const mergedTags = [
          ...new Set([
            ...keeper.tags,
            ...dups.flatMap((d) => d.mem.tags),
          ]),
        ];
        duplicateClusters.push({
          keeper: {
            id: keeper.id,
            title: keeper.title,
            path: keeper.path,
            updated: keeper.updated,
          },
          duplicates: dups.map((d) => ({
            id: d.mem.id,
            title: d.mem.title,
            path: d.mem.path,
            similarity: d.sim,
          })),
          mergedTags,
        });
      }
    }
  }

  // 2. Identify old superseded memories eligible for lossless archive + prune
  const nowMs = Date.now();
  const staleSupersededMems: AtomicMemory[] = [];
  const staleSuperseded: StaleSupersededItem[] = [];
  if (pruneDays > 0) {
    for (const m of superseded) {
      const age = ageInDays(m.updated, nowMs);
      if (age >= pruneDays) {
        staleSupersededMems.push(m);
        staleSuperseded.push({
          id: m.id,
          title: m.title,
          path: m.path,
          updated: m.updated,
          ageDays: age,
          supersededBy: m.supersededBy ?? null,
        });
      }
    }
  }

  // 3. Detect dangling supersededBy references
  const danglingSupersedeRefs: DreamReport["danglingSupersedeRefs"] = [];
  for (const m of superseded) {
    if (m.supersededBy && !allIdSet.has(m.supersededBy)) {
      danglingSupersedeRefs.push({
        id: m.id,
        missingReplacementId: m.supersededBy,
        path: m.path,
      });
    }
  }

  // 4. Query broken wikilinks from SQLite index
  const brokenWikilinks = await queryBrokenWikilinks(vaultPath, {
    dbPath: opts.dbPath,
    project: canonicalProject,
    policy,
  });

  // 5. Apply mutations ONLY when `apply: true`
  let duplicatesConsolidated = 0;
  let supersededArchivedAndPruned = 0;
  let archivePath: string | null = null;

  if (apply) {
    const activeById = new Map(active.map((m) => [m.id, m]));
    for (const cluster of duplicateClusters) {
      const keeperMem = activeById.get(cluster.keeper.id);
      if (!keeperMem) continue;
      if (policy && !canWriteTarget(policy, keeperMem.scope, keeperMem.project)) continue;

      const tagsChanged =
        cluster.mergedTags.length !== keeperMem.tags.length ||
        cluster.mergedTags.some((t) => !keeperMem.tags.includes(t));
      if (tagsChanged) {
        await updateMemory(vaultPath, {
          id: keeperMem.id,
          tags: cluster.mergedTags,
        });
      }
      for (const dup of cluster.duplicates) {
        const dupMem = activeById.get(dup.id);
        if (!dupMem) continue;
        if (policy && !canWriteTarget(policy, dupMem.scope, dupMem.project)) continue;
        await markMemorySupersededBy(vaultPath, dup.id, keeperMem.id);
        duplicatesConsolidated++;
      }
    }

    const prunable = staleSupersededMems.filter(
      (m) => !policy || (canWriteTarget(policy, m.scope, m.project) && canWriteTarget(policy, "global")),
    );
    if (prunable.length) {
      archivePath = await appendToArchive(vaultPath, prunable);
      for (const m of prunable) {
        await deleteMemory(vaultPath, m.id);
        supersededArchivedAndPruned++;
      }
    }

    if (duplicatesConsolidated > 0 || supersededArchivedAndPruned > 0) {
      await syncVaultIndex(vaultPath, {
        dbPath: opts.dbPath,
        embedder: opts.embedder,
      }).catch(() => {});
    }
  }

  const summary = [
    apply ? "Dream consolidation applied" : "Dream consolidation preview (dry-run; pass --apply to write)",
    `scanned ${active.length} active + ${superseded.length} superseded memories`,
    `${duplicateClusters.length} duplicate cluster(s)`,
    `${conflicts.length} overlap/conflict candidate(s)`,
    `${staleSuperseded.length} stale superseded (>=${pruneDays}d)`,
    `${brokenWikilinks.length} broken wikilink(s)`,
  ].join(" · ");

  return {
    dryRun: !apply,
    project: canonicalProject,
    scannedActive: active.length,
    scannedSuperseded: superseded.length,
    duplicateClusters,
    conflicts,
    staleSuperseded,
    danglingSupersedeRefs,
    brokenWikilinks,
    actionsApplied: {
      duplicatesConsolidated,
      supersededArchivedAndPruned,
      archivePath,
    },
    summary,
  };
}
