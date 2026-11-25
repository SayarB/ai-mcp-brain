#!/usr/bin/env node
/**
 * Second-brain MCP server (stdio & shared tool registry for Streamable HTTP daemon).
 * Logs go to stderr only — stdout is reserved for MCP JSON-RPC in stdio mode.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join } from "node:path";
import { z } from "zod";
import { listActions, resolveAction } from "../actions.ts";
import { configDir, loadConfig, resolveVaultPath } from "../config.ts";
import {
  AclDeniedError,
  assertScopeAccess,
  canReadTarget,
  canWriteTarget,
  checkToolAccess,
  classifyToolOperation,
  inferNoteScopeAndProject,
  normalizeAppNameOrDefault,
  summarizeToolCall,
  type AppPolicy,
} from "../daemon/acl.ts";
import type { AccessLogEntry, DaemonStateStore } from "../daemon/state.ts";
import { loadEnvFile } from "../env.ts";
import {
  searchHybrid,
  syncVaultIndex,
  type Embedder,
  type HybridSearchOptions,
  type SearchMode,
} from "../index/index.ts";
import { JiraNotConfiguredError } from "../jira/client.ts";
import {
  addMemorySmart,
  deleteMemory,
  findMemoryById,
  listMemories,
  MEMORY_CATEGORIES,
  searchMemories,
  supersedeMemory,
  updateMemory,
  type MemoryCategory,
} from "../memory/index.ts";
import { isMainModule } from "../runtime.ts";
import {
  findMarkdownSection,
  getProjectContext,
  listGuidance,
  listRecent,
  noteToSummary,
  noteToTailSummary,
  readNote,
  rememberNote,
  resolveGuidance,
  resolveProjectSlug,
  searchNotes,
  trackTool,
  upsertGuidance,
  vaultInfo,
} from "../vault.ts";
import {
  toolJiraAssigned,
  toolJiraRelease,
  toolWorkLog,
  toolWorkPlate,
  toolWorkToday,
} from "../work/tools.ts";

export type BrainServerOptions = {
  /** Override vault path (defaults to config.toml / BRAIN_VAULT). */
  vaultPath?: string;
  /** Override SQLite hybrid index path (useful in tests & daemon). */
  indexDbPath?: string;
  /** Override embedder (e.g. mock or null in tests). */
  embedder?: Embedder | null;
  /** Harness/client identifier (e.g. cursor, claude, codex, zed). */
  app?: string;
  /** When true (HTTP daemon mode), stamp memory provenance with the authenticated app. */
  lockAppProvenance?: boolean;
  /** Optional persistent daemon state store enabling live per-app ACLs and access_log. */
  stateStore?: DaemonStateStore;
  /** Optional hook notified whenever a tool call is logged. */
  onAccessEvent?: (entry: AccessLogEntry) => void;
};

type ToolTextResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

type GuardedOutcome = {
  result: ToolTextResult;
  resultCount?: number | null;
};

function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown): ToolTextResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

function hasReadRestriction(policy: AppPolicy | null): boolean {
  if (!policy) return false;
  return (
    policy.allowedProjects.length > 0 ||
    !policy.readScopes.includes("global") ||
    !policy.readScopes.includes("project")
  );
}

export function createBrainServer(options: BrainServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "ai-mcp-brain",
    version: "0.3.0",
  });

  const configuredApp = normalizeAppNameOrDefault(
    options.app ?? process.env.BRAIN_APP,
    "anonymous",
  );
  const stateStore = options.stateStore;
  const lockAppProvenance = Boolean(options.lockAppProvenance);

  async function resolveVault(): Promise<string> {
    if (options.vaultPath) return options.vaultPath;
    const config = await loadConfig();
    return resolveVaultPath(config.vault_path);
  }

  function resolveMemoryApp(argApp?: string): string | undefined {
    if (lockAppProvenance && configuredApp !== "anonymous") {
      return configuredApp;
    }
    if (argApp?.trim()) return argApp.trim();
    return configuredApp !== "anonymous" ? configuredApp : undefined;
  }

  async function runGuarded(
    tool: string,
    args: Record<string, unknown> | undefined,
    fn: (ctx: { vault: string; policy: AppPolicy | null }) => Promise<GuardedOutcome>,
  ): Promise<ToolTextResult> {
    const started = Date.now();
    const operation = classifyToolOperation(tool, args);
    const summary = summarizeToolCall(tool, args);

    const emitLog = (
      status: "ok" | "denied" | "error",
      resultCount: number | null,
      detailSummary?: string,
    ) => {
      if (!stateStore) return;
      try {
        const entry = stateStore.recordAccess({
          app: configuredApp,
          tool,
          operation,
          status,
          summary: detailSummary ?? summary,
          resultCount,
          durationMs: Date.now() - started,
        });
        options.onAccessEvent?.(entry);
      } catch {
        // Logging must never crash tool execution
      }
    };

    try {
      const policy = stateStore ? stateStore.getEffectivePolicy(configuredApp) : null;
      if (policy) {
        checkToolAccess(policy, tool, operation);
      }
      const vault = await resolveVault();
      const outcome = await fn({ vault, policy });
      const status = outcome.result.isError ? "error" : "ok";
      emitLog(status, outcome.resultCount ?? null);
      return outcome.result;
    } catch (err) {
      if (err instanceof AclDeniedError) {
        emitLog("denied", 0, `${summary} — ${err.reason}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        emitLog("error", 0, `${summary} — ${msg}`);
      }
      return errorResult(err);
    }
  }

  server.registerTool(
    "vault_info",
    {
      title: "Vault info",
      description:
        "Diagnostics: resolved vault path, whether it is readable, and note count. Use when vault access seems broken.",
    },
    async () =>
      runGuarded("vault_info", undefined, async ({ vault }) => {
        const info = await vaultInfo(vault);
        return {
          result: textResult(JSON.stringify(info, null, 2)),
          resultCount: info.noteCount,
        };
      }),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Hybrid semantic + full-text (FTS5 BM25 + local embeddings + wikilink graph) search across the Obsidian second-brain vault. Supports optional filters by project, scope, type, tags, and updated_after.",
      inputSchema: {
        query: z.string().min(1).describe("Search query (keywords or natural language)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results (default 10)"),
        mode: z
          .enum(["hybrid", "fts", "vector"])
          .optional()
          .describe("Retrieval mode: hybrid (default), fts (BM25 only), or vector (semantic only)"),
        project: z
          .string()
          .optional()
          .describe("Filter to a specific git repo slug"),
        scope: z
          .enum(["global", "project"])
          .optional()
          .describe("Filter by global or project scope"),
        type: z
          .string()
          .optional()
          .describe("Filter by note type (project, pattern, stack, instruction, suggestion, workflow, inbox, …)"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Filter to notes matching all given tags"),
        updated_after: z
          .string()
          .optional()
          .describe("Filter to notes updated on or after YYYY-MM-DD"),
      },
    },
    async (args) =>
      runGuarded("search_notes", args, async ({ vault, policy }) => {
        const { query, limit, mode, project, scope, type, tags, updated_after } = args;
        const canonicalProject = project ? await resolveProjectSlug(vault, project) : undefined;
        if (policy) {
          if (canonicalProject) {
            assertScopeAccess(policy, "search_notes", "read", "project", canonicalProject);
          } else if (scope) {
            if (!policy.readScopes.includes(scope)) {
              throw new AclDeniedError(
                policy.app,
                "search_notes",
                `read access to ${scope} scope is not permitted`,
              );
            }
          }
        }

        const effectiveScope: "global" | "project" | undefined =
          scope ??
          (policy && policy.readScopes.length === 1 ? policy.readScopes[0] : undefined);
        const effectiveProject =
          canonicalProject ??
          (policy &&
          !policy.readScopes.includes("global") &&
          policy.allowedProjects.length === 1
            ? policy.allowedProjects[0]
            : undefined);

        const requestedLimit = limit ?? 10;
        const fetchLimit = hasReadRestriction(policy)
          ? Math.min(100, requestedLimit * 4)
          : requestedLimit;

        const opts: HybridSearchOptions = {
          limit: fetchLimit,
          mode: mode as SearchMode | undefined,
          project: effectiveProject,
          scope: effectiveScope,
          type,
          tags,
          updatedAfter: updated_after,
          dbPath: options.indexDbPath,
          embedder: options.embedder,
        };

        try {
          const result = await searchHybrid(vault, query, opts);
          const filteredHits = policy
            ? result.hits
                .filter((h) => {
                  const inferred = inferNoteScopeAndProject(h.path);
                  const pathAllowed = canReadTarget(policy, inferred.scope, inferred.project);
                  const metaAllowed = h.project
                    ? canReadTarget(policy, "project", h.project)
                    : h.scope === "global" || h.scope === "project"
                      ? canReadTarget(policy, h.scope, h.project)
                      : true;
                  return pathAllowed && metaAllowed;
                })
                .map((h) => ({
                  ...h,
                  relatedLinks: h.relatedLinks.filter((lnk) => {
                    const inf = inferNoteScopeAndProject(lnk);
                    return canReadTarget(policy, inf.scope, inf.project);
                  }),
                }))
                .slice(0, requestedLimit)
            : result.hits.slice(0, requestedLimit);

          if (!filteredHits.length) {
            return {
              result: textResult(`No notes matched: ${query} (mode=${result.modeUsed})`),
              resultCount: 0,
            };
          }
          const body = filteredHits
            .map((h, i) => {
              const metaBits = [
                h.type ? `type=${h.type}` : null,
                h.project ? `project=${h.project}` : h.scope ? `scope=${h.scope}` : null,
                h.updated ? `updated=${h.updated}` : null,
                `via=${h.matchedBy.join("+")}`,
                h.vectorScore !== null ? `sim=${h.vectorScore}` : null,
              ]
                .filter(Boolean)
                .join(", ");
              const label =
                h.heading && h.heading !== h.title
                  ? h.heading.startsWith(h.title)
                    ? h.heading
                    : `${h.title} — ${h.heading}`
                  : h.title;
              const linksLine = h.relatedLinks.length
                ? `\n   links: ${h.relatedLinks.join(", ")}`
                : "";
              return `${i + 1}. ${h.path} (${label}) [score=${h.score}; ${metaBits}]\n   ${h.snippet}${linksLine}`;
            })
            .join("\n\n");
          const warn = result.embedWarning
            ? `\nNote: embeddings unavailable (${result.embedWarning}); used FTS5.`
            : "";
          return {
            result: textResult(
              `Vault: ${vault} (mode=${result.modeUsed}, ${result.searchMs}ms)${warn}\n\n${body}`,
            ),
            resultCount: filteredHits.length,
          };
        } catch (indexErr) {
          console.error(
            `[ai-mcp-brain] hybrid index failed, falling back to legacy search: ${
              indexErr instanceof Error ? indexErr.message : String(indexErr)
            }`,
          );
          const rawHits = await searchNotes(vault, query, fetchLimit);
          const hits = policy
            ? rawHits
                .filter((h) => {
                  const inf = inferNoteScopeAndProject(h.path);
                  return canReadTarget(policy, inf.scope, inf.project);
                })
                .slice(0, requestedLimit)
            : rawHits.slice(0, requestedLimit);
          if (!hits.length) {
            return { result: textResult(`No notes matched: ${query}`), resultCount: 0 };
          }
          const body = hits
            .map(
              (h, i) =>
                `${i + 1}. ${h.path} (${h.title}) [score=${h.score}]\n   ${h.snippet}`,
            )
            .join("\n\n");
          return {
            result: textResult(`Vault: ${vault} (legacy fallback)\n\n${body}`),
            resultCount: hits.length,
          };
        }
      }),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description:
        "Read a vault note by relative path (e.g. projects/my-repo/decisions.md). Returns up to 16,000 chars by default; pass section to jump to a heading or tail=true for newest appended entries.",
      inputSchema: {
        path: z.string().min(1).describe("Relative path inside the vault"),
        section: z
          .string()
          .optional()
          .describe("Optional heading text to extract only that section"),
        tail: z
          .boolean()
          .optional()
          .describe("If true and note exceeds max_chars, keep header + newest tail"),
        max_chars: z
          .number()
          .int()
          .min(200)
          .max(100000)
          .optional()
          .describe("Max body characters to return (default 16000)"),
      },
    },
    async (args) =>
      runGuarded("read_note", args, async ({ vault, policy }) => {
        const { path, section, tail, max_chars } = args;
        if (policy) {
          const target = inferNoteScopeAndProject(path);
          assertScopeAccess(policy, "read_note", "read", target.scope, target.project);
        }
        const note = await readNote(vault, path);
        if (section?.trim()) {
          const span = findMarkdownSection(note.body, section);
          const slice = note.body.slice(span.start, span.end).trim();
          return {
            result: textResult(
              `path: ${note.path}\ntitle: ${note.title}\nsection: ${span.heading}\n\n${slice}`,
            ),
            resultCount: 1,
          };
        }
        const limit = max_chars ?? 16000;
        return {
          result: textResult(
            tail ? noteToTailSummary(note, limit) : noteToSummary(note, limit),
          ),
          resultCount: 1,
        };
      }),
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Write durable knowledge. scope=project requires git-repo slug and writes under projects/<slug>/. If global vs project is unclear, ASK the user before calling this. Do not store secrets.",
      inputSchema: {
        title: z.string().min(1).describe("Note title"),
        content: z.string().min(1).describe("Markdown body to store"),
        scope: z
          .enum(["global", "project"])
          .optional()
          .describe("global or project (git repo). Ask user if unsure."),
        folder: z
          .enum(["inbox", "projects", "patterns", "stack", "media", "agents"])
          .optional()
          .describe("Global folder (ignored when scope=project)"),
        project: z
          .string()
          .optional()
          .describe("Git repo slug (required for scope=project)"),
        projectFile: z
          .enum(["README", "decisions", "tools", "gotchas"])
          .optional()
          .describe("Which project pack file to append (default decisions)"),
        tags: z.array(z.string()).optional().describe("Optional tags"),
        filename: z
          .string()
          .optional()
          .describe("Optional filename stem for global notes"),
      },
    },
    async (args) =>
      runGuarded("remember", args, async ({ vault, policy }) => {
        if (policy) {
          const targetScope = args.scope ?? (args.project ? "project" : "global");
          const targetProject =
            targetScope === "project" && args.project
              ? await resolveProjectSlug(vault, args.project)
              : null;
          assertScopeAccess(policy, "remember", "write", targetScope, targetProject);
        }
        const note = await rememberNote(vault, args);
        return {
          result: textResult(`Wrote ${note.path}\n\n${noteToSummary(note, 800)}`),
          resultCount: 1,
        };
      }),
  );

  server.registerTool(
    "get_project_context",
    {
      title: "Get project context",
      description:
        "Ensure projects/<slug>/ pack exists (git repo) and return its notes. Slug = git root folder name unless indexed.",
      inputSchema: {
        project: z
          .string()
          .min(1)
          .describe("Git repo slug (usually folder name)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max notes (default 20)"),
      },
    },
    async (args) =>
      runGuarded("get_project_context", args, async ({ vault, policy }) => {
        const { project, limit } = args;
        const canonical = await resolveProjectSlug(vault, project);
        if (policy) {
          assertScopeAccess(policy, "get_project_context", "read", "project", canonical);
        }
        const allowCreate = policy ? canWriteTarget(policy, "project", canonical) : true;
        const { notes, ensured } = await getProjectContext(vault, canonical, limit ?? 20, {
          createIfMissing: allowCreate,
        });
        const packNotes = notes.filter((n) => !/^projects\/[^/]+\/memories\.md$/.test(n.path));
        const activeMemories = await listMemories(vault, {
          scope: "project",
          project: canonical,
          status: "active",
          limit: 20,
        });
        const ensuredLine = ensured.length
          ? `Created: ${ensured.join(", ")}\n`
          : "";
        if (!packNotes.length && !activeMemories.length) {
          return {
            result: textResult(`${ensuredLine}No project notes yet for: ${project}`),
            resultCount: 0,
          };
        }
        const parts = packNotes.map((n) => `---\n${noteToTailSummary(n, 2400)}`);
        if (activeMemories.length) {
          const memBlock = activeMemories
            .map(
              (m) =>
                `- [${m.id}] **${m.title}** (${m.category}, ${m.updated}): ${m.content.replace(/\s+/g, " ").slice(0, 240)}`,
            )
            .join("\n");
          parts.push(`---\n## Active Atomic Memories (${activeMemories.length})\n\n${memBlock}`);
        }
        const body = parts.join("\n\n");
        return {
          result: textResult(
            `Vault: ${vault}\nProject (git repo): ${project}\n${ensuredLine}Notes: ${packNotes.length}, Active memories: ${activeMemories.length}\n\n${body}`,
          ),
          resultCount: packNotes.length + activeMemories.length,
        };
      }),
  );

  // --- Atomic memory tools (Markdown-backed) ---

  server.registerTool(
    "add_memory",
    {
      title: "Add atomic memory",
      description:
        "Store an atomic, ID-tracked memory in Markdown (memories/<category>.md or projects/<slug>/memories.md) with write-time secret scanning and automatic deduplication. Pass supersede_id to replace an outdated memory while preserving temporal lineage (inherits scope/project from the old memory; dedupe is skipped when supersede_id is set).",
      inputSchema: {
        title: z.string().trim().min(1).describe("Concise single-line memory title"),
        content: z.string().trim().min(1).describe("Factual memory body (no secrets)"),
        scope: z
          .enum(["global", "project"])
          .optional()
          .describe("global or project (defaults to project when project is set)"),
        project: z
          .string()
          .optional()
          .describe("Git repo slug, path, or remote URL (resolved via _meta/projects-index.md)"),
        category: z
          .enum(MEMORY_CATEGORIES)
          .optional()
          .describe("profile | preferences | decisions | facts | gotchas"),
        app: z
          .string()
          .optional()
          .describe("Source harness/client name (e.g. cursor, claude, codex, zed)"),
        tags: z.array(z.string()).optional().describe("Optional tags"),
        supersede_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Existing active memory ID to atomically supersede (inherits scope/project)"),
        dedupe: z
          .enum(["dedupe", "force"])
          .optional()
          .describe("dedupe (default: skip near-exact dupes & flag conflicts) | force"),
      },
    },
    async (args) =>
      runGuarded("add_memory", args, async ({ vault, policy }) => {
        if (policy) {
          if (args.supersede_id) {
            const existing = await findMemoryById(vault, args.supersede_id);
            if (existing) {
              assertScopeAccess(
                policy,
                "add_memory",
                "write",
                existing.block.memory.scope,
                existing.block.memory.project,
              );
            }
          } else {
            const targetScope = args.scope ?? (args.project ? "project" : "global");
            const targetProject =
              targetScope === "project" && args.project
                ? await resolveProjectSlug(vault, args.project)
                : null;
            assertScopeAccess(policy, "add_memory", "write", targetScope, targetProject);
          }
        }
        const res = await addMemorySmart(vault, {
          title: args.title,
          content: args.content,
          scope: args.scope,
          project: args.project,
          category: args.category as MemoryCategory | undefined,
          app: resolveMemoryApp(args.app),
          tags: args.tags,
          supersedeId: args.supersede_id,
          dedupe: args.dedupe,
          dbPath: options.indexDbPath,
          embedder: options.embedder,
        });
        return {
          result: textResult(JSON.stringify(res, null, 2)),
          resultCount: 1,
        };
      }),
  );

  server.registerTool(
    "search_memory",
    {
      title: "Search atomic memories",
      description:
        "Hybrid semantic + lexical search over atomic memories. Defaults to status=active so superseded memories never pollute recall.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Search query"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
        mode: z.enum(["hybrid", "fts", "vector"]).optional().describe("Retrieval mode (default hybrid)"),
        scope: z.enum(["global", "project"]).optional(),
        project: z.string().optional().describe("Filter by git repo slug/path/remote"),
        category: z.enum(MEMORY_CATEGORIES).optional(),
        app: z.string().optional().describe("Filter by source harness"),
        tags: z.array(z.string()).optional(),
        status: z
          .enum(["active", "superseded", "all"])
          .optional()
          .describe("active (default) | superseded | all"),
      },
    },
    async (args) =>
      runGuarded("search_memory", args, async ({ vault, policy }) => {
        const canonicalProject = args.project
          ? await resolveProjectSlug(vault, args.project)
          : undefined;
        if (policy) {
          if (canonicalProject) {
            assertScopeAccess(policy, "search_memory", "read", "project", canonicalProject);
          } else if (args.scope && !policy.readScopes.includes(args.scope)) {
            throw new AclDeniedError(
              policy.app,
              "search_memory",
              `read access to ${args.scope} scope is not permitted`,
            );
          }
        }

        const effectiveScope =
          args.scope ??
          (policy && policy.readScopes.length === 1 ? policy.readScopes[0] : undefined);
        const effectiveProject =
          canonicalProject ??
          (policy &&
          !policy.readScopes.includes("global") &&
          policy.allowedProjects.length === 1
            ? policy.allowedProjects[0]
            : undefined);

        const requestedLimit = args.limit ?? 10;
        const fetchLimit = hasReadRestriction(policy)
          ? Math.min(200, requestedLimit * 4)
          : requestedLimit;

        const res = await searchMemories(vault, args.query, {
          limit: fetchLimit,
          mode: args.mode as SearchMode | undefined,
          scope: effectiveScope,
          project: effectiveProject,
          category: args.category as MemoryCategory | undefined,
          app: args.app,
          tags: args.tags,
          status: args.status ?? "active",
          dbPath: options.indexDbPath,
          embedder: options.embedder,
        });

        const hits = policy
          ? res.hits
              .filter((h) => canReadTarget(policy, h.memory.scope, h.memory.project))
              .slice(0, requestedLimit)
          : res.hits.slice(0, requestedLimit);

        if (!hits.length) {
          return {
            result: textResult(`No memories matched: ${args.query} (mode=${res.modeUsed})`),
            resultCount: 0,
          };
        }
        const body = hits
          .map((h, i) => {
            const m = h.memory;
            const meta = [
              `id=${m.id}`,
              `status=${m.status}`,
              `cat=${m.category}`,
              m.project ? `project=${m.project}` : `scope=${m.scope}`,
              `app=${m.app}`,
              `updated=${m.updated}`,
              `via=${h.matchedBy.join("+")}`,
              h.vectorScore !== null ? `sim=${h.vectorScore}` : null,
            ]
              .filter(Boolean)
              .join(", ");
            return `${i + 1}. [${m.id}] ${m.title} (${m.path}) [${meta}]\n   ${m.content}`;
          })
          .join("\n\n");
        return {
          result: textResult(`Memories (mode=${res.modeUsed}, ${res.searchMs}ms)\n\n${body}`),
          resultCount: hits.length,
        };
      }),
  );

  server.registerTool(
    "list_memories",
    {
      title: "List atomic memories",
      description:
        "Enumerate structured atomic memories with optional filters (defaults to status=active).",
      inputSchema: {
        scope: z.enum(["global", "project"]).optional(),
        project: z.string().optional(),
        category: z.enum(MEMORY_CATEGORIES).optional(),
        app: z.string().optional(),
        tags: z.array(z.string()).optional(),
        status: z.enum(["active", "superseded", "all"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      runGuarded("list_memories", args, async ({ vault, policy }) => {
        const canonicalProject = args.project
          ? await resolveProjectSlug(vault, args.project)
          : undefined;
        if (policy) {
          if (canonicalProject) {
            assertScopeAccess(policy, "list_memories", "read", "project", canonicalProject);
          } else if (args.scope && !policy.readScopes.includes(args.scope)) {
            throw new AclDeniedError(
              policy.app,
              "list_memories",
              `read access to ${args.scope} scope is not permitted`,
            );
          }
        }

        const requestedLimit = args.limit ?? 30;
        const all = await listMemories(vault, {
          scope: args.scope,
          project: canonicalProject,
          category: args.category as MemoryCategory | undefined,
          app: args.app,
          tags: args.tags,
          status: args.status ?? "active",
          limit: hasReadRestriction(policy) ? undefined : requestedLimit,
        });
        const items = policy
          ? all
              .filter((m) => canReadTarget(policy, m.scope, m.project))
              .slice(0, requestedLimit)
          : all;
        return {
          result: textResult(JSON.stringify({ count: items.length, memories: items }, null, 2)),
          resultCount: items.length,
        };
      }),
  );

  server.registerTool(
    "update_memory",
    {
      title: "Update atomic memory",
      description:
        "Surgically update an existing atomic memory by ID (preserves ID & created date, bumps updated, runs secret guard).",
      inputSchema: {
        id: z.string().trim().min(1).describe("Memory ID (e.g. m_a1b2c3d4)"),
        title: z.string().trim().min(1).optional(),
        content: z.string().trim().min(1).optional(),
        tags: z.array(z.string()).optional(),
        category: z.enum(MEMORY_CATEGORIES).optional(),
        app: z.string().optional(),
      },
    },
    async (args) =>
      runGuarded("update_memory", args, async ({ vault, policy }) => {
        if (policy) {
          const existing = await findMemoryById(vault, args.id);
          if (existing) {
            assertScopeAccess(
              policy,
              "update_memory",
              "write",
              existing.block.memory.scope,
              existing.block.memory.project,
            );
          }
        }
        const updated = await updateMemory(vault, {
          id: args.id,
          title: args.title,
          content: args.content,
          tags: args.tags,
          category: args.category as MemoryCategory | undefined,
          app: lockAppProvenance && configuredApp !== "anonymous" ? configuredApp : args.app,
        });
        await syncVaultIndex(vault, {
          dbPath: options.indexDbPath,
          embedder: options.embedder,
        }).catch(() => {});
        return {
          result: textResult(JSON.stringify(updated, null, 2)),
          resultCount: 1,
        };
      }),
  );

  server.registerTool(
    "supersede_memory",
    {
      title: "Supersede atomic memory",
      description:
        "Replace an outdated memory ID with a new active memory, keeping the old memory in Markdown marked status=superseded with temporal lineage.",
      inputSchema: {
        old_id: z.string().trim().min(1).describe("Existing active memory ID to mark superseded"),
        content: z.string().trim().min(1).describe("Updated memory content"),
        title: z.string().trim().min(1).optional().describe("Optional new title (defaults to previous title)"),
        tags: z.array(z.string()).optional(),
        category: z.enum(MEMORY_CATEGORIES).optional(),
        app: z.string().optional(),
      },
    },
    async (args) =>
      runGuarded("supersede_memory", args, async ({ vault, policy }) => {
        if (policy) {
          const existing = await findMemoryById(vault, args.old_id);
          if (existing) {
            assertScopeAccess(
              policy,
              "supersede_memory",
              "write",
              existing.block.memory.scope,
              existing.block.memory.project,
            );
          }
        }
        const res = await supersedeMemory(vault, args.old_id, {
          title: args.title,
          content: args.content,
          tags: args.tags,
          category: args.category as MemoryCategory | undefined,
          app: resolveMemoryApp(args.app),
        });
        await syncVaultIndex(vault, {
          dbPath: options.indexDbPath,
          embedder: options.embedder,
        }).catch(() => {});
        return {
          result: textResult(JSON.stringify(res, null, 2)),
          resultCount: 1,
        };
      }),
  );

  server.registerTool(
    "delete_memory",
    {
      title: "Delete atomic memory",
      description:
        "Permanently remove an atomic memory block by ID from its Markdown file.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Memory ID to delete"),
      },
    },
    async (args) =>
      runGuarded("delete_memory", args, async ({ vault, policy }) => {
        if (policy) {
          const existing = await findMemoryById(vault, args.id);
          if (existing) {
            assertScopeAccess(
              policy,
              "delete_memory",
              "write",
              existing.block.memory.scope,
              existing.block.memory.project,
            );
          }
        }
        const res = await deleteMemory(vault, args.id);
        await syncVaultIndex(vault, {
          dbPath: options.indexDbPath,
          embedder: options.embedder,
        }).catch(() => {});
        return {
          result: textResult(JSON.stringify(res, null, 2)),
          resultCount: 1,
        };
      }),
  );

  server.registerTool(
    "list_recent",
    {
      title: "List recent",
      description:
        "Return the newest entries from stack/recent.md (recently used/learned tools and skills).",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max entries (default 20)"),
      },
    },
    async (args) =>
      runGuarded("list_recent", args, async ({ vault, policy }) => {
        if (policy) {
          assertScopeAccess(policy, "list_recent", "read", "global");
        }
        const entries = await listRecent(vault, args.limit ?? 20);
        if (!entries.length) {
          return { result: textResult("Recent log is empty."), resultCount: 0 };
        }
        return {
          result: textResult(`Recent (newest first):\n\n${entries.join("\n")}`),
          resultCount: entries.length,
        };
      }),
  );

  server.registerTool(
    "track_tool",
    {
      title: "Track tool",
      description:
        "Upsert stack/catalog/<slug>.md for a tool/SaaS and prepend stack/recent.md. Optionally also note it on projects/<slug>/tools.md.",
      inputSchema: {
        name: z.string().min(1).describe("Tool or SaaS name"),
        summary: z
          .string()
          .min(1)
          .describe("Short what/why or what you learned"),
        slug: z.string().optional().describe("Catalog filename slug"),
        project: z
          .string()
          .optional()
          .describe("If used in a git repo, its slug — also updates tools.md"),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) =>
      runGuarded("track_tool", args, async ({ vault, policy }) => {
        if (policy) {
          assertScopeAccess(policy, "track_tool", "write", "global");
          if (args.project) {
            const slug = await resolveProjectSlug(vault, args.project);
            assertScopeAccess(policy, "track_tool", "write", "project", slug);
          }
        }
        const { catalog, recent } = await trackTool(vault, args);
        return {
          result: textResult(
            `Catalog: ${catalog.path}\n\n${noteToSummary(catalog, 600)}\n\nRecent head:\n${recent.slice(0, 5).join("\n")}`,
          ),
          resultCount: 1,
        };
      }),
  );

  server.registerTool(
    "resolve_guidance",
    {
      title: "Resolve guidance",
      description:
        "Look up standing instructions, soft suggestions, or workflows before inventing process. Pass kind (coding|pr-review|commit|git|…) and/or workflow_id and/or intent. Optional type filter. Optional project git slug. Project overrides global.",
      inputSchema: {
        intent: z
          .string()
          .optional()
          .describe("Free-text task (e.g. write a commit message)"),
        kind: z
          .string()
          .optional()
          .describe(
            "Kind for instruction/suggestion: coding, pr-review, commit, git, …",
          ),
        workflow_id: z
          .string()
          .optional()
          .describe("Workflow id under workflows/"),
        type: z
          .enum(["instruction", "suggestion", "workflow"])
          .optional()
          .describe(
            "Optional filter. If omitted with kind, loads instruction + suggestion.",
          ),
        project: z
          .string()
          .optional()
          .describe("Git repo slug for project overrides"),
      },
    },
    async (args) =>
      runGuarded("resolve_guidance", args, async ({ vault, policy }) => {
        const canonicalProject = args.project
          ? await resolveProjectSlug(vault, args.project)
          : undefined;
        if (policy && canonicalProject) {
          assertScopeAccess(policy, "resolve_guidance", "read", "project", canonicalProject);
        }
        const result = await resolveGuidance(vault, {
          ...args,
          project: canonicalProject,
        });
        const hits = policy
          ? result.hits.filter((h) => {
              const inf = inferNoteScopeAndProject(h.path);
              return canReadTarget(policy, inf.scope, inf.project);
            })
          : result.hits;
        if (!hits.length) {
          return {
            result: textResult(`${result.mode}: ${result.message}`),
            resultCount: 0,
          };
        }
        const body = hits
          .map(
            (h) =>
              `### ${h.scope} ${h.type} (${h.kindOrId})\npath: ${h.path}\n\n${noteToSummary(h.note, 2500)}`,
          )
          .join("\n\n---\n\n");
        return {
          result: textResult(`mode: ${result.mode}\n${result.message}\n\n${body}`),
          resultCount: hits.length,
        };
      }),
  );

  server.registerTool(
    "list_guidance",
    {
      title: "List guidance",
      description:
        "List instruction kinds, suggestion kinds, and workflow ids in the vault (global + optional project).",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("If set, include that project's overrides"),
      },
    },
    async (args) =>
      runGuarded("list_guidance", args, async ({ vault, policy }) => {
        const canonicalProject = args.project
          ? await resolveProjectSlug(vault, args.project)
          : undefined;
        if (policy && canonicalProject) {
          assertScopeAccess(policy, "list_guidance", "read", "project", canonicalProject);
        }
        const listed = await listGuidance(vault, canonicalProject);
        if (policy && !canReadTarget(policy, "global")) {
          const filtered = { ...listed, global: { instructions: [], suggestions: [], workflows: [] } };
          return {
            result: textResult(JSON.stringify(filtered, null, 2)),
            resultCount: 1,
          };
        }
        return {
          result: textResult(JSON.stringify(listed, null, 2)),
          resultCount: 1,
        };
      }),
  );

  server.registerTool(
    "upsert_guidance",
    {
      title: "Upsert guidance",
      description:
        "Create or surgically update an instruction, soft suggestion, or workflow note. Prefer mode=append (default), replace_section, or remove_section so other sections stay intact. mode=replace rewrites the entire note. Soft prefs → type=suggestion. Binding process → type=instruction only for hard rules.",
      inputSchema: {
        type: z.enum(["instruction", "suggestion", "workflow"]),
        content: z
          .string()
          .optional()
          .describe("Required except mode=remove_section"),
        title: z.string().optional(),
        kind: z
          .string()
          .optional()
          .describe("Required for instruction/suggestion (e.g. coding, commit)"),
        workflow_id: z.string().optional().describe("Required for workflow"),
        scope: z.enum(["global", "project"]),
        project: z
          .string()
          .optional()
          .describe("Git repo slug when scope=project"),
        tags: z.array(z.string()).optional(),
        mode: z
          .enum(["append", "replace", "replace_section", "remove_section"])
          .optional()
          .describe(
            "append (default); replace_section / remove_section (need section=); replace (full note rewrite)",
          ),
        section: z
          .string()
          .optional()
          .describe(
            "Heading text to target for replace_section / remove_section (e.g. \"Update 2026-07-29\")",
          ),
      },
    },
    async (args) =>
      runGuarded("upsert_guidance", args, async ({ vault, policy }) => {
        if (policy) {
          const slug =
            args.scope === "project" && args.project
              ? await resolveProjectSlug(vault, args.project)
              : null;
          assertScopeAccess(policy, "upsert_guidance", "write", args.scope, slug);
        }
        const note = await upsertGuidance(vault, args);
        const how =
          args.mode === "replace"
            ? "Replaced (full note)"
            : args.mode === "replace_section"
              ? "Replaced section"
              : args.mode === "remove_section"
                ? "Removed section"
                : "Wrote";
        return {
          result: textResult(`${how} ${note.path}\n\n${noteToSummary(note, 800)}`),
          resultCount: 1,
        };
      }),
  );

  server.registerTool(
    "resolve_action",
    {
      title: "Resolve action",
      description:
        "PRIMARY entry for coding / PR review / commit / git process. Reads vault actions/registry.md, expands linked instructions/workflows (project over global). Prefer this over inventing process. Extend by editing the vault registry—no code change.",
      inputSchema: {
        action: z
          .string()
          .optional()
          .describe("Action id: coding | pr-review | commit | git | custom"),
        intent: z
          .string()
          .optional()
          .describe("Free text if action id unknown"),
        project: z.string().optional().describe("Git repo slug"),
        pointers_only: z
          .boolean()
          .optional()
          .describe("If true, return paths only (default false = expand markdown)"),
      },
    },
    async (args) =>
      runGuarded("resolve_action", args, async ({ vault, policy }) => {
        const canonicalProject = args.project
          ? await resolveProjectSlug(vault, args.project)
          : undefined;
        if (policy) {
          if (canonicalProject) {
            assertScopeAccess(policy, "resolve_action", "read", "project", canonicalProject);
          } else {
            assertScopeAccess(policy, "resolve_action", "read", "global");
          }
        }
        const result = await resolveAction(vault, {
          ...args,
          project: canonicalProject,
        });
        if (!result.actionId) {
          return { result: textResult(result.message), resultCount: 0 };
        }
        const allowedPointers = policy
          ? result.pointers.filter((p) => {
              const inf = inferNoteScopeAndProject(p.path);
              return canReadTarget(policy, inf.scope, inf.project);
            })
          : result.pointers;
        const header = [
          `action: ${result.actionId}`,
          result.description ? `description: ${result.description}` : null,
          `sources: ${result.sources.join(", ")}`,
          `refs.instructions: ${result.refs.instructions.join(", ") || "(none)"}`,
          `refs.workflows: ${result.refs.workflows.join(", ") || "(none)"}`,
          result.message,
        ]
          .filter(Boolean)
          .join("\n");

        if (args.pointers_only || (policy && !canReadTarget(policy, "global"))) {
          return {
            result: textResult(
              `${header}\n\npointers:\n${JSON.stringify(allowedPointers, null, 2)}`,
            ),
            resultCount: allowedPointers.length,
          };
        }
        return {
          result: textResult(`${header}\n\n${result.bundle || "(no note bodies)"}`),
          resultCount: allowedPointers.length,
        };
      }),
  );

  server.registerTool(
    "list_actions",
    {
      title: "List actions",
      description:
        "List action ids from vault actions/registry.md (plus project overlay if provided).",
      inputSchema: {
        project: z.string().optional().describe("Git repo slug for overlay"),
      },
    },
    async (args) =>
      runGuarded("list_actions", args, async ({ vault, policy }) => {
        const canonicalProject = args.project
          ? await resolveProjectSlug(vault, args.project)
          : undefined;
        if (policy) {
          if (canonicalProject) {
            assertScopeAccess(policy, "list_actions", "read", "project", canonicalProject);
          } else {
            assertScopeAccess(policy, "list_actions", "read", "global");
          }
        }
        const listed = await listActions(vault, canonicalProject);
        return {
          result: textResult(JSON.stringify(listed, null, 2)),
          resultCount: Object.keys(listed.actions).length,
        };
      }),
  );

  server.registerTool(
    "jira_assigned",
    {
      title: "Jira assigned issues",
      description:
        "Fetch (or return cached) Jira issues. Default scope=sprint: assignee = me, not Done, in openSprints(). Use scope=all only when the user wants every assigned open issue (ask first — do not default to all). Cache TTL 1h; refresh=true busts cache. Optional jql overrides. Does not modify work/today.md.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("Bust cache and hit Jira (default false)"),
        jql: z
          .string()
          .optional()
          .describe("Override JQL (always hits network)"),
        scope: z
          .enum(["sprint", "all"])
          .optional()
          .describe(
            "sprint (default)=open sprints only; all=every assigned not-Done issue",
          ),
      },
    },
    async (args) =>
      runGuarded("jira_assigned", args, async ({ policy }) => {
        if (policy) assertScopeAccess(policy, "jira_assigned", "read", "global");
        const result = await toolJiraAssigned(args);
        return {
          result: textResult(JSON.stringify(result, null, 2)),
          resultCount: Array.isArray(result.issues) ? result.issues.length : null,
        };
      }),
  );

  server.registerTool(
    "work_today",
    {
      title: "Today work list",
      description:
        "Vault-only today list at work/today.md. op=list (rollover if needed), add (promote to today), complete (tick off after user yes). Never calls Jira. Prefer this over raw Read/Write of today.md.",
      inputSchema: {
        op: z.enum(["list", "add", "complete"]).describe("Operation"),
        key: z
          .string()
          .optional()
          .describe("Issue key e.g. AD-206 or jira:AD-206"),
        text: z
          .string()
          .optional()
          .describe("Free-text item or match string for complete"),
        note: z.string().optional().describe("Note when adding"),
        log: z
          .string()
          .optional()
          .describe("Optional day-log line when completing"),
      },
    },
    async (args) =>
      runGuarded("work_today", args, async ({ policy }) => {
        if (policy) {
          const op = classifyToolOperation("work_today", args);
          assertScopeAccess(policy, "work_today", op, "global");
        }
        const result = await toolWorkToday(args);
        const openItems = (result as { open?: unknown[] }).open;
        return {
          result: textResult(JSON.stringify(result, null, 2)),
          resultCount: Array.isArray(openItems) ? openItems.length : 1,
        };
      }),
  );

  server.registerTool(
    "work_plate",
    {
      title: "Work plate compare",
      description:
        "Compare Jira snapshot vs work/today.md. Default scope=sprint (open sprints only). Use scope=all only after asking the user if they want every assigned issue. Returns on_today / jira_only / today_only + counts. Never auto-adds. refresh=true busts cache.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("Force Jira fetch even if cache is warm"),
        scope: z
          .enum(["sprint", "all"])
          .optional()
          .describe(
            "sprint (default)=open sprints; all=all assigned not-Done (ask user first)",
          ),
      },
    },
    async (args) =>
      runGuarded("work_plate", args, async ({ policy }) => {
        if (policy) assertScopeAccess(policy, "work_plate", "read", "global");
        try {
          const result = await toolWorkPlate(args);
          return {
            result: textResult(JSON.stringify(result, null, 2)),
            resultCount: 1,
          };
        } catch (err) {
          if (err instanceof JiraNotConfiguredError) {
            return { result: errorResult(err), resultCount: 0 };
          }
          throw err;
        }
      }),
  );

  server.registerTool(
    "work_log",
    {
      title: "Day work log",
      description:
        "Daily time ledger at work/log/YYYY-MM-DD.md. op=event appends a timestamped event (key only if the user supplied one — never infer). op=review derives 15m activity buckets, harvests today's git commits, and fetches the user's existing Jira worklogs for the day to flag overlaps. op=push posts native Jira worklogs for an explicit entries array only; default is delta (requested minus already-logged); force=true is the only override. Nothing is posted without the user reviewing first.",
      inputSchema: {
        op: z.enum(["event", "review", "push"]).describe("Operation"),
        kind: z
          .enum([
            "session-start",
            "session-end",
            "note",
            "commit",
            "done",
            "focus",
          ])
          .optional()
          .describe("Event kind (event op, default note)"),
        session: z.string().optional().describe("Session/conversation id"),
        key: z
          .string()
          .optional()
          .describe("User-supplied issue key only — never inferred"),
        text: z.string().optional().describe("Event text / note"),
        date: z.string().optional().describe("YYYY-MM-DD (default today)"),
        cwd: z
          .string()
          .optional()
          .describe("Repo path for git harvest (review)"),
        entries: z
          .array(
            z.object({
              key: z.string(),
              minutes: z.number(),
              comment: z.string().optional(),
              force: z
                .boolean()
                .optional()
                .describe("Post even if Jira already has time today"),
            }),
          )
          .optional()
          .describe("Explicit push list — required for op=push"),
        create: z
          .array(
            z.object({
              summary: z.string(),
              project: z.string().optional(),
              issueType: z.string().optional(),
            }),
          )
          .optional()
          .describe("Issues to create before push (user-confirmed)"),
      },
    },
    async (args) =>
      runGuarded("work_log", args, async ({ policy }) => {
        if (policy) {
          const op = classifyToolOperation("work_log", args);
          assertScopeAccess(policy, "work_log", op, "global");
        }
        const result = await toolWorkLog(args);
        return {
          result: textResult(JSON.stringify(result, null, 2)),
          resultCount: 1,
        };
      }),
  );

  server.registerTool(
    "jira_release",
    {
      title: "Jira sprint release",
      description:
        "User-initiated sprint releases. op=sprints lists sprints for a project. op=preview lists a sprint's issues with status — no selection, no filtering. op=create requires an explicit version name and explicit issue keys (never derived, never chosen by the agent), creates the version unreleased, then stamps fixVersion per issue. op=release marks a version released. Needs Manage Versions / Administer Projects. Never auto-fires.",
      inputSchema: {
        op: z
          .enum(["sprints", "preview", "create", "release"])
          .describe("Operation"),
        project: z
          .string()
          .optional()
          .describe("Project key (or [jira] default_project)"),
        sprintId: z.number().int().optional().describe("Sprint id (preview)"),
        name: z
          .string()
          .optional()
          .describe("Version name — required for create, user-supplied"),
        keys: z
          .array(z.string())
          .optional()
          .describe("Issue keys to stamp — required for create, user-chosen"),
        versionId: z.string().optional().describe("Version id (release)"),
        releaseDate: z
          .string()
          .optional()
          .describe("YYYY-MM-DD (release, default today)"),
        description: z.string().optional().describe("Version description"),
      },
    },
    async (args) =>
      runGuarded("jira_release", args, async ({ policy }) => {
        if (policy) {
          const op = classifyToolOperation("jira_release", args);
          assertScopeAccess(policy, "jira_release", op, "global");
        }
        const result = await toolJiraRelease(args);
        return {
          result: textResult(JSON.stringify(result, null, 2)),
          resultCount: 1,
        };
      }),
  );

  return server;
}

async function main(): Promise<void> {
  await loadEnvFile(join(configDir(), ".env"));
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path);
  const info = await vaultInfo(vault);
  if (!info.readable) {
    console.error(
      `[ai-mcp-brain] WARNING: vault not readable at ${vault}` +
        (info.error ? ` (${info.error})` : ""),
    );
    console.error(
      "[ai-mcp-brain] Set BRAIN_VAULT or vault_path in config.toml; ensure Cursor has disk access to iCloud/Obsidian.",
    );
  } else {
    console.error(
      `[ai-mcp-brain] MCP server ready (vault: ${vault}, notes: ${info.noteCount})`,
    );
  }
  const server = createBrainServer({ vaultPath: vault });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Non-blocking background index warm-up so the first search_notes call is fast
  if (info.readable && process.env.BRAIN_MCP_WARMUP !== "0") {
    void syncVaultIndex(vault)
      .then((stats) => {
        console.error(
          `[ai-mcp-brain] index ready (${stats.chunksIndexed} chunks, ${stats.durationMs}ms, model=${stats.embedModel ?? "fts-only"})`,
        );
      })
      .catch((err) => {
        console.error(
          `[ai-mcp-brain] background index warm-up skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("[ai-mcp-brain] fatal:", err);
    process.exit(1);
  });
}
