#!/usr/bin/env bun
/**
 * Second-brain MCP server (stdio).
 * Logs go to stderr only — stdout is reserved for MCP JSON-RPC.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, resolveVaultPath } from "../config.ts";
import {
  getProjectContext,
  listRecent,
  noteToSummary,
  readNote,
  rememberNote,
  searchNotes,
  trackTool,
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

  return server;
}

async function main(): Promise<void> {
  const vault = await resolveVault();
  const server = createBrainServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[ai-mcp-brain] MCP server ready (vault: ${vault})`);
}

main().catch((err) => {
  console.error("[ai-mcp-brain] fatal:", err);
  process.exit(1);
});
