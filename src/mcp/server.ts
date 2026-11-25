#!/usr/bin/env node
/**
 * Second-brain MCP server (stdio).
 * Logs go to stderr only — stdout is reserved for MCP JSON-RPC.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listActions, resolveAction } from "../actions.ts";
import { configDir, loadConfig, resolveVaultPath } from "../config.ts";
import { loadEnvFile } from "../env.ts";
import { JiraNotConfiguredError } from "../jira/client.ts";
import { join } from "node:path";
import {
  searchHybrid,
  syncVaultIndex,
  type HybridSearchOptions,
  type SearchMode,
} from "../index/index.ts";
import {
  addMemorySmart,
  deleteMemory,
  listMemories,
  MEMORY_CATEGORIES,
  searchMemories,
  supersedeMemory,
  updateMemory,
  type MemoryCategory,
} from "../memory/index.ts";
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

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

async function resolveVault(): Promise<string> {
  const config = await loadConfig();
  return resolveVaultPath(config.vault_path);
}

export function createBrainServer(): McpServer {
  const server = new McpServer({
    name: "ai-mcp-brain",
    version: "0.2.0",
  });

  server.registerTool(
    "vault_info",
    {
      title: "Vault info",
      description:
        "Diagnostics: resolved vault path, whether it is readable, and note count. Use when vault access seems broken.",
    },
    async () => {
      try {
        const vault = await resolveVault();
        const info = await vaultInfo(vault);
        return textResult(JSON.stringify(info, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ query, limit, mode, project, scope, type, tags, updated_after }) => {
      try {
        const vault = await resolveVault();
        const opts: HybridSearchOptions = {
          limit: limit ?? 10,
          mode: mode as SearchMode | undefined,
          project,
          scope,
          type,
          tags,
          updatedAfter: updated_after,
        };
        try {
          const result = await searchHybrid(vault, query, opts);
          if (!result.hits.length) {
            return textResult(`No notes matched: ${query} (mode=${result.modeUsed})`);
          }
          const body = result.hits
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
          return textResult(
            `Vault: ${vault} (mode=${result.modeUsed}, ${result.searchMs}ms)${warn}\n\n${body}`,
          );
        } catch (indexErr) {
          console.error(
            `[ai-mcp-brain] hybrid index failed, falling back to legacy search: ${
              indexErr instanceof Error ? indexErr.message : String(indexErr)
            }`,
          );
          const hits = await searchNotes(vault, query, limit ?? 10);
          if (!hits.length) {
            return textResult(`No notes matched: ${query}`);
          }
          const body = hits
            .map(
              (h, i) =>
                `${i + 1}. ${h.path} (${h.title}) [score=${h.score}]\n   ${h.snippet}`,
            )
            .join("\n\n");
          return textResult(`Vault: ${vault} (legacy fallback)\n\n${body}`);
        }
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ path, section, tail, max_chars }) => {
      try {
        const vault = await resolveVault();
        const note = await readNote(vault, path);
        if (section?.trim()) {
          const span = findMarkdownSection(note.body, section);
          const slice = note.body.slice(span.start, span.end).trim();
          return textResult(
            `path: ${note.path}\ntitle: ${note.title}\nsection: ${span.heading}\n\n${slice}`,
          );
        }
        const limit = max_chars ?? 16000;
        return textResult(
          tail ? noteToTailSummary(note, limit) : noteToSummary(note, limit),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const vault = await resolveVault();
        const note = await rememberNote(vault, args);
        return textResult(`Wrote ${note.path}\n\n${noteToSummary(note, 800)}`);
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ project, limit }) => {
      try {
        const vault = await resolveVault();
        const { notes, ensured } = await getProjectContext(
          vault,
          project,
          limit ?? 20,
        );
        const packNotes = notes.filter((n) => !/^projects\/[^/]+\/memories\.md$/.test(n.path));
        const activeMemories = await listMemories(vault, {
          scope: "project",
          project,
          status: "active",
          limit: 20,
        });
        const ensuredLine = ensured.length
          ? `Created: ${ensured.join(", ")}\n`
          : "";
        if (!packNotes.length && !activeMemories.length) {
          return textResult(
            `${ensuredLine}No project notes yet for: ${project}`,
          );
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
        return textResult(
          `Vault: ${vault}\nProject (git repo): ${project}\n${ensuredLine}Notes: ${packNotes.length}, Active memories: ${activeMemories.length}\n\n${body}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const vault = await resolveVault();
        const res = await addMemorySmart(vault, {
          title: args.title,
          content: args.content,
          scope: args.scope,
          project: args.project,
          category: args.category as MemoryCategory | undefined,
          app: args.app,
          tags: args.tags,
          supersedeId: args.supersede_id,
          dedupe: args.dedupe,
        });
        return textResult(JSON.stringify(res, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const vault = await resolveVault();
        const res = await searchMemories(vault, args.query, {
          limit: args.limit ?? 10,
          mode: args.mode as SearchMode | undefined,
          scope: args.scope,
          project: args.project,
          category: args.category as MemoryCategory | undefined,
          app: args.app,
          tags: args.tags,
          status: args.status ?? "active",
        });
        if (!res.hits.length) {
          return textResult(`No memories matched: ${args.query} (mode=${res.modeUsed})`);
        }
        const body = res.hits
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
        return textResult(
          `Memories (mode=${res.modeUsed}, ${res.searchMs}ms)\n\n${body}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const vault = await resolveVault();
        const items = await listMemories(vault, {
          scope: args.scope,
          project: args.project,
          category: args.category as MemoryCategory | undefined,
          app: args.app,
          tags: args.tags,
          status: args.status ?? "active",
          limit: args.limit ?? 30,
        });
        return textResult(JSON.stringify({ count: items.length, memories: items }, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const vault = await resolveVault();
        const updated = await updateMemory(vault, {
          id: args.id,
          title: args.title,
          content: args.content,
          tags: args.tags,
          category: args.category as MemoryCategory | undefined,
          app: args.app,
        });
        await syncVaultIndex(vault).catch(() => {});
        return textResult(JSON.stringify(updated, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const vault = await resolveVault();
        const res = await supersedeMemory(vault, args.old_id, {
          title: args.title,
          content: args.content,
          tags: args.tags,
          category: args.category as MemoryCategory | undefined,
          app: args.app,
        });
        await syncVaultIndex(vault).catch(() => {});
        return textResult(JSON.stringify(res, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ id }) => {
      try {
        const vault = await resolveVault();
        const res = await deleteMemory(vault, id);
        await syncVaultIndex(vault).catch(() => {});
        return textResult(JSON.stringify(res, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ limit }) => {
      try {
        const vault = await resolveVault();
        const entries = await listRecent(vault, limit ?? 20);
        if (!entries.length) {
          return textResult("Recent log is empty.");
        }
        return textResult(`Recent (newest first):\n\n${entries.join("\n")}`);
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const vault = await resolveVault();
        const { catalog, recent } = await trackTool(vault, args);
        return textResult(
          `Catalog: ${catalog.path}\n\n${noteToSummary(catalog, 600)}\n\nRecent head:\n${recent.slice(0, 5).join("\n")}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const vault = await resolveVault();
        const result = await resolveGuidance(vault, args);
        if (!result.hits.length) {
          return textResult(`${result.mode}: ${result.message}`);
        }
        const body = result.hits
          .map(
            (h) =>
              `### ${h.scope} ${h.type} (${h.kindOrId})\npath: ${h.path}\n\n${noteToSummary(h.note, 2500)}`,
          )
          .join("\n\n---\n\n");
        return textResult(
          `mode: ${result.mode}\n${result.message}\n\n${body}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ project }) => {
      try {
        const vault = await resolveVault();
        const listed = await listGuidance(vault, project);
        return textResult(JSON.stringify(listed, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const vault = await resolveVault();
        const note = await upsertGuidance(vault, args);
        const how =
          args.mode === "replace"
            ? "Replaced (full note)"
            : args.mode === "replace_section"
              ? "Replaced section"
              : args.mode === "remove_section"
                ? "Removed section"
                : "Wrote";
        return textResult(
          `${how} ${note.path}\n\n${noteToSummary(note, 800)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const vault = await resolveVault();
        const result = await resolveAction(vault, args);
        if (!result.actionId) {
          return textResult(result.message);
        }
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

        if (args.pointers_only) {
          return textResult(
            `${header}\n\npointers:\n${JSON.stringify(result.pointers, null, 2)}`,
          );
        }
        return textResult(
          `${header}\n\n${result.bundle || "(no note bodies)"}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ project }) => {
      try {
        const vault = await resolveVault();
        const listed = await listActions(vault, project);
        return textResult(JSON.stringify(listed, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ refresh, jql, scope }) => {
      try {
        const result = await toolJiraAssigned({ refresh, jql, scope });
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ op, key, text, note, log }) => {
      try {
        const result = await toolWorkToday({ op, key, text, note, log });
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async ({ refresh, scope }) => {
      try {
        const result = await toolWorkPlate({ refresh, scope });
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        if (err instanceof JiraNotConfiguredError) {
          return errorResult(err);
        }
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const result = await toolWorkLog(args);
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
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
    async (args) => {
      try {
        const result = await toolJiraRelease(args);
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  await loadEnvFile(join(configDir(), ".env"));
  const vault = await resolveVault();
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
  const server = createBrainServer();
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

import { isMainModule } from "../runtime.ts";

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("[ai-mcp-brain] fatal:", err);
    process.exit(1);
  });
}
