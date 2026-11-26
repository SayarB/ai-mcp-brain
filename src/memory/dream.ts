/**
 * `brain dream` — Sleep-time memory consolidation & vault hygiene engine.
 *
 * Safe by default (`apply: false` = dry-run preview).
 * Detects:
 *  1. Near-duplicate active memory clusters (merges tags into canonical keeper, marks duplicates superseded).
 *  2. Potential contradiction / overlap candidates for human review.
 *  3. Old superseded blocks (> pruneDays) — losslessly archived into scope-isolated archive files
 *     (`projects/<slug>/archive/memories-YYYY-MM.md` or `_meta/archive/global-memories-YYYY-MM.md`)
 *     with `O_EXCL` create, cross-process locking, `fsync`, and read-back verification before pruning.
 *  4. Dangling `superseded_by` references where the replacement ID no longer exists.
 *  5. Broken `[[wikilinks]]` from the local SQLite index.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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
import { readText } from "../runtime.ts";
import { resolveProjectSlug } from "../vault.ts";
import {
  deleteMemory,
  listMemories,
  markMemorySupersededBy,
  renderMemoryBlock,
  updateMemory,
  withFileLock,
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
    archivePaths: string[];
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

function scorePair(
  a: AtomicMemory,
  b: AtomicMemory,
  vectors: Map<string, Float32Array>,
): { combined: number; lexical: number; sameTitleDiffBody: boolean } {
  const na = norm(`${a.title} ${a.content}`);
  const nb = norm(`${b.title} ${b.content}`);
  if (na && na === nb) {
    return { combined: 1.0, lexical: 1.0, sameTitleDiffBody: false };
  }

  const lexical = jaccard(`${a.title} ${a.content}`, `${b.title} ${b.content}`);
  const titleExact = norm(a.title) !== "" && norm(a.title) === norm(b.title);
  const sameTitleDiffBody = titleExact && norm(a.content) !== norm(b.content);
  const va = vectors.get(a.id);
  const vb = vectors.get(b.id);
  const cos = va && vb && va.length === vb.length ? Math.max(0, dotProduct(va, vb)) : null;

  const combined =
    cos !== null
      ? Math.round(Math.max(lexical, cos * 0.85 + lexical * 0.15) * 1000) / 1000
      : Math.round(Math.max(lexical, titleExact ? Math.max(lexical, 0.76) : lexical) * 1000) / 1000;

  return { combined, lexical, sameTitleDiffBody };
}

function isAutoDuplicate(score: {
  combined: number;
  lexical: number;
  sameTitleDiffBody: boolean;
}): boolean {
  // Require strong lexical similarity too (>= 0.6) so contradictory memories with high embedding
  // cosine (e.g. "API port 3000" vs "API port 4000") are routed to `conflicts` instead of auto-superseded.
  return !score.sameTitleDiffBody && score.combined >= 0.88 && score.lexical >= 0.6;
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
        "SELECT src_path, raw_target FROM links WHERE resolved_path IS NULL ORDER BY src_path, raw_target",
      )
      .all<{ src_path: string; raw_target: string }>();

    const out: DanglingLinkItem[] = [];
    for (const r of rows) {
      if (out.length >= 50) break;
      const inf = inferNoteScopeAndProject(r.src_path);
      if (opts.project && inf.project !== opts.project) continue;
      if (opts.policy && !canReadTarget(opts.policy, inf.scope, inf.project)) continue;
      out.push({ srcPath: r.src_path, rawTarget: r.raw_target });
    }
    return out;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

async function assertSafeArchiveTarget(vaultPath: string, absPath: string): Promise<void> {
  const realVault = await realpath(vaultPath);
  const rel = relative(resolve(vaultPath), resolve(absPath)).replace(/\\/g, "/");
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
    throw new Error(`Archive path escapes vault: ${absPath}`);
  }
  // Check deepest existing ancestor BEFORE mkdir so a symlinked directory can never create folders outside vault
  const dir = dirname(absPath);
  let probe = dir;
  while (true) {
    try {
      const realProbe = await realpath(probe);
      const relProbe = relative(realVault, realProbe).replace(/\\/g, "/");
      if (relProbe === ".." || relProbe.startsWith("../") || relProbe.startsWith("/")) {
        throw new Error(`Archive directory escapes vault via symlink: ${probe}`);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  await mkdir(dir, { recursive: true });
  const realDir = await realpath(dir);
  const relDir = relative(realVault, realDir).replace(/\\/g, "/");
  if (relDir === ".." || relDir.startsWith("../") || relDir.startsWith("/")) {
    throw new Error(`Archive directory escapes vault via symlink: ${dir}`);
  }
  try {
    const st = await lstat(absPath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write archive through symlink: ${absPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/**
 * Scope-isolated, locked, crash-safe, fsynced archive writer.
 * Project memories archive into `projects/<slug>/archive/memories-YYYY-MM.md` (preserving project ACLs);
 * Global memories archive into `_meta/archive/global-memories-YYYY-MM.md`.
 * Verifies every archived memory ID is durably present in the file before returning.
 */
async function appendToScopedArchive(
  vaultPath: string,
  scope: "global" | "project",
  project: string | null,
  memories: AtomicMemory[],
): Promise<string> {
  const ym = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  const relPath =
    scope === "project" && project
      ? `projects/${project}/archive/memories-${ym}.md`
      : `_meta/archive/global-memories-${ym}.md`;
  const absPath = join(vaultPath, relPath);

  await assertSafeArchiveTarget(vaultPath, absPath);

  await withFileLock(absPath, async () => {
    const blocks = memories
      .map((m) => `<!-- archived_from: ${m.path} -->\n${renderMemoryBlock(m)}`)
      .join("\n\n");

    const frontmatter = [
      "---",
      "type: archive",
      `scope: ${scope}`,
      ...(scope === "project" && project ? [`project: ${project}`] : []),
      `updated: ${today}`,
      "---",
      "",
      `# Archived Superseded Memories (${ym})`,
      "",
      blocks,
      "",
    ].join("\n");

    // Atomic create with O_EXCL ("wx"); fall back to O_APPEND | O_NOFOLLOW if the file already exists
    let fh;
    const appendFlags =
      fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      (fsConstants.O_NOFOLLOW ?? 0);
    try {
      fh = await open(absPath, "wx", 0o644);
      await fh.writeFile(frontmatter, "utf8");
      await fh.sync();
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      fh = await open(absPath, appendFlags, 0o644);
      await fh.writeFile(`\n\n${blocks}\n`, "utf8");
      await fh.sync();
    } finally {
      await fh?.close();
    }

    // Strict read-back verification (checking exact block markers) before caller deletes source blocks
    const verified = await readText(absPath);
    for (const m of memories) {
      if (!verified.includes(`id=${m.id}`) || !verified.includes(`<!-- /mem:${m.id} -->`)) {
        throw new Error(
          `Archive verification failed: memory ${m.id} not found in ${relPath}; aborting prune.`,
        );
      }
    }
  });

  return relPath;
}

async function runDreamInner(
  vaultPath: string,
  opts: DreamOptions,
): Promise<DreamReport> {
  const apply = Boolean(opts.apply);
  const pruneDays = opts.pruneDays === undefined ? 90 : Math.max(0, Math.trunc(opts.pruneDays));
  const policy = opts.policy ?? null;
  const canonicalProject = opts.project?.trim()
    ? await resolveProjectSlug(vaultPath, opts.project.trim())
    : null;

  // Load full ID set across the vault so cross-scope superseded_by pointers aren't falsely flagged dangling
  const vaultAll = await listMemories(vaultPath, { status: "all" });
  const allIdSet = new Set(vaultAll.map((m) => m.id));

  const scopedRaw = canonicalProject
    ? vaultAll.filter((m) => m.scope === "project" && m.project === canonicalProject)
    : vaultAll;

  const visible = policy
    ? scopedRaw.filter((m) => canReadTarget(policy, m.scope, m.project))
    : scopedRaw;

  const active = visible.filter((m) => m.status === "active");
  const superseded = visible.filter((m) => m.status === "superseded");

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

        const score = scorePair(keeper, other, vectors);
        if (isAutoDuplicate(score)) {
          dups.push({ mem: other, sim: score.combined });
          clusteredIds.add(other.id);
        } else if (score.sameTitleDiffBody || score.combined >= 0.68) {
          conflicts.push({
            a: { id: keeper.id, title: keeper.title, path: keeper.path },
            b: { id: other.id, title: other.title, path: other.path },
            similarity: score.combined,
            reason: score.sameTitleDiffBody
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

  // 2. Identify old superseded memories eligible for lossless scope-isolated archive + prune
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

  // 3. Detect dangling supersededBy references (checked against full vault ID set)
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

  // 4. Query broken wikilinks from SQLite index (filtered before cap)
  const brokenWikilinks = await queryBrokenWikilinks(vaultPath, {
    dbPath: opts.dbPath,
    project: canonicalProject,
    policy,
  });

  // 5. Apply mutations ONLY when `apply: true` (already serialized under vault dream lock)
  let duplicatesConsolidated = 0;
  let supersededArchivedAndPruned = 0;
  const archivePaths: string[] = [];

  if (apply) {
    // Re-read current active memories inside the lock before mutating so concurrent edits aren't clobbered
    const freshActive = await listMemories(vaultPath, { status: "active" });
    const freshById = new Map(freshActive.map((m) => [m.id, m]));

    for (const cluster of duplicateClusters) {
      const keeperMem = freshById.get(cluster.keeper.id);
      if (!keeperMem || keeperMem.status !== "active") continue;
      if (policy && !canWriteTarget(policy, keeperMem.scope, keeperMem.project)) continue;

      const confirmedDups: AtomicMemory[] = [];
      for (const dup of cluster.duplicates) {
        const dupMem = freshById.get(dup.id);
        if (!dupMem || dupMem.status !== "active") continue;
        if (policy && !canWriteTarget(policy, dupMem.scope, dupMem.project)) continue;
        // Re-verify similarity on fresh content before superseding
        const freshScore = scorePair(keeperMem, dupMem, vectors);
        if (!isAutoDuplicate(freshScore)) continue;
        confirmedDups.push(dupMem);
      }

      if (!confirmedDups.length) continue;

      const mergedFreshTags = [
        ...new Set([
          ...keeperMem.tags,
          ...confirmedDups.flatMap((d) => d.tags),
        ]),
      ];
      const tagsChanged = mergedFreshTags.some((t) => !keeperMem.tags.includes(t));
      if (tagsChanged) {
        await updateMemory(vaultPath, {
          id: keeperMem.id,
          tags: mergedFreshTags,
        });
      }

      for (const dupMem of confirmedDups) {
        await markMemorySupersededBy(vaultPath, dupMem.id, keeperMem.id);
        duplicatesConsolidated++;
      }
    }

    // Partition stale superseded memories by their own (scope, project) so project secrets NEVER enter global archive!
    const prunable = staleSupersededMems.filter(
      (m) => !policy || canWriteTarget(policy, m.scope, m.project),
    );
    const byScopeKey = new Map<string, { scope: "global" | "project"; project: string | null; items: AtomicMemory[] }>();
    for (const m of prunable) {
      const key = `${m.scope}|${m.project ?? ""}`;
      const bucket = byScopeKey.get(key) ?? {
        scope: m.scope,
        project: m.project,
        items: [],
      };
      bucket.items.push(m);
      byScopeKey.set(key, bucket);
    }

    for (const bucket of byScopeKey.values()) {
      const archivedRel = await appendToScopedArchive(
        vaultPath,
        bucket.scope,
        bucket.project,
        bucket.items,
      );
      archivePaths.push(archivedRel);
      // Only delete after appendToScopedArchive fsynced & verified every ID on disk
      for (const m of bucket.items) {
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
      archivePath: archivePaths[0] ?? null,
      archivePaths,
    },
    summary,
  };
}

export async function runDreamConsolidation(
  vaultPath: string,
  opts: DreamOptions = {},
): Promise<DreamReport> {
  if (!opts.apply) {
    return runDreamInner(vaultPath, opts);
  }
  // Serialize overlapping dream --apply runs across processes and concurrent UI/CLI triggers
  const dreamLockTarget = join(vaultPath, "_meta", ".brain-dream");
  await mkdir(dirname(dreamLockTarget), { recursive: true });
  return withFileLock(dreamLockTarget, () => runDreamInner(vaultPath, opts));
}
