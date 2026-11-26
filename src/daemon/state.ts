/**
 * Persistent local SQLite state for the daemon:
 * - `apps`: per-harness ACL policies & last-seen metadata
 * - `access_log`: secret-redacted audit trail of every MCP tool invocation
 *
 * Stored separately from the disposable hybrid search index (`index-*.sqlite`)
 * so `brain reindex --force` never wipes ACL overrides or audit history.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppConfigEntry, DaemonConfig } from "../config.ts";
import { openSqlite, type SqlDatabase, type SqlValue } from "../index/sqlite.ts";
import { assertNoSecrets } from "../memory/guard.ts";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryScope,
} from "../memory/store.ts";
import { slugify } from "../vault.ts";
import {
  defaultAppPolicy,
  mergeAppPolicy,
  redactLogSummary,
  validateAccessMode,
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

export type PendingStatus = "pending" | "approving" | "approved" | "dismissed";

export class PendingStateConflictError extends Error {
  readonly pendingId: string;
  readonly currentStatus: PendingStatus;

  constructor(pendingId: string, currentStatus: PendingStatus, action: string) {
    super(`Cannot ${action} pending memory ${pendingId}: current status is "${currentStatus}".`);
    this.name = "PendingStateConflictError";
    this.pendingId = pendingId;
    this.currentStatus = currentStatus;
  }
}

export type PendingMemoryInput = {
  title: string;
  content: string;
  scope?: MemoryScope;
  project?: string | null;
  category?: MemoryCategory;
  app?: string;
  tags?: string[];
  sourceSession?: string | null;
  reason?: string;
  confidence?: number;
};

export type PendingMemoryRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: PendingStatus;
  title: string;
  content: string;
  scope: MemoryScope;
  project: string | null;
  category: MemoryCategory;
  app: string;
  tags: string[];
  sourceSession: string | null;
  reason: string;
  confidence: number;
  promotedMemoryId: string | null;
};

export type PendingMemoryQuery = {
  status?: PendingStatus | "all";
  scope?: MemoryScope;
  project?: string;
  category?: MemoryCategory;
  app?: string;
  limit?: number;
  /** Optional ACL push-down filter applied in SQL before LIMIT/COUNT. */
  policy?: AppPolicy | null;
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

CREATE TABLE IF NOT EXISTS pending_memories (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  project TEXT,
  category TEXT NOT NULL DEFAULT 'facts',
  app TEXT NOT NULL DEFAULT 'hook',
  tags TEXT NOT NULL DEFAULT '[]',
  source_session TEXT,
  reason TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.7,
  promoted_memory_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_status_created ON pending_memories(status, created_at DESC);
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

type RawPendingRow = {
  id: string;
  created_at: string;
  updated_at: string;
  status: string;
  title: string;
  content: string;
  scope: string;
  project: string | null;
  category: string;
  app: string;
  tags: string;
  source_session: string | null;
  reason: string;
  confidence: number;
  promoted_memory_id: string | null;
};

function rowToPendingRecord(row: RawPendingRow): PendingMemoryRecord {
  const status: PendingStatus =
    row.status === "approving" || row.status === "approved" || row.status === "dismissed"
      ? row.status
      : "pending";
  const scope: MemoryScope = row.scope === "project" ? "project" : "global";
  const category: MemoryCategory = (MEMORY_CATEGORIES as readonly string[]).includes(row.category)
    ? (row.category as MemoryCategory)
    : "facts";
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status,
    title: row.title,
    content: row.content,
    scope,
    project: row.project || null,
    category,
    app: row.app,
    tags: parseJsonStringArray(row.tags),
    sourceSession: row.source_session || null,
    reason: row.reason || "",
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.7,
    promotedMemoryId: row.promoted_memory_id || null,
  };
}

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
    this.defaultMode = validateAccessMode(opts?.defaultMode ?? "read-write", "default_mode");
    this.maxLogRows = Math.max(100, opts?.maxLogRows ?? DEFAULT_MAX_LOG_ROWS);

    if (opts?.configApps !== undefined) {
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

  /** Seed configured apps from config.toml without overwriting manual UI overrides, and reconcile removed [apps.*] entries. */
  seedFromConfig(configApps: Record<string, AppConfigEntry>): void {
    const now = new Date().toISOString();
    this.configPolicies.clear();
    const activeConfigApps = new Set<string>();

    for (const [rawName, entry] of Object.entries(configApps)) {
      const app = validateAppName(rawName);
      const policy = configEntryToPolicy(app, entry, this.defaultMode);
      this.configPolicies.set(app, policy);
      activeConfigApps.add(app);

      const existing = this.db
        .prepare("SELECT * FROM apps WHERE app = ?")
        .get<RawAppRow>(app);
      if (existing && existing.source === "override") {
        continue;
      }
      this.saveAppRow(policy, "config", existing?.first_seen ?? now, existing?.last_seen ?? now, now);
    }

    // Reconcile stale source='config' rows whose [apps.<name>] entry was removed from config.toml
    const existingConfigRows = this.db
      .prepare("SELECT * FROM apps WHERE source = 'config'")
      .all<RawAppRow>();
    for (const row of existingConfigRows) {
      if (!activeConfigApps.has(row.app)) {
        const reverted = defaultAppPolicy(row.app, this.defaultMode);
        this.saveAppRow(reverted, "auto", row.first_seen, row.last_seen, now);
      }
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

  // --- Pending Approval Queue (Passive Capture) ---

  stagePendingMemory(input: PendingMemoryInput): PendingMemoryRecord {
    const title = input.title.replace(/\s+/g, " ").trim().slice(0, 120);
    const content = input.content.trim();
    if (!title || !content) {
      throw new Error("Pending memory requires non-empty title and content.");
    }
    // Defense-in-depth: never persist potential secrets into the pending queue
    assertNoSecrets(title, content);

    const scope: MemoryScope =
      input.scope ?? (input.project?.trim() ? "project" : "global");
    const project =
      scope === "project" && input.project?.trim() ? slugify(input.project.trim()) : null;
    if (scope === "project" && !project) {
      throw new Error("Project-scoped pending memory requires a project slug.");
    }
    const category: MemoryCategory =
      input.category && (MEMORY_CATEGORIES as readonly string[]).includes(input.category)
        ? input.category
        : "facts";
    const app = validateAppName(input.app?.trim() || "hook");
    const tags = Array.isArray(input.tags)
      ? [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
      : [];
    const confidence =
      typeof input.confidence === "number" && Number.isFinite(input.confidence)
        ? Math.min(1, Math.max(0, Math.round(input.confidence * 100) / 100))
        : 0.7;

    const id = `p_${randomBytes(6).toString("hex")}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pending_memories (
          id, created_at, updated_at, status, title, content, scope, project,
          category, app, tags, source_session, reason, confidence, promoted_memory_id
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        now,
        now,
        title,
        content,
        scope,
        project,
        category,
        app,
        JSON.stringify(tags),
        input.sourceSession?.trim() || null,
        (input.reason ?? "").trim().slice(0, 180),
        confidence,
      );

    return {
      id,
      createdAt: now,
      updatedAt: now,
      status: "pending",
      title,
      content,
      scope,
      project,
      category,
      app,
      tags,
      sourceSession: input.sourceSession?.trim() || null,
      reason: (input.reason ?? "").trim().slice(0, 180),
      confidence,
      promotedMemoryId: null,
    };
  }

  getPendingMemory(id: string): PendingMemoryRecord | null {
    const row = this.db
      .prepare("SELECT * FROM pending_memories WHERE id = ?")
      .get<RawPendingRow>(id.trim());
    return row ? rowToPendingRecord(row) : null;
  }

  private buildPendingAclWhere(policy: AppPolicy | null | undefined, where: string[], params: SqlValue[]): boolean {
    if (!policy) return true;
    if (!policy.enabled || policy.mode === "disabled") return false;
    const clauses: string[] = [];
    if (policy.readScopes.includes("global")) {
      clauses.push("scope = 'global'");
    }
    if (policy.readScopes.includes("project")) {
      if (policy.allowedProjects.length === 0) {
        clauses.push("scope = 'project'");
      } else {
        const placeholders = policy.allowedProjects.map(() => "?").join(", ");
        clauses.push(`(scope = 'project' AND project IN (${placeholders}))`);
        params.push(...policy.allowedProjects);
      }
    }
    if (!clauses.length) return false;
    where.push(`(${clauses.join(" OR ")})`);
    return true;
  }

  /** Reclaim rows stuck in `approving` past the stale TTL (e.g. process crash mid-promotion). */
  reclaimStaleApproving(staleAfterMs = 5 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - Math.max(0, staleAfterMs)).toISOString();
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        "UPDATE pending_memories SET status = 'pending', updated_at = ? WHERE status = 'approving' AND updated_at <= ?",
      )
      .run(now, cutoff);
    return Number(res.changes ?? 0);
  }

  listPendingMemories(query?: PendingMemoryQuery): PendingMemoryRecord[] {
    this.reclaimStaleApproving();
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (!this.buildPendingAclWhere(query?.policy, where, params)) {
      return [];
    }
    const status = query?.status ?? "pending";
    if (status !== "all") {
      where.push("status = ?");
      params.push(status);
    }
    if (query?.scope) {
      where.push("scope = ?");
      params.push(query.scope);
    }
    if (query?.project) {
      where.push("project = ?");
      params.push(slugify(query.project));
    }
    if (query?.category) {
      where.push("category = ?");
      params.push(query.category);
    }
    if (query?.app) {
      where.push("app = ?");
      params.push(query.app.trim().toLowerCase());
    }
    const rawLimit = query?.limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.min(200, Math.max(1, Math.trunc(rawLimit)))
        : 50;
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT * FROM pending_memories ${clause} ORDER BY created_at DESC LIMIT ?`)
      .all<RawPendingRow>(...params);
    return rows.map(rowToPendingRecord);
  }

  countPendingMemories(policy?: AppPolicy | null): number {
    this.reclaimStaleApproving();
    const where = ["status = 'pending'"];
    const params: SqlValue[] = [];
    if (!this.buildPendingAclWhere(policy, where, params)) {
      return 0;
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM pending_memories WHERE ${where.join(" AND ")}`)
      .get<{ c: number }>(...params);
    return Number(row?.c ?? 0);
  }

  /** Atomically claim a pending row (or stale crashed `approving` row) for promotion. */
  claimPendingMemory(
    id: string,
    opts?: { staleAfterMs?: number },
  ): PendingMemoryRecord | null {
    const cleanId = id.trim();
    const staleAfterMs = opts?.staleAfterMs ?? 5 * 60 * 1000;
    const cutoff = new Date(Date.now() - Math.max(0, staleAfterMs)).toISOString();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM pending_memories WHERE id = ? AND (status = 'pending' OR (status = 'approving' AND updated_at <= ?))",
        )
        .get<RawPendingRow>(cleanId, cutoff);
      if (!row) return null;
      const res = this.db
        .prepare(
          "UPDATE pending_memories SET status = 'approving', updated_at = ? WHERE id = ? AND (status = 'pending' OR (status = 'approving' AND updated_at <= ?))",
        )
        .run(now, cleanId, cutoff);
      if (Number(res.changes ?? 0) === 0) return null;
      return rowToPendingRecord({ ...row, status: "approving", updated_at: now });
    });
  }

  completePendingApproval(id: string, promotedMemoryId: string): PendingMemoryRecord {
    const cleanId = id.trim();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const res = this.db
        .prepare(
          "UPDATE pending_memories SET status = 'approved', promoted_memory_id = ?, updated_at = ? WHERE id = ? AND status = 'approving'",
        )
        .run(promotedMemoryId, now, cleanId);
      const row = this.db
        .prepare("SELECT * FROM pending_memories WHERE id = ?")
        .get<RawPendingRow>(cleanId);
      if (!row) throw new Error(`Pending memory not found: ${cleanId}`);
      if (Number(res.changes ?? 0) === 0) {
        const current = rowToPendingRecord(row);
        throw new PendingStateConflictError(cleanId, current.status, "complete approval for");
      }
      return rowToPendingRecord(row);
    });
  }

  revertPendingClaim(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE pending_memories SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'approving'")
      .run(now, id.trim());
  }

  dismissPendingMemory(id: string): PendingMemoryRecord {
    const cleanId = id.trim();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const res = this.db
        .prepare(
          "UPDATE pending_memories SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(now, cleanId);
      const row = this.db
        .prepare("SELECT * FROM pending_memories WHERE id = ?")
        .get<RawPendingRow>(cleanId);
      if (!row) {
        throw new Error(`Pending memory not found: ${cleanId}`);
      }
      if (Number(res.changes ?? 0) === 0) {
        const current = rowToPendingRecord(row);
        throw new PendingStateConflictError(cleanId, current.status, "dismiss");
      }
      return rowToPendingRecord(row);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
