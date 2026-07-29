#!/usr/bin/env node
/**
 * Second-brain MCP server (stdio).
 * Logs go to stderr only — stdout is reserved for MCP JSON-RPC.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listActions, resolveAction } from "../actions.ts";
import { loadConfig, resolveVaultPath } from "../config.ts";
import {
  getProjectContext,
  listGuidance,
  listRecent,
  noteToSummary,
  readNote,
  rememberNote,
  resolveGuidance,
  searchNotes,
  trackTool,
  upsertGuidance,
  vaultInfo,
} from "../vault.ts";

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
        "Full-text search across the Obsidian second-brain vault. Returns ranked paths, titles, and snippets.",
      inputSchema: {
        query: z.string().min(1).describe("Search query (keywords)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results (default 10)"),
      },
    },
    async ({ query, limit }) => {
      try {
        const vault = await resolveVault();
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
        return textResult(`Vault: ${vault}\n\n${body}`);
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
        "Read a vault note by relative path (e.g. projects/my-repo/decisions.md).",
      inputSchema: {
        path: z.string().min(1).describe("Relative path inside the vault"),
      },
    },
    async ({ path }) => {
      try {
        const vault = await resolveVault();
        const note = await readNote(vault, path);
        return textResult(noteToSummary(note));
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
        const ensuredLine = ensured.length
          ? `Created: ${ensured.join(", ")}\n`
          : "";
        if (!notes.length) {
          return textResult(
            `${ensuredLine}No project notes yet for: ${project}`,
          );
        }
        const body = notes
          .map((n) => `---\n${noteToSummary(n, 1200)}`)
          .join("\n\n");
        return textResult(
          `Vault: ${vault}\nProject (git repo): ${project}\n${ensuredLine}Notes: ${notes.length}\n\n${body}`,
        );
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

  return server;
}

async function main(): Promise<void> {
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
}

import { isMainModule } from "../runtime.ts";

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("[ai-mcp-brain] fatal:", err);
    process.exit(1);
  });
}
