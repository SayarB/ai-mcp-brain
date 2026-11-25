export {
  chunkMarkdown,
  extractNoteMetadata,
  extractWikilinks,
  inferPathMetadata,
  parseFrontmatter,
  type NoteChunk,
  type NoteMetadata,
} from "./chunker.ts";
export {
  defaultIndexDbPath,
  ensureIndexSchema,
  INDEX_SCHEMA_VERSION,
  openIndexDb,
} from "./db.ts";
export {
  createLocalEmbedder,
  decodeEmbedding,
  DEFAULT_EMBED_MODEL,
  dotProduct,
  encodeEmbedding,
  resolveDefaultEmbedder,
  type Embedder,
} from "./embed.ts";
export {
  searchHybrid,
  tokenizeForFts,
  type HybridSearchHit,
  type HybridSearchOptions,
  type HybridSearchResult,
  type SearchMode,
} from "./search.ts";
export { openSqlite, type SqlDatabase, type SqlStatement } from "./sqlite.ts";
export {
  resolveWikilink,
  syncVaultIndex,
  syncVaultIndexOnDb,
  type SyncOptions,
  type SyncStats,
} from "./sync.ts";
