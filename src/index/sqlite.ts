/**
 * Cross-runtime SQLite adapter (works on both Bun `bun:sqlite` and Node 22+ `node:sqlite`).
 * Zero native build dependencies.
 */

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqlStatement {
  run(...params: SqlValue[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  get<T = Record<string, unknown>>(...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(...params: SqlValue[]): T[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly driver: "bun:sqlite" | "node:sqlite";
}

type RawStatement = {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

type RawDatabase = {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
};

function wrapDatabase(raw: RawDatabase, driver: "bun:sqlite" | "node:sqlite"): SqlDatabase {
  return {
    driver,
    exec(sql: string): void {
      raw.exec(sql);
    },
    prepare(sql: string): SqlStatement {
      const stmt = raw.prepare(sql);
      return {
        run(...params: SqlValue[]) {
          const res = stmt.run(...params) as
            | { changes?: number | bigint; lastInsertRowid?: number | bigint }
            | undefined;
          return res ?? {};
        },
        get<T = Record<string, unknown>>(...params: SqlValue[]): T | undefined {
          const row = stmt.get(...params);
          return row === null || row === undefined ? undefined : (row as T);
        },
        all<T = Record<string, unknown>>(...params: SqlValue[]): T[] {
          return stmt.all(...params) as T[];
        },
      };
    },
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* ignore rollback failure */
        }
        throw err;
      }
    },
    close(): void {
      raw.close();
    },
  };
}

let cachedLoader: Promise<{
  driver: "bun:sqlite" | "node:sqlite";
  open: (path: string) => RawDatabase;
}> | null = null;

async function loadSqliteDriver() {
  if (cachedLoader) return cachedLoader;
  cachedLoader = (async () => {
    const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    if (isBun) {
      const modName = "bun:sqlite";
      const mod = (await import(/* @vite-ignore */ modName)) as {
        Database: new (path: string, opts?: { create?: boolean }) => RawDatabase;
      };
      return {
        driver: "bun:sqlite" as const,
        open: (path: string) => new mod.Database(path, { create: true }),
      };
    }

    const modName = "node:sqlite";
    try {
      const mod = (await import(/* @vite-ignore */ modName)) as {
        DatabaseSync: new (path: string) => RawDatabase;
      };
      return {
        driver: "node:sqlite" as const,
        open: (path: string) => new mod.DatabaseSync(path),
      };
    } catch (err) {
      throw new Error(
        `SQLite hybrid index requires Bun or Node.js 22.5+ (node:sqlite): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();
  return cachedLoader;
}

export async function openSqlite(dbPath: string): Promise<SqlDatabase> {
  const { driver, open } = await loadSqliteDriver();
  const db = wrapDatabase(open(dbPath), driver);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}
