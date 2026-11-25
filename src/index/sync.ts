/**
 * Incremental vault indexer: syncs Markdown notes -> disposable SQLite (files, chunks, FTS5, embeddings, wikilinks).
 * Fast path skips unchanged files by mtimeMs; content-identical touches skip re-chunking & re-embedding via sha256.
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { readText } from "../runtime.ts";
import { listNotePaths } from "../vault.ts";
import {
  chunkMarkdown,
  extractNoteMetadata,
  extractWikilinks,
} from "./chunker.ts";
import { openIndexDb } from "./db.ts";
import {
  encodeEmbedding,
  resolveDefaultEmbedder,
  type Embedder,
} from "./embed.ts";
import type { SqlDatabase } from "./sqlite.ts";

/** Coalesce concurrent in-process sync calls targeting the same SQLite DB path. */
const inflightSyncs = new Map<string, Promise<SyncStats>>();

export type SyncOptions = {
  dbPath?: string;
  forceRebuild?: boolean;
  /** Pass null to skip embeddings (FTS5 + graph only); omit for default local embedder. */
  embedder?: Embedder | null;
};

export type SyncStats = {
  vaultPath: string;
  dbPath: string;
  driver: "bun:sqlite" | "node:sqlite";
  rebuilt: boolean;
  scanned: number;
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  chunksIndexed: number;
  embeddedChunks: number;
  linksResolved: number;
  embedModel: string | null;
  embedWarning?: string;
  durationMs: number;
};

type ExistingFileRow = {
  path: string;
  mtime_ms: number;
  sha256: string;
};

type PendingFile = {
  path: string;
  mtimeMs: number;
  sha256: string;
  title: string;
  type: string | null;
  scope: string | null;
  project: string | null;
  tags: string[];
  updated: string | null;
  bodyChars: number;
  chunks: { chunkIndex: number; heading: string; content: string }[];
  rawLinks: string[];
  isNew: boolean;
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Resolve an Obsidian [[wikilink]] target against all known vault paths. */
export function resolveWikilink(
  srcPath: string,
  rawTarget: string,
  allPaths: string[],
  byLowerPath: Map<string, string>,
  byLowerStem: Map<string, string[]>,
): string | null {
  const cleaned = rawTarget.replace(/\\/g, "/").trim();
  if (!cleaned) return null;

  // 1. Relative link (e.g. ../../stack/catalog/bun or ./decisions)
  if (cleaned.startsWith("./") || cleaned.startsWith("../")) {
    const joined = posix.normalize(posix.join(posix.dirname(srcPath), cleaned));
    const exact =
      byLowerPath.get(joined.toLowerCase()) ??
      byLowerPath.get(`${joined.toLowerCase()}.md`);
    if (exact) return exact;
  }

  // 2. Vault-root exact or .md path
  const lower = cleaned.replace(/^\/+/, "").toLowerCase();
  const rootHit = byLowerPath.get(lower) ?? byLowerPath.get(`${lower}.md`);
  if (rootHit) return rootHit;

  // 3. Path suffix match (e.g. [[catalog/bun]] -> stack/catalog/bun.md)
  const suffixWithMd = lower.endsWith(".md") ? `/${lower}` : `/${lower}.md`;
  for (const candidate of allPaths) {
    if (candidate.toLowerCase().endsWith(suffixWithMd)) {
      return candidate;
    }
  }

  // 4. Stem / basename match (Obsidian shortest-path convention)
  const stem = posix.basename(lower).replace(/\.md$/i, "");
  const stemHits = byLowerStem.get(stem);
  if (!stemHits?.length) return null;
  if (stemHits.length === 1) return stemHits[0]!;

  // Disambiguate by preferring same folder as srcPath
  const srcDir = posix.dirname(srcPath);
  const sameDir = stemHits.find((p) => posix.dirname(p) === srcDir);
  return sameDir ?? stemHits[0]!;
}

function buildPathLookups(allPaths: string[]) {
  const byLowerPath = new Map<string, string>();
  const byLowerStem = new Map<string, string[]>();
  for (const p of allPaths) {
    byLowerPath.set(p.toLowerCase(), p);
    const stem = posix.basename(p).replace(/\.(md|txt)$/i, "").toLowerCase();
    const list = byLowerStem.get(stem) ?? [];
    list.push(p);
    byLowerStem.set(stem, list);
  }
  return { byLowerPath, byLowerStem };
}

function deleteFileRows(db: SqlDatabase, filePath: string): void {
  db.prepare(
    "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)",
  ).run(filePath);
  db.prepare("DELETE FROM links WHERE src_path = ?").run(filePath);
  db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
  db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
}

export async function syncVaultIndexOnDb(
  db: SqlDatabase,
  vaultPath: string,
  dbPath: string,
  rebuilt: boolean,
  opts?: SyncOptions,
): Promise<SyncStats> {
  const started = performance.now();
  const embedder =
    opts?.embedder !== undefined ? opts.embedder : resolveDefaultEmbedder();

  const allPaths = await listNotePaths(vaultPath);
  const currentSet = new Set(allPaths);

  const existingRows = db
    .prepare("SELECT path, mtime_ms, sha256 FROM files")
    .all<ExistingFileRow>();
  const existingMap = new Map(existingRows.map((r) => [r.path, r]));

  const deletedPaths: string[] = [];
  for (const row of existingRows) {
    if (!currentSet.has(row.path)) {
      deletedPaths.push(row.path);
    }
  }

  const pending: PendingFile[] = [];
  const touchedMtimes: { path: string; mtimeMs: number }[] = [];
  let unchanged = 0;

  for (const relPath of allPaths) {
    const abs = resolve(vaultPath, relPath);
    let mtimeMs: number;
    try {
      const st = await stat(abs);
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }

    const prev = existingMap.get(relPath);
    if (prev && Math.abs(prev.mtime_ms - mtimeMs) < 0.5) {
      unchanged++;
      continue;
    }

    const rawBody = await readText(abs);
    const hash = sha256(rawBody);
    if (prev && prev.sha256 === hash) {
      touchedMtimes.push({ path: relPath, mtimeMs });
      unchanged++;
      continue;
    }

    const { meta, content } = extractNoteMetadata(relPath, rawBody, mtimeMs);
    const chunks = chunkMarkdown(meta.title, content);
    const rawLinks = extractWikilinks(content);

    pending.push({
      path: relPath,
      mtimeMs,
      sha256: hash,
      title: meta.title,
      type: meta.type,
      scope: meta.scope,
      project: meta.project,
      tags: meta.tags,
      updated: meta.updated,
      bodyChars: rawBody.length,
      chunks,
      rawLinks,
      isNew: !prev,
    });
  }

  // Embed new/changed chunks in batches
  let embedWarning: string | undefined;
  let embeddedChunks = 0;
  let activeEmbedModel: string | null = embedder?.model ?? null;
  const chunkEmbeddings = new Map<string, Float32Array[]>();

  if (embedder && pending.length > 0) {
    const texts: string[] = [];
    const offsets: { path: string; count: number }[] = [];
    for (const file of pending) {
      offsets.push({ path: file.path, count: file.chunks.length });
      for (const ch of file.chunks) {
        const tagLine = file.tags.length ? ` [${file.tags.join(", ")}]` : "";
        texts.push(`${file.title} — ${ch.heading}${tagLine}\n${ch.content}`);
      }
    }
    try {
      const vectors = await embedder.embed(texts, "document");
      let cursor = 0;
      for (const item of offsets) {
        chunkEmbeddings.set(item.path, vectors.slice(cursor, cursor + item.count));
        cursor += item.count;
      }
      embeddedChunks += vectors.length;
    } catch (err) {
      embedWarning = err instanceof Error ? err.message : String(err);
      activeEmbedModel = null;
      console.error(
        `[ai-mcp-brain] embedding unavailable (falling back to FTS5): ${embedWarning}`,
      );
    }
  }

  // Apply all file deletions, touches, and upserts in a single transaction
  let added = 0;
  let updated = 0;

  if (deletedPaths.length || touchedMtimes.length || pending.length) {
    db.transaction(() => {
      for (const delPath of deletedPaths) {
        deleteFileRows(db, delPath);
      }

      const touchStmt = db.prepare("UPDATE files SET mtime_ms = ? WHERE path = ?");
      for (const t of touchedMtimes) {
        touchStmt.run(t.mtimeMs, t.path);
      }

      const insertFile = db.prepare(`
        INSERT INTO files (path, mtime_ms, sha256, title, type, scope, project, tags, updated, body_chars)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertChunk = db.prepare(`
        INSERT INTO chunks (file_path, chunk_index, heading, content, embedding, embed_model)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertFts = db.prepare(`
        INSERT INTO chunks_fts (rowid, file_path, title, heading, content, tags)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertLink = db.prepare(`
        INSERT OR IGNORE INTO links (src_path, raw_target, resolved_path)
        VALUES (?, ?, NULL)
      `);

      for (const file of pending) {
        if (file.isNew) added++;
        else updated++;

        deleteFileRows(db, file.path);
        insertFile.run(
          file.path,
          file.mtimeMs,
          file.sha256,
          file.title,
          file.type,
          file.scope,
          file.project,
          JSON.stringify(file.tags),
          file.updated,
          file.bodyChars,
        );

        const vecs = chunkEmbeddings.get(file.path);
        const tagsStr = file.tags.join(" ");
        for (let i = 0; i < file.chunks.length; i++) {
          const ch = file.chunks[i]!;
          const vec = vecs?.[i];
          const blob = vec ? encodeEmbedding(vec) : null;
          const res = insertChunk.run(
            file.path,
            ch.chunkIndex,
            ch.heading,
            ch.content,
            blob,
            vec ? activeEmbedModel : null,
          );
          const rowId = Number(res.lastInsertRowid);
          insertFts.run(
            rowId,
            file.path,
            file.title,
            ch.heading,
            ch.content,
            tagsStr,
          );
        }

        for (const rawTarget of file.rawLinks) {
          insertLink.run(file.path, rawTarget);
        }
      }
    });
  }

  // Backfill embeddings for unchanged chunks if embeddings were enabled after an FTS-only sync
  if (embedder && !embedWarning) {
    const missing = db
      .prepare(
        `SELECT c.id, c.heading, c.content, f.title, f.tags
         FROM chunks c
         JOIN files f ON f.path = c.file_path
         WHERE c.embedding IS NULL OR c.embed_model != ?`,
      )
      .all<{
        id: number;
        heading: string;
        content: string;
        title: string;
        tags: string;
      }>(embedder.model);

    if (missing.length > 0) {
      try {
        const texts = missing.map((row) => {
          let tagsArr: string[] = [];
          try {
            tagsArr = JSON.parse(row.tags) as string[];
          } catch {
            /* ignore */
          }
          const tagLine = tagsArr.length ? ` [${tagsArr.join(", ")}]` : "";
          return `${row.title} — ${row.heading}${tagLine}\n${row.content}`;
        });
        const vectors = await embedder.embed(texts, "document");
        db.transaction(() => {
          const upd = db.prepare(
            "UPDATE chunks SET embedding = ?, embed_model = ? WHERE id = ?",
          );
          for (let i = 0; i < missing.length; i++) {
            upd.run(
              encodeEmbedding(vectors[i]!),
              embedder.model,
              missing[i]!.id,
            );
          }
        });
        embeddedChunks += vectors.length;
      } catch (err) {
        embedWarning = err instanceof Error ? err.message : String(err);
        activeEmbedModel = null;
        console.error(
          `[ai-mcp-brain] embedding backfill unavailable: ${embedWarning}`,
        );
      }
    }
  }

  // Re-resolve wikilinks whenever the file graph changed (or on rebuild)
  let linksResolved = 0;
  if (rebuilt || deletedPaths.length > 0 || pending.length > 0) {
    const { byLowerPath, byLowerStem } = buildPathLookups(allPaths);
    const linkRows = db
      .prepare("SELECT src_path, raw_target FROM links")
      .all<{ src_path: string; raw_target: string }>();
    db.transaction(() => {
      const upd = db.prepare(
        "UPDATE links SET resolved_path = ? WHERE src_path = ? AND raw_target = ?",
      );
      for (const row of linkRows) {
        const resolved = resolveWikilink(
          row.src_path,
          row.raw_target,
          allPaths,
          byLowerPath,
          byLowerStem,
        );
        if (resolved) linksResolved++;
        upd.run(resolved, row.src_path, row.raw_target);
      }
    });
  } else {
    const countRow = db
      .prepare("SELECT COUNT(*) as n FROM links WHERE resolved_path IS NOT NULL")
      .get<{ n: number }>();
    linksResolved = Number(countRow?.n ?? 0);
  }

  const chunkCountRow = db
    .prepare("SELECT COUNT(*) as n FROM chunks")
    .get<{ n: number }>();

  return {
    vaultPath,
    dbPath,
    driver: db.driver,
    rebuilt,
    scanned: allPaths.length,
    added,
    updated,
    deleted: deletedPaths.length,
    unchanged,
    chunksIndexed: Number(chunkCountRow?.n ?? 0),
    embeddedChunks,
    linksResolved,
    embedModel: activeEmbedModel,
    embedWarning,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

export async function syncVaultIndex(
  vaultPath: string,
  opts?: SyncOptions,
): Promise<SyncStats> {
  const { db, dbPath, rebuilt } = await openIndexDb(vaultPath, {
    dbPath: opts?.dbPath,
    forceRebuild: opts?.forceRebuild,
  });
  const key = dbPath === ":memory:" ? `:memory:${Math.random()}` : dbPath;
  const existing = !opts?.forceRebuild ? inflightSyncs.get(key) : undefined;
  if (existing) {
    db.close();
    return existing;
  }

  const run = (async () => {
    try {
      const stats = await syncVaultIndexOnDb(db, vaultPath, dbPath, rebuilt, opts);
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        /* ignore checkpoint failure on read-only/in-memory db */
      }
      return stats;
    } finally {
      db.close();
      inflightSyncs.delete(key);
    }
  })();

  if (dbPath !== ":memory:") {
    inflightSyncs.set(key, run);
  }
  return run;
}
