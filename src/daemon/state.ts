/**
 * Persistent local SQLite state for the daemon:
 * - `apps`: per-harness ACL policies & last-seen metadata
 * - `access_log`: secret-redacted audit trail of every MCP tool invocation
 *
 * Stored separately from the disposable hybrid search index (`index-*.sqlite`)
 * so `brain reindex --force` never wipes ACL overrides or audit history.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppConfigEntry, DaemonConfig } from "../config.ts";
import { openSqlite, type SqlDatabase, type SqlValue } from "../index/sqlite.ts";
import {
  defaultAppPolicy,
  mergeAppPolicy,
  redactLogSummary,
  validateAppName,
  type AccessMode,
  type AppPolicy,
  type AppPolicyPatch,
  type AppRecord,
  type PolicySource,
  type ScopeFilter,
  type ToolOperation,
} from "./acl.ts";

export const DAEMON_STATE_SCHEMA_VERSION = "1";
const DEFAULT_MAX_LOG_ROWS = 5000;

export type AccessStatus = "ok" | "denied" | "error";

export type AccessLogInput = {
  app: string;
  tool: string;
  operation: ToolOperation;
  status: AccessStatus;
  summary: string;
  resultCount?: number | null;
  durationMs: number;
};

export type AccessLogEntry = {
  id: number;
  ts: string;
  app: string;
  tool: string;
  operation: ToolOperation;
  status: AccessStatus;
  summary: string;
  resultCount: number | null;
  durationMs: number;
};

export type AccessLogQuery = {
  app?: string;
  tool?: string;
  status?: AccessStatus;
  operation?: ToolOperation;
  limit?: number;
  beforeId?: number;
};

export type AppWithStats = AppRecord & {
  stats: {
    totalCalls: number;
    readCalls: number;
    writeCalls: number;
    deniedCalls: number;
    errorCalls: number;
  };
};

export function defaultDaemonStateDbPath(vaultPath: string): string {
  const envOverride = process.env.BRAIN_DAEMON_DB?.trim();
  if (envOverride) return resolve(envOverride);

  const canonical = resolve(vaultPath);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const xdgCache = process.env.XDG_CACHE_HOME?.trim();
  const baseCache = xdgCache || join(homedir(), ".cache");
  return join(baseCache, "ai-mcp-brain", `daemon-${hash}.sqlite`);
}

const STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps (
  app TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'read-write',
  read_scopes TEXT NOT NULL DEFAULT '["global","project"]',
  write_scopes TEXT NOT NULL DEFAULT '["global","project"]',
  allowed_projects TEXT NOT NULL DEFAULT '[]',
  denied_tools TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'auto',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  app TEXT NOT NULL,
  tool TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  result_count INTEGER,
  duration_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_log_app_id ON access_log(app, id DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_status_id ON access_log(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_tool_id ON access_log(tool, id DESC);
`;

type RawAppRow = {
  app: string;
  enabled: number;
  mode: string;
  read_scopes: string;
  write_scopes: string;
  allowed_projects: string;
  denied_tools: string;
  source: string;
  first_seen: string;
  last_seen: string;
  updated_at: string;
};

type RawLogRow = {
  id: number;
  ts: string;
  app: string;
  tool: string;
  operation: string;
  status: string;
  summary: string;
  result_count: number | null;
  duration_ms: number;
};

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rowToAppRecord(row: RawAppRow): AppRecord {
  const mode =
    row.mode === "read-only" || row.mode === "disabled" ? row.mode : ("read-write" as AccessMode);
  const source =
    row.source === "config" || row.source === "override" ? row.source : ("auto" as PolicySource);
  return {
    app: row.app,
    enabled: Boolean(row.enabled),
    mode,
    readScopes: parseJsonStringArray(row.read_scopes).filter(
      (s): s is ScopeFilter => s === "global" || s === "project",
    ),
    writeScopes: parseJsonStringArray(row.write_scopes).filter(
      (s): s is ScopeFilter => s === "global" || s === "project",
    ),
    allowedProjects: parseJsonStringArray(row.allowed_projects),
    deniedTools: parseJsonStringArray(row.denied_tools),
    source,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    updatedAt: row.updated_at,
  };
}

function rowToLogEntry(row: RawLogRow): AccessLogEntry {
  return {
    id: Number(row.id),
    ts: row.ts,
    app: row.app,
    tool: row.tool,
    operation: row.operation === "write" ? "write" : "read",
    status: row.status === "denied" || row.status === "error" ? row.status : "ok",
    summary: row.summary,
    resultCount: row.result_count === null || row.result_count === undefined ? null : Number(row.result_count),
    durationMs: Number(row.duration_ms),
  };
}

function configEntryToPolicy(
  app: string,
  entry: AppConfigEntry | undefined,
  defaultMode: AccessMode,
): AppPolicy {
  const base = defaultAppPolicy(app, defaultMode);
  if (!entry) return base;
  return mergeAppPolicy(base, {
    enabled: entry.enabled,
    mode: entry.mode,
    readScopes: entry.read_scopes,
    writeScopes: entry.write_scopes,
    allowedProjects: entry.allowed_projects,
    deniedTools: entry.denied_tools,
  });
}

export class DaemonStateStore {
  private readonly db: SqlDatabase;
  readonly dbPath: string;
  private readonly defaultMode: AccessMode;
  private readonly configPolicies = new Map<string, AppPolicy>();
  private readonly maxLogRows: number;
  private insertsSincePrune = 0;
  private closed = false;

  private constructor(
    db: SqlDatabase,
    dbPath: string,
    opts?: {
      defaultMode?: AccessMode;
      configApps?: Record<string, AppConfigEntry>;
      maxLogRows?: number;
    },
  ) {
    this.db = db;
    this.dbPath = dbPath;
    this.defaultMode = opts?.defaultMode ?? "read-write";
    this.maxLogRows = Math.max(100, opts?.maxLogRows ?? DEFAULT_MAX_LOG_ROWS);

    if (opts?.configApps) {
      this.seedFromConfig(opts.configApps);
    }
  }

  static async open(
    vaultPath: string,
    opts?: {
      dbPath?: string;
      daemonConfig?: DaemonConfig;
      configApps?: Record<string, AppConfigEntry>;
      maxLogRows?: number;
    },
  ): Promise<DaemonStateStore> {
    const dbPath = opts?.dbPath ?? defaultDaemonStateDbPath(vaultPath);
    if (dbPath !== ":memory:") {
      await mkdir(dirname(dbPath), { recursive: true });
    }
    const db = await openSqlite(dbPath);
    db.exec(STATE_SCHEMA_SQL);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      DAEMON_STATE_SCHEMA_VERSION,
    );
    return new DaemonStateStore(db, dbPath, {
      defaultMode: opts?.daemonConfig?.default_mode ?? "read-write",
      configApps: opts?.configApps,
      maxLogRows: opts?.maxLogRows,
    });
  }

  /** Seed configured apps from config.toml without overwriting manual UI overrides. */
  seedFromConfig(configApps: Record<string, AppConfigEntry>): void {
    const now = new Date().toISOString();
    for (const [rawName, entry] of Object.entries(configApps)) {
      let app: string;
      try {
        app = validateAppName(rawName);
      } catch {
        continue;
      }
      const policy = configEntryToPolicy(app, entry, this.defaultMode);
      this.configPolicies.set(app, policy);

      const existing = this.db
        .prepare("SELECT * FROM apps WHERE app = ?")
        .get<RawAppRow>(app);
      if (existing && existing.source === "override") {
        continue;
      }
      this.saveAppRow(policy, "config", existing?.first_seen ?? now, existing?.last_seen ?? now, now);
    }
  }

  private saveAppRow(
    policy: AppPolicy,
    source: PolicySource,
    firstSeen: string,
    lastSeen: string,
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO apps (
          app, enabled, mode, read_scopes, write_scopes, allowed_projects, denied_tools,
          source, first_seen, last_seen, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(app) DO UPDATE SET
          enabled = excluded.enabled,
          mode = excluded.mode,
          read_scopes = excluded.read_scopes,
          write_scopes = excluded.write_scopes,
          allowed_projects = excluded.allowed_projects,
          denied_tools = excluded.denied_tools,
          source = excluded.source,
          last_seen = excluded.last_seen,
          updated_at = excluded.updated_at`,
      )
      .run(
        policy.app,
        policy.enabled ? 1 : 0,
        policy.mode,
        JSON.stringify(policy.readScopes),
        JSON.stringify(policy.writeScopes),
        JSON.stringify(policy.allowedProjects),
        JSON.stringify(policy.deniedTools),
        source,
        firstSeen,
        lastSeen,
        updatedAt,
      );
  }

  /** Resolve effective policy for an app (reads live SQLite state so UI toggles apply immediately). */
  getEffectivePolicy(rawApp: string): AppPolicy {
    const app = validateAppName(rawApp);
    const row = this.db.prepare("SELECT * FROM apps WHERE app = ?").get<RawAppRow>(app);
    if (row) return rowToAppRecord(row);
    const cfg = this.configPolicies.get(app);
    if (cfg) return { ...cfg };
    return defaultAppPolicy(app, this.defaultMode);
  }

  /** Register an app on first sight and bump last_seen. */
  touchApp(rawApp: string): AppRecord {
    const app = validateAppName(rawApp);
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT * FROM apps WHERE app = ?").get<RawAppRow>(app);
    if (existing) {
      this.db.prepare("UPDATE apps SET last_seen = ? WHERE app = ?").run(now, app);
      return { ...rowToAppRecord(existing), lastSeen: now };
    }
    const cfg = this.configPolicies.get(app);
    const policy = cfg ?? defaultAppPolicy(app, this.defaultMode);
    const source: PolicySource = cfg ? "config" : "auto";
    this.saveAppRow(policy, source, now, now, now);
    return {
      ...policy,
      source,
      firstSeen: now,
      lastSeen: now,
      updatedAt: now,
    };
  }

  upsertAppOverride(rawApp: string, patch: AppPolicyPatch): AppRecord {
    const app = validateAppName(rawApp);
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT * FROM apps WHERE app = ?").get<RawAppRow>(app);
    const base = existing
      ? rowToAppRecord(existing)
      : (this.configPolicies.get(app) ?? defaultAppPolicy(app, this.defaultMode));
    const merged = mergeAppPolicy(base, patch);
    const firstSeen = existing?.first_seen ?? now;
    const lastSeen = existing?.last_seen ?? now;
    this.saveAppRow(merged, "override", firstSeen, lastSeen, now);
    return {
      ...merged,
      source: "override",
      firstSeen,
      lastSeen,
      updatedAt: now,
    };
  }

  resetAppOverride(rawApp: string): AppRecord {
    const app = validateAppName(rawApp);
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT * FROM apps WHERE app = ?").get<RawAppRow>(app);
    const cfg = this.configPolicies.get(app);
    const policy = cfg ?? defaultAppPolicy(app, this.defaultMode);
    const source: PolicySource = cfg ? "config" : "auto";
    const firstSeen = existing?.first_seen ?? now;
    const lastSeen = existing?.last_seen ?? now;
    this.saveAppRow(policy, source, firstSeen, lastSeen, now);
    return {
      ...policy,
      source,
      firstSeen,
      lastSeen,
      updatedAt: now,
    };
  }

  listApps(): AppWithStats[] {
    const rows = this.db
      .prepare("SELECT * FROM apps ORDER BY last_seen DESC, app ASC")
      .all<RawAppRow>();

    const statsRows = this.db
      .prepare(
        `SELECT
          app,
          COUNT(*) AS total_calls,
          SUM(CASE WHEN operation = 'read' THEN 1 ELSE 0 END) AS read_calls,
          SUM(CASE WHEN operation = 'write' THEN 1 ELSE 0 END) AS write_calls,
          SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) AS denied_calls,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_calls
        FROM access_log
        GROUP BY app`,
      )
      .all<{
        app: string;
        total_calls: number;
        read_calls: number;
        write_calls: number;
        denied_calls: number;
        error_calls: number;
      }>();

    const statsMap = new Map(statsRows.map((s) => [s.app, s]));
    return rows.map((row) => {
      const rec = rowToAppRecord(row);
      const s = statsMap.get(rec.app);
      return {
        ...rec,
        stats: {
          totalCalls: Number(s?.total_calls ?? 0),
          readCalls: Number(s?.read_calls ?? 0),
          writeCalls: Number(s?.write_calls ?? 0),
          deniedCalls: Number(s?.denied_calls ?? 0),
          errorCalls: Number(s?.error_calls ?? 0),
        },
      };
    });
  }

  recordAccess(input: AccessLogInput): AccessLogEntry {
    const app = validateAppName(input.app);
    this.touchApp(app);
    const ts = new Date().toISOString();
    const safeSummary = redactLogSummary(input.summary);
    const durationMs = Math.max(0, Math.round(input.durationMs));
    const resultCount =
      input.resultCount === undefined || input.resultCount === null
        ? null
        : Math.max(0, Math.trunc(input.resultCount));

    const res = this.db
      .prepare(
        `INSERT INTO access_log (ts, app, tool, operation, status, summary, result_count, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        app,
        input.tool,
        input.operation,
        input.status,
        safeSummary,
        resultCount,
        durationMs,
      );

    this.insertsSincePrune++;
    if (this.insertsSincePrune >= 100) {
      this.insertsSincePrune = 0;
      this.pruneLogs();
    }

    return {
      id: Number(res.lastInsertRowid ?? 0),
      ts,
      app,
      tool: input.tool,
      operation: input.operation,
      status: input.status,
      summary: safeSummary,
      resultCount,
      durationMs,
    };
  }

  private pruneLogs(): void {
    this.db
      .prepare(
        `DELETE FROM access_log WHERE id NOT IN (
          SELECT id FROM access_log ORDER BY id DESC LIMIT ?
        )`,
      )
      .run(this.maxLogRows);
  }

  queryLogs(query?: AccessLogQuery): AccessLogEntry[] {
    const where: string[] = [];
    const params: SqlValue[] = [];

    if (query?.app) {
      where.push("app = ?");
      params.push(query.app.trim().toLowerCase());
    }
    if (query?.tool) {
      where.push("tool = ?");
      params.push(query.tool.trim());
    }
    if (query?.status) {
      where.push("status = ?");
      params.push(query.status);
    }
    if (query?.operation) {
      where.push("operation = ?");
      params.push(query.operation);
    }
    if (query?.beforeId !== undefined && Number.isFinite(query.beforeId)) {
      where.push("id < ?");
      params.push(Math.trunc(query.beforeId));
    }

    const rawLimit = query?.limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.min(500, Math.max(1, Math.trunc(rawLimit)))
        : 100;
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT * FROM access_log ${clause} ORDER BY id DESC LIMIT ?`)
      .all<RawLogRow>(...params);
    return rows.map(rowToLogEntry);
  }

  clearLogs(): number {
    const res = this.db.prepare("DELETE FROM access_log").run();
    return Number(res.changes ?? 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
