/**
 * Disposable SQLite index schema & cache path resolution.
 * Source of truth is always the Markdown vault; deleting this DB triggers a clean rebuild.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openSqlite, type SqlDatabase } from "./sqlite.ts";

export const INDEX_SCHEMA_VERSION = "1";

export function defaultIndexDbPath(vaultPath: string): string {
  const envOverride = process.env.BRAIN_INDEX_PATH?.trim();
  if (envOverride) return resolve(envOverride);

  const canonical = resolve(vaultPath);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const xdgCache = process.env.XDG_CACHE_HOME?.trim();
  const baseCache = xdgCache || join(homedir(), ".cache");
  return join(baseCache, "ai-mcp-brain", `index-${hash}.sqlite`);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  sha256 TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT,
  scope TEXT,
  project TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  updated TEXT,
  body_chars INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  heading TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  embed_model TEXT
);

CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_files_project ON files(project);
CREATE INDEX IF NOT EXISTS idx_files_type ON files(type);
CREATE INDEX IF NOT EXISTS idx_files_scope ON files(scope);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  file_path,
  title,
  heading,
  content,
  tags,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS links (
  src_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  raw_target TEXT NOT NULL,
  resolved_path TEXT,
  PRIMARY KEY (src_path, raw_target)
);

CREATE INDEX IF NOT EXISTS idx_links_resolved ON links(resolved_path);
`;

const DROP_ALL_SQL = `
DROP TABLE IF EXISTS chunks_fts;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS meta;
`;

export function ensureIndexSchema(db: SqlDatabase, forceRebuild = false): boolean {
  if (forceRebuild) {
    db.exec(DROP_ALL_SQL);
  }

  let needsRebuild = forceRebuild;
  if (!needsRebuild) {
    const hasMeta = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
      .get<{ name: string }>();
    if (hasMeta) {
      const row = db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get<{ value: string }>();
      if (row?.value !== INDEX_SCHEMA_VERSION) {
        db.exec(DROP_ALL_SQL);
        needsRebuild = true;
      }
    }
  }

  db.exec(SCHEMA_SQL);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    INDEX_SCHEMA_VERSION,
  );
  return needsRebuild;
}

export async function openIndexDb(
  vaultPath: string,
  opts?: { dbPath?: string; forceRebuild?: boolean },
): Promise<{ db: SqlDatabase; dbPath: string; rebuilt: boolean }> {
  const dbPath = opts?.dbPath ?? defaultIndexDbPath(vaultPath);
  if (dbPath !== ":memory:") {
    await mkdir(dirname(dbPath), { recursive: true });
  }
  const db = await openSqlite(dbPath);
  const rebuilt = ensureIndexSchema(db, opts?.forceRebuild ?? false);
  return { db, dbPath, rebuilt };
}
