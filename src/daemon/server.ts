#!/usr/bin/env node
/**
 * Local Streamable HTTP MCP Daemon + Control API + Mini-Dashboard (`localhost:4190`).
 *
 * - Serves MCP over Streamable HTTP at `/mcp?app=<harness>` (keeps stdio in `src/mcp/server.ts`).
 * - Shares one embedding model & SQLite hybrid index across Cursor, Claude, Codex, Zed.
 * - Enforces live per-app ACLs & records secret-redacted `access_log` entries.
 * - Serves a zero-CDN local control dashboard at `GET /`.
 * - Works on both Node.js 22+ (`node:http` + `node:sqlite`) and Bun (`node:http` + `bun:sqlite`).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  configDir,
  loadConfig,
  resolveVaultPath,
  type AppConfigEntry,
  type DaemonConfig,
} from "../config.ts";
import { loadEnvFile } from "../env.ts";
import {
  searchHybrid,
  syncVaultIndex,
  type Embedder,
  type SearchMode,
} from "../index/index.ts";
import { createBrainServer } from "../mcp/server.ts";
import {
  addMemorySmart,
  deleteMemory,
  listMemories,
  MEMORY_CATEGORIES,
  searchMemories,
  SecretDetectedError,
  supersedeMemory,
  type MemoryCategory,
} from "../memory/index.ts";
import { isMainModule } from "../runtime.ts";
import { vaultInfo } from "../vault.ts";
import {
  normalizeAppNameOrDefault,
  validateAppName,
  type AccessMode,
  type AppPolicyPatch,
  type ScopeFilter,
} from "./acl.ts";
import {
  DaemonStateStore,
  type AccessLogEntry,
  type AccessStatus,
} from "./state.ts";
import { renderDashboardHtml } from "./ui.ts";

export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 4190;

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_MCP_SESSIONS = 64;
const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type DaemonOptions = {
  vaultPath?: string;
  host?: string;
  port?: number;
  allowRemote?: boolean;
  /** Optional bearer token required on /mcp and /api/*. */
  authToken?: string;
  /** Override SQLite paths (useful in tests). */
  stateDbPath?: string;
  indexDbPath?: string;
  /** Override embedder (e.g. mock or null in tests). */
  embedder?: Embedder | null;
  /** Daemon & app ACL config overrides (defaults to config.toml). */
  daemonConfig?: DaemonConfig;
  configApps?: Record<string, AppConfigEntry>;
  /** Warm the hybrid search index in the background on startup (default true). */
  warmup?: boolean;
  /** Watch vault markdown files for incremental reindex (default false in library calls, true in CLI). */
  watchVault?: boolean;
  /** Suppress startup console logs (useful in tests). */
  quiet?: boolean;
};

export type BrainDaemonHandle = {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly mcpUrl: string;
  readonly vaultPath: string;
  readonly stateStore: DaemonStateStore;
  readonly server: Server;
  activeSessionCount(): number;
  close(): Promise<void>;
};

type ManagedSession = {
  id: string;
  app: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastUsedAt: number;
};

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJsonRpcError(
  res: ServerResponse,
  httpStatus: number,
  code: number,
  message: string,
): void {
  sendJson(res, httpStatus, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

class PayloadTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
}

class InvalidJsonError extends Error {
  constructor() {
    super("Request body is not valid JSON");
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError();
  }
}

function isAllowedLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[::1]")) {
    return /^\[::1\](?::\d+)?$/.test(trimmed);
  }
  const hostname = trimmed.split(":")[0] ?? "";
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function isAllowedOrigin(originHeader: string | undefined, boundPort: number): boolean {
  if (!originHeader) return true; // Non-browser MCP/CLI clients omit Origin
  try {
    const u = new URL(originHeader);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
      return false;
    }
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    return port === boundPort;
  } catch {
    return false;
  }
}

function extractAuthToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  const hdr = req.headers["x-brain-token"];
  if (typeof hdr === "string" && hdr.trim()) return hdr.trim();
  return null;
}

function parseAppFromRequest(url: URL, req: IncomingMessage): string {
  const queryApp = url.searchParams.get("app");
  if (queryApp !== null && queryApp !== "") {
    return validateAppName(queryApp);
  }
  const headerApp = req.headers["x-brain-app"];
  if (typeof headerApp === "string" && headerApp.trim()) {
    return validateAppName(headerApp);
  }
  return "anonymous";
}

function isInitializeMessage(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  if (Array.isArray(body)) {
    return body.some(
      (item) => item && typeof item === "object" && (item as { method?: unknown }).method === "initialize",
    );
  }
  return (body as { method?: unknown }).method === "initialize";
}

export async function startBrainDaemon(
  options: DaemonOptions = {},
): Promise<BrainDaemonHandle> {
  const loadedConfig = options.vaultPath && options.daemonConfig !== undefined
    ? null
    : await loadConfig();

  const daemonCfg: DaemonConfig = {
    ...(loadedConfig?.daemon ?? {}),
    ...(options.daemonConfig ?? {}),
  };
  const configApps = options.configApps ?? loadedConfig?.apps;
  const vaultPath = options.vaultPath ?? resolveVaultPath(loadedConfig!.vault_path);

  const host = (options.host ?? daemonCfg.host ?? DEFAULT_DAEMON_HOST).trim();
  const requestedPort =
    options.port !== undefined
      ? options.port
      : daemonCfg.port !== undefined
        ? daemonCfg.port
        : DEFAULT_DAEMON_PORT;
  const allowRemote = Boolean(options.allowRemote ?? daemonCfg.allow_remote ?? false);

  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(
      `Refusing to bind brain daemon to non-loopback host "${host}" without allowRemote (--allow-remote).`,
    );
  }

  const tokenEnvName = daemonCfg.auth_token_env?.trim() || "BRAIN_DAEMON_TOKEN";
  const authToken =
    options.authToken !== undefined
      ? options.authToken.trim() || null
      : process.env[tokenEnvName]?.trim() || null;

  const stateStore = await DaemonStateStore.open(vaultPath, {
    dbPath: options.stateDbPath,
    daemonConfig: daemonCfg,
    configApps,
  });

  const sessions = new Map<string, ManagedSession>();
  const sseClients = new Set<ServerResponse>();
  const startedAt = Date.now();
  let indexReady = false;
  let boundPort = requestedPort;

  const broadcastEvent = (eventName: string, payload: unknown): void => {
    if (!sseClients.size) return;
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const onAccessEvent = (entry: AccessLogEntry): void => {
    broadcastEvent("access", entry);
  };

  const evictIdleSessions = (): void => {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    for (const [sid, session] of sessions.entries()) {
      if (session.lastUsedAt < cutoff) {
        sessions.delete(sid);
        void session.server.close().catch(() => {});
      }
    }
  };

  const sweepTimer = setInterval(evictIdleSessions, 5 * 60 * 1000);
  sweepTimer.unref?.();

  const ssePingTimer = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(": ping\n\n");
      } catch {
        sseClients.delete(client);
      }
    }
  }, 25_000);
  ssePingTimer.unref?.();

  async function handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      res.writeHead(405, { Allow: "GET, POST, DELETE" });
      res.end();
      return;
    }

    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId =
      typeof rawSessionId === "string" && rawSessionId.trim()
        ? rawSessionId.trim()
        : undefined;

    let reqApp: string;
    try {
      reqApp = parseAppFromRequest(url, req);
    } catch (err) {
      sendJsonRpcError(
        res,
        400,
        -32602,
        err instanceof Error ? err.message : "Invalid app parameter",
      );
      return;
    }

    let parsedBody: unknown;
    if (method === "POST") {
      try {
        parsedBody = await readJsonBody(req);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendJsonRpcError(res, 413, -32600, err.message);
          return;
        }
        sendJsonRpcError(res, 400, -32700, "Parse error: invalid JSON");
        return;
      }
    }

    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        sendJsonRpcError(res, 404, -32001, "MCP session not found");
        return;
      }
      // Prevent one app from hijacking another app's session
      const explicitApp =
        url.searchParams.get("app") ||
        (typeof req.headers["x-brain-app"] === "string" ? req.headers["x-brain-app"] : "");
      if (explicitApp && reqApp !== existing.app) {
        sendJsonRpcError(
          res,
          403,
          -32003,
          `Session belongs to app "${existing.app}", not "${reqApp}"`,
        );
        return;
      }
      existing.lastUsedAt = Date.now();
      await existing.transport.handleRequest(req, res, parsedBody);
      return;
    }

    // No session ID: only POST initialize may open a new stateful session
    if (method !== "POST" || !isInitializeMessage(parsedBody)) {
      sendJsonRpcError(
        res,
        400,
        -32600,
        "Bad Request: missing mcp-session-id header for non-initialization request",
      );
      return;
    }

    evictIdleSessions();
    if (sessions.size >= MAX_MCP_SESSIONS) {
      sendJsonRpcError(res, 503, -32000, "Too many active MCP sessions");
      return;
    }

    // Register app immediately on connect so it appears in the dashboard
    stateStore.touchApp(reqApp);

    const mcpServer = createBrainServer({
      vaultPath,
      indexDbPath: options.indexDbPath,
      embedder: options.embedder,
      app: reqApp,
      lockAppProvenance: true,
      stateStore,
      onAccessEvent,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        const now = Date.now();
        sessions.set(sid, {
          id: sid,
          app: reqApp,
          server: mcpServer,
          transport,
          createdAt: now,
          lastUsedAt: now,
        });
      },
    });

    await mcpServer.connect(transport);
    const prevOnClose = transport.onclose;
    let cleanedUp = false;
    transport.onclose = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      prevOnClose?.();
    };
    await transport.handleRequest(req, res, parsedBody);
  }

  async function handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = url.pathname;

    // GET /api/events — live SSE stream for dashboard
    if (pathname === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    // GET /api/health
    if (pathname === "/api/health" && method === "GET") {
      const [info, memories] = await Promise.all([
        vaultInfo(vaultPath),
        listMemories(vaultPath, { status: "active" }).catch(() => []),
      ]);
      sendJson(res, 200, {
        ok: true,
        status: "running",
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        vault: vaultPath,
        readable: info.readable,
        noteCount: info.noteCount,
        memoryCount: memories.length,
        activeSessions: sessions.size,
        indexReady,
      });
      return;
    }

    // GET /api/apps
    if (pathname === "/api/apps" && method === "GET") {
      const sessionCounts = new Map<string, number>();
      for (const s of sessions.values()) {
        sessionCounts.set(s.app, (sessionCounts.get(s.app) ?? 0) + 1);
      }
      const apps = stateStore.listApps().map((a) => ({
        ...a,
        activeSessions: sessionCounts.get(a.app) ?? 0,
      }));
      sendJson(res, 200, { apps });
      return;
    }

    // DELETE /api/apps/:app/override
    const resetMatch = pathname.match(/^\/api\/apps\/([^/]+)\/override$/);
    if (resetMatch && method === "DELETE") {
      try {
        const appName = validateAppName(decodeURIComponent(resetMatch[1]!));
        const updated = stateStore.resetAppOverride(appName);
        broadcastEvent("acl", updated);
        sendJson(res, 200, { app: updated });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // PUT /api/apps/:app
    const appMatch = pathname.match(/^\/api\/apps\/([^/]+)$/);
    if (appMatch && method === "PUT") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const status = err instanceof PayloadTooLargeError ? 413 : 400;
        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendJson(res, 400, { error: "Expected JSON object body" });
        return;
      }
      const raw = body as Record<string, unknown>;
      const patch: AppPolicyPatch = {};
      if (raw.enabled !== undefined) {
        if (typeof raw.enabled !== "boolean") {
          sendJson(res, 400, { error: "enabled must be a boolean" });
          return;
        }
        patch.enabled = raw.enabled;
      }
      if (raw.mode !== undefined) {
        if (raw.mode !== "read-write" && raw.mode !== "read-only" && raw.mode !== "disabled") {
          sendJson(res, 400, { error: "mode must be read-write | read-only | disabled" });
          return;
        }
        patch.mode = raw.mode;
      }
      const parseStrictScopeArray = (val: unknown, field: string): ScopeFilter[] => {
        if (!Array.isArray(val)) throw new Error(`${field} must be an array`);
        const out: ScopeFilter[] = [];
        for (const item of val) {
          if (item !== "global" && item !== "project") {
            throw new Error(`${field} items must be "global" or "project"`);
          }
          if (!out.includes(item)) out.push(item);
        }
        return out;
      };
      const parseStrictStringArray = (val: unknown, field: string): string[] => {
        if (!Array.isArray(val) || !val.every((x) => typeof x === "string")) {
          throw new Error(`${field} must be an array of strings`);
        }
        return val as string[];
      };
      try {
        if (raw.readScopes !== undefined) {
          patch.readScopes = parseStrictScopeArray(raw.readScopes, "readScopes");
        }
        if (raw.writeScopes !== undefined) {
          patch.writeScopes = parseStrictScopeArray(raw.writeScopes, "writeScopes");
        }
        if (raw.allowedProjects !== undefined) {
          patch.allowedProjects = parseStrictStringArray(raw.allowedProjects, "allowedProjects");
        }
        if (raw.deniedTools !== undefined) {
          patch.deniedTools = parseStrictStringArray(raw.deniedTools, "deniedTools");
        }
        const appName = validateAppName(decodeURIComponent(appMatch[1]!));
        const updated = stateStore.upsertAppOverride(appName, patch);
        broadcastEvent("acl", updated);
        sendJson(res, 200, { app: updated });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // GET /api/logs | DELETE /api/logs
    if (pathname === "/api/logs" && method === "GET") {
      const app = url.searchParams.get("app") || undefined;
      const tool = url.searchParams.get("tool") || undefined;
      const statusRaw = url.searchParams.get("status");
      const status =
        statusRaw === "ok" || statusRaw === "denied" || statusRaw === "error"
          ? (statusRaw as AccessStatus)
          : undefined;
      const opRaw = url.searchParams.get("operation");
      const operation = opRaw === "read" || opRaw === "write" ? opRaw : undefined;
      const limitRaw = url.searchParams.get("limit");
      const beforeRaw = url.searchParams.get("beforeId");
      const limitNum = limitRaw ? Number(limitRaw) : 100;
      const beforeNum = beforeRaw ? Number(beforeRaw) : undefined;
      const logs = stateStore.queryLogs({
        app,
        tool,
        status,
        operation,
        limit: Number.isFinite(limitNum) ? limitNum : 100,
        beforeId: beforeNum !== undefined && Number.isFinite(beforeNum) ? beforeNum : undefined,
      });
      sendJson(res, 200, { count: logs.length, logs });
      return;
    }

    if (pathname === "/api/logs" && method === "DELETE") {
      const deleted = stateStore.clearLogs();
      sendJson(res, 200, { ok: true, deleted });
      return;
    }

    // POST /api/search — Search Score Debugger
    if (pathname === "/api/search" && method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const status = err instanceof PayloadTooLargeError ? 413 : 400;
        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const b = (body ?? {}) as Record<string, unknown>;
      const query = typeof b.query === "string" ? b.query.trim() : "";
      if (!query) {
        sendJson(res, 400, { error: "query is required" });
        return;
      }
      const target = b.target === "memories" ? "memories" : "notes";
      const modeRaw = typeof b.mode === "string" ? b.mode : "hybrid";
      const mode: SearchMode =
        modeRaw === "fts" || modeRaw === "vector" ? modeRaw : "hybrid";
      const limit =
        typeof b.limit === "number" && Number.isFinite(b.limit)
          ? Math.min(50, Math.max(1, Math.trunc(b.limit)))
          : 10;
      const project = typeof b.project === "string" && b.project.trim() ? b.project.trim() : undefined;
      const scope =
        b.scope === "global" || b.scope === "project" ? b.scope : undefined;
      const category =
        typeof b.category === "string" &&
        (MEMORY_CATEGORIES as readonly string[]).includes(b.category)
          ? (b.category as MemoryCategory)
          : undefined;
      const status =
        b.status === "active" || b.status === "superseded" || b.status === "all"
          ? b.status
          : "active";

      try {
        if (target === "memories") {
          const resMem = await searchMemories(vaultPath, query, {
            limit,
            mode,
            project,
            scope,
            category,
            status,
            dbPath: options.indexDbPath,
            embedder: options.embedder,
          });
          sendJson(res, 200, resMem);
          return;
        }
        const resNotes = await searchHybrid(vaultPath, query, {
          limit,
          mode,
          project,
          scope,
          dbPath: options.indexDbPath,
          embedder: options.embedder,
        });
        sendJson(res, 200, resNotes);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // GET /api/memories
    if (pathname === "/api/memories" && method === "GET") {
      const scopeRaw = url.searchParams.get("scope");
      const scope = scopeRaw === "global" || scopeRaw === "project" ? scopeRaw : undefined;
      const project = url.searchParams.get("project") || undefined;
      const catRaw = url.searchParams.get("category");
      const category =
        catRaw && (MEMORY_CATEGORIES as readonly string[]).includes(catRaw)
          ? (catRaw as MemoryCategory)
          : undefined;
      const app = url.searchParams.get("app") || undefined;
      const statusRaw = url.searchParams.get("status");
      const status =
        statusRaw === "active" || statusRaw === "superseded" || statusRaw === "all"
          ? statusRaw
          : "active";
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Math.min(200, Math.max(1, Number(limitRaw) || 50)) : 50;

      const memories = await listMemories(vaultPath, {
        scope,
        project,
        category,
        app,
        status,
        limit,
      });
      sendJson(res, 200, { count: memories.length, memories });
      return;
    }

    // POST /api/memories
    if (pathname === "/api/memories" && method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const status = err instanceof PayloadTooLargeError ? 413 : 400;
        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const b = (body ?? {}) as Record<string, unknown>;
      const title = typeof b.title === "string" ? b.title.trim() : "";
      const content = typeof b.content === "string" ? b.content.trim() : "";
      if (!title || !content) {
        sendJson(res, 400, { error: "title and content are required" });
        return;
      }
      const scope = b.scope === "global" || b.scope === "project" ? b.scope : undefined;
      const project = typeof b.project === "string" && b.project.trim() ? b.project.trim() : undefined;
      const category =
        typeof b.category === "string" &&
        (MEMORY_CATEGORIES as readonly string[]).includes(b.category)
          ? (b.category as MemoryCategory)
          : undefined;
      const tags = Array.isArray(b.tags)
        ? b.tags.filter((t): t is string => typeof t === "string")
        : undefined;
      try {
        const result = await addMemorySmart(vaultPath, {
          title,
          content,
          scope,
          project,
          category,
          app: normalizeAppNameOrDefault(typeof b.app === "string" ? b.app : undefined, "ui"),
          tags,
          dedupe: b.dedupe === "force" ? "force" : "dedupe",
          dbPath: options.indexDbPath,
          embedder: options.embedder,
        });
        sendJson(res, 200, result);
      } catch (err) {
        const status = err instanceof SecretDetectedError ? 422 : 400;
        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // POST /api/memories/:id/supersede
    const supMatch = pathname.match(/^\/api\/memories\/([^/]+)\/supersede$/);
    if (supMatch && method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const status = err instanceof PayloadTooLargeError ? 413 : 400;
        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const b = (body ?? {}) as Record<string, unknown>;
      const content = typeof b.content === "string" ? b.content.trim() : "";
      if (!content) {
        sendJson(res, 400, { error: "content is required" });
        return;
      }
      try {
        const oldId = decodeURIComponent(supMatch[1]!);
        const result = await supersedeMemory(vaultPath, oldId, {
          title: typeof b.title === "string" && b.title.trim() ? b.title.trim() : undefined,
          content,
          app: "ui",
        });
        await syncVaultIndex(vaultPath, {
          dbPath: options.indexDbPath,
          embedder: options.embedder,
        }).catch(() => {});
        sendJson(res, 200, result);
      } catch (err) {
        const status = err instanceof SecretDetectedError ? 422 : 400;
        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // DELETE /api/memories/:id
    const delMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (delMatch && method === "DELETE") {
      try {
        const id = decodeURIComponent(delMatch[1]!);
        const result = await deleteMemory(vaultPath, id);
        await syncVaultIndex(vaultPath, {
          dbPath: options.indexDbPath,
          embedder: options.embedder,
        }).catch(() => {});
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // POST /api/reindex
    if (pathname === "/api/reindex" && method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      const forceRebuild = Boolean(
        body && typeof body === "object" && (body as { force?: unknown }).force,
      );
      try {
        const stats = await syncVaultIndex(vaultPath, {
          forceRebuild,
          dbPath: options.indexDbPath,
          embedder: options.embedder,
        });
        indexReady = true;
        sendJson(res, 200, stats);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });
  }

  const dashboardHtml = renderDashboardHtml({ tokenRequired: Boolean(authToken) });

  const httpServer = createServer(async (req, res) => {
    try {
      // 1. DNS rebinding protection when bound to loopback
      if (isLoopbackHost(host) && !isAllowedLoopbackHostHeader(req.headers.host)) {
        sendJson(res, 403, { error: "Forbidden: invalid Host header" });
        return;
      }

      const url = new URL(req.url ?? "/", `http://${host}:${boundPort}`);
      const pathname = url.pathname;
      const isApiOrMcp =
        pathname === "/mcp" ||
        pathname === "/mcp/" ||
        pathname.startsWith("/api/");

      // 2. Origin CSRF protection for browser requests hitting /mcp or /api/*
      if (isApiOrMcp && !allowRemote && !isAllowedOrigin(req.headers.origin, boundPort)) {
        sendJson(res, 403, { error: "Forbidden: cross-origin request rejected" });
        return;
      }

      // 3. Optional Bearer token auth on /mcp and /api/*
      if (isApiOrMcp && authToken) {
        const provided = extractAuthToken(req);
        if (!provided || !constantTimeEquals(provided, authToken)) {
          res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8",
            "WWW-Authenticate": 'Bearer realm="ai-mcp-brain"',
          });
          res.end(JSON.stringify({ error: "Unauthorized: valid daemon token required" }));
          return;
        }
      }

      // 4. Dashboard UI at GET /
      if ((pathname === "/" || pathname === "/index.html") && (req.method ?? "GET") === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        });
        res.end(dashboardHtml);
        return;
      }

      // 5. Streamable HTTP MCP endpoint
      if (pathname === "/mcp" || pathname === "/mcp/") {
        await handleMcpRequest(req, res, url);
        return;
      }

      // 6. Local control REST API
      if (pathname.startsWith("/api/")) {
        await handleApiRequest(req, res, url);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => rejectListen(err);
    httpServer.once("error", onError);
    httpServer.listen(requestedPort, host, () => {
      httpServer.off("error", onError);
      resolveListen();
    });
  });

  const addr = httpServer.address() as AddressInfo;
  boundPort = addr.port;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  const baseUrl = `http://${displayHost}:${boundPort}`;

  // Optional debounced vault watcher so Obsidian edits trigger incremental reindex
  let watcher: FSWatcher | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  if (options.watchVault) {
    try {
      watcher = fsWatch(vaultPath, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith(".md")) return;
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          void syncVaultIndex(vaultPath, {
            dbPath: options.indexDbPath,
            embedder: options.embedder,
          })
            .then(() => {
              indexReady = true;
            })
            .catch(() => {});
        }, 750);
        watchTimer.unref?.();
      });
      watcher.on("error", () => {});
    } catch {
      // Recursive fs.watch may be unsupported on some platforms; fail open cleanly
      watcher = null;
    }
  }

  // Non-blocking background index warm-up
  if (options.warmup !== false && process.env.BRAIN_MCP_WARMUP !== "0") {
    void syncVaultIndex(vaultPath, {
      dbPath: options.indexDbPath,
      embedder: options.embedder,
    })
      .then((stats) => {
        indexReady = true;
        if (!options.quiet) {
          console.error(
            `[brain-daemon] index ready (${stats.chunksIndexed} chunks, ${stats.durationMs}ms, model=${stats.embedModel ?? "fts-only"})`,
          );
        }
      })
      .catch((err) => {
        if (!options.quiet) {
          console.error(
            `[brain-daemon] index warm-up skipped: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      });
  }

  if (!options.quiet) {
    console.error(`[brain-daemon] listening at ${baseUrl}`);
    console.error(`[brain-daemon] MCP endpoint: ${baseUrl}/mcp?app=<harness>`);
    console.error(`[brain-daemon] Dashboard UI: ${baseUrl}/`);
    console.error(`[brain-daemon] Vault:        ${vaultPath}`);
    if (authToken) {
      console.error(`[brain-daemon] Auth:         Bearer token enabled`);
    }
  }

  let closed = false;
  return {
    host,
    port: boundPort,
    url: baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    vaultPath,
    stateStore,
    server: httpServer,
    activeSessionCount: () => sessions.size,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(sweepTimer);
      clearInterval(ssePingTimer);
      if (watchTimer) clearTimeout(watchTimer);
      watcher?.close();
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      const active = [...sessions.values()];
      sessions.clear();
      for (const session of active) {
        await session.server.close().catch(() => {});
      }
      await new Promise<void>((resolveClose) => {
        httpServer.close(() => resolveClose());
        httpServer.closeAllConnections?.();
      });
      stateStore.close();
    },
  };
}

async function main(): Promise<void> {
  await loadEnvFile(join(configDir(), ".env"));
  const handle = await startBrainDaemon({ watchVault: true });

  const shutdown = () => {
    console.error("\n[brain-daemon] shutting down...");
    void handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("[brain-daemon] fatal:", err);
    process.exit(1);
  });
}
