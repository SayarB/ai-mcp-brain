#!/usr/bin/env node
import { configDir, loadConfig, resolveVaultPath } from "./config.ts";
import {
  DaemonStateStore,
  startBrainDaemon,
  validateAppName,
  type AccessMode,
  type ScopeFilter,
} from "./daemon/index.ts";
import { loadEnvFile } from "./env.ts";
import { searchHybrid, syncVaultIndex, type SearchMode } from "./index/index.ts";
import { formatInitReport, initVault } from "./init.ts";
import {
  addMemorySmart,
  approvePendingMemory,
  bootstrapContext,
  deleteMemory,
  ingestSessionToPending,
  listMemories,
  MEMORY_CATEGORIES,
  runDreamConsolidation,
  searchMemories,
  supersedeMemory,
  updateMemory,
  type MemoryCategory,
} from "./memory/index.ts";
import {
  formatInjectReport,
  injectHarnesses,
  type InjectTarget,
  type InjectTransport,
} from "./inject.ts";
import {
  injectOrchestoOnly,
  removeOrchestoSkills,
  updateOrchesto,
} from "./orchesto-skills.ts";
import { join } from "node:path";
import { isMainModule, processArgs } from "./runtime.ts";
import { runSetup } from "./setup.ts";
import { appendEvent } from "./work/ledger.ts";
import type { LedgerEventKind } from "./work/types.ts";

type Command =
  | "setup"
  | "init"
  | "inject"
  | "daemon"
  | "acl"
  | "bootstrap"
  | "capture"
  | "pending"
  | "dream"
  | "reindex"
  | "search"
  | "memory"
  | "ingest"
  | "work-event"
  | "orchesto-update"
  | "orchesto-remove"
  | "help";

function printHelp(): void {
  console.log(`brain — portable second-brain CLI (Bun or Node)

Usage:
  npm run setup -- [--vault <dir>] [--target all|cursor|claude|codex|zed]
  bun run setup -- [--vault <dir>] [--target all|cursor|claude|codex|zed]
  npm run brain -- <command> [options]

Primary (use this to install):
  setup                   Write config + create vault + inject harnesses

Advanced:
  init [--path <dir>]     Vault folders only
  inject [--target <t>] [--transport stdio|http] [--daemon-url <url>] [--orchesto-only]
                          Harness MCP/rules + Orchesto packs, or packs only
  daemon [--host 127.0.0.1] [--port 4190] [--vault <dir>] [--no-warmup] [--no-watch]
                          Run shared Streamable HTTP MCP daemon + local control UI
  acl <list|set|pause|resume|reset> [app] [options]
                          Inspect or update per-harness ACL permissions
  orchesto-update         git pull --ff-only this clone, then refresh Orchesto packs
  orchesto-remove         Delete global Orchesto skill dirs (not vault notes)
  reindex [--vault <dir>] [--force] [--no-embed]
                          Sync or rebuild the local SQLite hybrid search index
  search <query> [--project <slug>] [--mode hybrid|fts|vector] [--limit N]
                          Run hybrid search from the terminal
  memory <add|list|search|update|supersede|delete> [options]
                          Manage atomic ID-tracked memories in Markdown
  bootstrap [--project <slug>] [--cwd <dir>] [--task <text>] [--max-chars N]
                          Print a token-budgeted session-start context briefing
  capture [--project <slug>] [--cwd <dir>] [--app <name>] [--session <id>] [--text <text>] [--stdin]
                          Passively extract & stage candidate memories into Pending Queue
  pending <list|approve|dismiss> [id]
                          Review, approve (promote), or dismiss pending captured memories
  dream [--project <slug>] [--apply] [--prune-days 90] [--no-embed]
                          Consolidate duplicate memories & archive stale superseded blocks (dry-run default)
  ingest                  (planned) promote external/ drops
  work-event              Append a day-log event (harness-agnostic capture)
  help

  work-event flags:
    --kind <k>            session-start | session-end | note | commit | done | focus
    --session <id>        session/conversation id
    --key <KEY>           user-supplied issue key only
    --text <text>         note body
    --date YYYY-MM-DD     default today

Env:
  BRAIN_VAULT             Overrides vault path
`);
}

function parseArgs(argv: string[]): {
  command: Command;
  path?: string;
  target?: string;
  positionals: string[];
  flags: Record<string, string>;
} {
  const [commandRaw, ...rest] = argv;
  const command = (commandRaw ?? "help") as Command;
  let path: string | undefined;
  let target: string | undefined;
  const positionals: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--path" || arg === "--vault") {
      path = rest[++i];
      continue;
    }
    if (arg === "--target") {
      target = rest[++i];
      continue;
    }
    if (
      arg === "--orchesto-only" ||
      arg === "--force" ||
      arg === "--no-embed" ||
      arg === "--no-warmup" ||
      arg === "--no-watch" ||
      arg === "--allow-remote" ||
      arg === "--apply" ||
      arg === "--stdin" ||
      arg === "--no-global" ||
      arg === "--fail-open"
    ) {
      flags[arg.slice(2)] = "true";
      continue;
    }
    if (arg.startsWith("--path=")) {
      path = arg.slice("--path=".length);
      continue;
    }
    if (arg.startsWith("--vault=")) {
      path = arg.slice("--vault=".length);
      continue;
    }
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
      continue;
    }
    const eq = arg.match(/^--([a-z-]+)=(.*)$/);
    if (eq) {
      flags[eq[1]!] = eq[2]!;
      continue;
    }
    if (arg.startsWith("--") && rest[i + 1] && !rest[i + 1]!.startsWith("--")) {
      flags[arg.slice(2)] = rest[++i]!;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
    }
  }
  return { command, path, target, positionals, flags };
}

async function cmdInit(pathOverride?: string): Promise<void> {
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path, pathOverride);
  console.log(formatInitReport(await initVault(vault)));
}

function parseTarget(targetRaw: string): InjectTarget | null {
  const allowed = new Set(["cursor", "claude", "codex", "zed", "all"]);
  if (!allowed.has(targetRaw)) return null;
  return targetRaw as InjectTarget;
}

function isOrchestoOnly(flags: Record<string, string>): boolean {
  return flags["orchesto-only"] === "" || flags["orchesto-only"] === "true";
}

async function cmdInject(
  targetRaw = "all",
  flags: Record<string, string> = {},
): Promise<void> {
  const target = parseTarget(targetRaw);
  if (!target) {
    console.error(`Unknown inject target: ${targetRaw}`);
    process.exitCode = 1;
    return;
  }
  const transportRaw = flags.transport ?? "stdio";
  if (transportRaw !== "stdio" && transportRaw !== "http") {
    console.error(`Unknown --transport: ${transportRaw} (expected stdio | http)`);
    process.exitCode = 1;
    return;
  }
  const { vaultPath, actions } = isOrchestoOnly(flags)
    ? await injectOrchestoOnly(target)
    : await injectHarnesses(target, {
        transport: transportRaw as InjectTransport,
        daemonUrl: flags["daemon-url"],
      });
  console.log(formatInjectReport(vaultPath, actions));
  if (transportRaw === "http") {
    const base = (flags["daemon-url"]?.trim() || "http://127.0.0.1:4190").replace(/\/+$/, "");
    console.log(`[inject] start the daemon: npm run daemon (dashboard: ${base}/)`);
    console.log(
      `[inject] Claude Code HTTP MCP: claude mcp add --transport http ai-mcp-brain "${base}/mcp?app=claude"`,
    );
  }
}

async function cmdDaemon(
  pathOverride: string | undefined,
  flags: Record<string, string>,
): Promise<void> {
  await loadEnvFile(join(configDir(), ".env"));
  const config = await loadConfig({ strictDaemon: true });
  const vaultPath = resolveVaultPath(config.vault_path, pathOverride);
  if (pathOverride) {
    process.env.BRAIN_VAULT = vaultPath;
  }
  let port: number | undefined;
  if (flags.port !== undefined) {
    const parsed = Number(flags.port);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      console.error(`Invalid --port: ${flags.port}`);
      process.exitCode = 1;
      return;
    }
    port = parsed;
  }
  const handle = await startBrainDaemon({
    vaultPath,
    host: flags.host,
    port,
    allowRemote: flags["allow-remote"] === "true",
    warmup: flags["no-warmup"] !== "true",
    watchVault: flags["no-watch"] !== "true",
    daemonConfig: config.daemon,
    configApps: config.apps,
  });

  await new Promise<void>((resolveStop) => {
    const shutdown = () => {
      console.error("\n[brain-daemon] shutting down...");
      void handle.close().finally(resolveStop);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function parseScopeListFlag(raw: string | undefined): ScopeFilter[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const p of parts) {
    if (p !== "global" && p !== "project") {
      throw new Error(`Invalid scope "${p}" (expected global | project)`);
    }
  }
  return parts as ScopeFilter[];
}

async function cmdAcl(
  positionals: string[],
  pathOverride: string | undefined,
  flags: Record<string, string>,
): Promise<void> {
  await loadEnvFile(join(configDir(), ".env"));
  const [sub, appRaw] = positionals;
  const config = await loadConfig({ strictDaemon: true });
  const vaultPath = resolveVaultPath(config.vault_path, pathOverride);
  if (pathOverride) {
    process.env.BRAIN_VAULT = vaultPath;
  }
  const store = await DaemonStateStore.open(vaultPath, {
    daemonConfig: config.daemon,
    configApps: config.apps,
  });

  try {
    switch (sub ?? "list") {
      case "list": {
        const apps = store.listApps();
        console.log(JSON.stringify({ count: apps.length, apps }, null, 2));
        break;
      }
      case "pause": {
        if (!appRaw) {
          console.error("Usage: brain acl pause <app>");
          process.exitCode = 1;
          return;
        }
        const updated = store.upsertAppOverride(validateAppName(appRaw), { enabled: false });
        console.log(JSON.stringify(updated, null, 2));
        break;
      }
      case "resume": {
        if (!appRaw) {
          console.error("Usage: brain acl resume <app>");
          process.exitCode = 1;
          return;
        }
        const updated = store.upsertAppOverride(validateAppName(appRaw), { enabled: true });
        console.log(JSON.stringify(updated, null, 2));
        break;
      }
      case "reset": {
        if (!appRaw) {
          console.error("Usage: brain acl reset <app>");
          process.exitCode = 1;
          return;
        }
        const updated = store.resetAppOverride(validateAppName(appRaw));
        console.log(JSON.stringify(updated, null, 2));
        break;
      }
      case "set": {
        if (!appRaw) {
          console.error(
            "Usage: brain acl set <app> [--mode read-write|read-only|disabled] [--read-scopes global,project] [--write-scopes global,project] [--projects a,b] [--deny-tools a,b]",
          );
          process.exitCode = 1;
          return;
        }
        const modeRaw = flags.mode;
        if (
          modeRaw !== undefined &&
          modeRaw !== "read-write" &&
          modeRaw !== "read-only" &&
          modeRaw !== "disabled"
        ) {
          console.error(`Invalid --mode: ${modeRaw}`);
          process.exitCode = 1;
          return;
        }
        const updated = store.upsertAppOverride(validateAppName(appRaw), {
          mode: modeRaw as AccessMode | undefined,
          enabled: modeRaw ? modeRaw !== "disabled" : undefined,
          readScopes: parseScopeListFlag(flags["read-scopes"]),
          writeScopes: parseScopeListFlag(flags["write-scopes"]),
          allowedProjects:
            flags.projects !== undefined
              ? flags.projects
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined,
          deniedTools:
            flags["deny-tools"] !== undefined
              ? flags["deny-tools"]
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined,
        });
        console.log(JSON.stringify(updated, null, 2));
        break;
      }
      default:
        console.error("Usage: brain acl <list|set|pause|resume|reset> [app] [options]");
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

async function cmdOrchestoUpdate(targetRaw = "all"): Promise<void> {
  const target = parseTarget(targetRaw);
  if (!target) {
    console.error(`Unknown inject target: ${targetRaw}`);
    process.exitCode = 1;
    return;
  }
  try {
    const { vaultPath, actions, pulled } = await updateOrchesto(target);
    console.log(formatInjectReport(vaultPath, actions));
    if (pulled) console.log(`[orchesto-update] pull: ${pulled}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function cmdOrchestoRemove(targetRaw = "all"): Promise<void> {
  const target = parseTarget(targetRaw);
  if (!target) {
    console.error(`Unknown inject target: ${targetRaw}`);
    process.exitCode = 1;
    return;
  }
  const actions = await removeOrchestoSkills(target);
  console.log(formatInjectReport("(orchesto-remove)", actions));
}

async function cmdWorkEvent(flags: Record<string, string>): Promise<void> {
  try {
    const config = await loadConfig();
    const vault = resolveVaultPath(config.vault_path);
    const kind = (flags.kind ?? "note") as LedgerEventKind;
    const result = await appendEvent(vault, {
      kind,
      session: flags.session,
      key: flags.key,
      text: flags.text,
      date: flags.date,
    });
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (err) {
    // Fail open: hooks must never block a session.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 0;
  }
}

async function cmdReindex(
  pathOverride: string | undefined,
  flags: Record<string, string>,
): Promise<void> {
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path, pathOverride);
  const stats = await syncVaultIndex(vault, {
    forceRebuild: flags.force === "true",
    embedder: flags["no-embed"] === "true" ? null : undefined,
  });
  console.log(JSON.stringify(stats, null, 2));
}

async function cmdSearch(
  positionals: string[],
  pathOverride: string | undefined,
  flags: Record<string, string>,
): Promise<void> {
  const query = positionals.join(" ").trim();
  if (!query) {
    console.error("Usage: brain search <query> [--project <slug>] [--mode hybrid|fts|vector]");
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path, pathOverride);
  const modeRaw = flags.mode ?? (flags["no-embed"] === "true" ? "fts" : "hybrid");
  if (modeRaw !== "hybrid" && modeRaw !== "fts" && modeRaw !== "vector") {
    console.error(`Unknown search mode: ${modeRaw} (expected hybrid | fts | vector)`);
    process.exitCode = 1;
    return;
  }
  const scopeRaw = flags.scope;
  if (scopeRaw && scopeRaw !== "global" && scopeRaw !== "project") {
    console.error(`Unknown scope: ${scopeRaw} (expected global | project)`);
    process.exitCode = 1;
    return;
  }
  const mode = modeRaw as SearchMode;
  const limit = flags.limit ? Number(flags.limit) : 10;
  const result = await searchHybrid(vault, query, {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
    mode,
    project: flags.project,
    scope: scopeRaw as "global" | "project" | undefined,
    type: flags.type,
    updatedAfter: flags["updated-after"],
    embedder: flags["no-embed"] === "true" ? null : undefined,
  });
  console.log(
    `mode=${result.modeUsed} hits=${result.hits.length} searchMs=${result.searchMs}ms`,
  );
  for (let i = 0; i < result.hits.length; i++) {
    const h = result.hits[i]!;
    console.log(
      `${i + 1}. ${h.path} (${h.heading}) [score=${h.score} via=${h.matchedBy.join("+")}${
        h.vectorScore !== null ? ` sim=${h.vectorScore}` : ""
      }]`,
    );
    console.log(`   ${h.snippet}`);
    if (h.relatedLinks.length) {
      console.log(`   links: ${h.relatedLinks.join(", ")}`);
    }
  }
}

function parseOptionalPositiveInt(
  raw: string | undefined,
  flagName: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid --${flagName}: ${raw} (expected a positive integer)`);
  }
  return n;
}

function parseOptionalScope(
  raw: string | undefined,
): "global" | "project" | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "global" && raw !== "project") {
    throw new Error(`Unknown --scope: ${raw} (expected global | project)`);
  }
  return raw;
}

function parseOptionalStatus(
  raw: string | undefined,
): "active" | "superseded" | "all" | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "active" && raw !== "superseded" && raw !== "all") {
    throw new Error(`Unknown --status: ${raw} (expected active | superseded | all)`);
  }
  return raw;
}

function parseOptionalSearchMode(
  raw: string | undefined,
): SearchMode | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "hybrid" && raw !== "fts" && raw !== "vector") {
    throw new Error(`Unknown --mode: ${raw} (expected hybrid | fts | vector)`);
  }
  return raw;
}

function parseTagList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function cmdMemory(
  positionals: string[],
  pathOverride: string | undefined,
  flags: Record<string, string>,
): Promise<void> {
  const [sub, ...rest] = positionals;
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path, pathOverride);
  const category = flags.category as MemoryCategory | undefined;
  if (category && !(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
    console.error(
      `Unknown --category: ${category} (expected ${MEMORY_CATEGORIES.join(" | ")})`,
    );
    process.exitCode = 1;
    return;
  }

  let scope: "global" | "project" | undefined;
  let status: "active" | "superseded" | "all" | undefined;
  let mode: SearchMode | undefined;
  let limit: number | undefined;
  try {
    scope = parseOptionalScope(flags.scope);
    status = parseOptionalStatus(flags.status);
    mode = parseOptionalSearchMode(flags.mode);
    limit = parseOptionalPositiveInt(flags.limit, "limit");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const embedder = flags["no-embed"] === "true" ? null : undefined;
  const tags = parseTagList(flags.tags);

  switch (sub) {
    case "add": {
      const content = flags.content || rest.join(" ").trim();
      const title =
        flags.title ||
        content
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find(Boolean)
          ?.replace(/\s+/g, " ")
          .slice(0, 64) ||
        "";
      if (!content || !title) {
        console.error(
          "Usage: brain memory add --title <t> --content <c> [--scope global|project] [--project <slug>] [--category ...]",
        );
        process.exitCode = 1;
        return;
      }
      const res = await addMemorySmart(vault, {
        title,
        content,
        scope,
        project: flags.project,
        category,
        app: flags.app ?? "cli",
        tags,
        supersedeId: flags.supersede,
        dedupe: flags.force === "true" ? "force" : "dedupe",
        embedder,
      });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "list": {
      const items = await listMemories(vault, {
        scope,
        project: flags.project,
        category,
        app: flags.app,
        tags,
        status: status ?? "active",
        limit: limit ?? 30,
      });
      console.log(JSON.stringify({ count: items.length, memories: items }, null, 2));
      break;
    }
    case "search": {
      const query = rest.join(" ").trim();
      if (!query) {
        console.error("Usage: brain memory search <query> [--status active|superseded|all]");
        process.exitCode = 1;
        return;
      }
      const res = await searchMemories(vault, query, {
        scope,
        project: flags.project,
        category,
        app: flags.app,
        tags,
        status: status ?? "active",
        mode: mode ?? (flags["no-embed"] === "true" ? "fts" : "hybrid"),
        limit: limit ?? 10,
        embedder,
      });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "update": {
      const id = flags.id || rest[0];
      if (!id) {
        console.error(
          "Usage: brain memory update <id> [--title <t>] [--content <c>] [--tags a,b] [--category ...]",
        );
        process.exitCode = 1;
        return;
      }
      const res = await updateMemory(vault, {
        id,
        title: flags.title,
        content: flags.content,
        tags,
        category,
        app: flags.app,
      });
      await syncVaultIndex(vault, { embedder }).catch(() => {});
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "supersede": {
      const oldId = flags.id || rest[0];
      const content = flags.content || rest.slice(1).join(" ").trim();
      if (!oldId || !content) {
        console.error(
          "Usage: brain memory supersede <old-id> --content <new-content> [--title <t>] [--tags a,b]",
        );
        process.exitCode = 1;
        return;
      }
      const res = await supersedeMemory(vault, oldId, {
        title: flags.title,
        content,
        tags,
        category,
        app: flags.app ?? "cli",
      });
      await syncVaultIndex(vault, { embedder }).catch(() => {});
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "delete": {
      const id = flags.id || rest[0];
      if (!id) {
        console.error("Usage: brain memory delete <id>");
        process.exitCode = 1;
        return;
      }
      const res = await deleteMemory(vault, id);
      await syncVaultIndex(vault, { embedder }).catch(() => {});
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    default:
      console.error("Usage: brain memory <add|list|search|update|supersede|delete>");
      process.exitCode = 1;
  }
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdBootstrap(
  positionals: string[],
  pathOverride: string | undefined,
  flags: Record<string, string>,
): Promise<void> {
  await loadEnvFile(join(configDir(), ".env"));
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path, pathOverride);
  // Pass full cwd so _meta/projects-index.md path overrides match identically to `brain capture`
  const project = flags.project || flags.cwd || undefined;
  const task = flags.task || positionals.join(" ").trim() || undefined;
  const maxChars = flags["max-chars"] ? Number(flags["max-chars"]) : undefined;
  const embedder = flags["no-embed"] === "true" ? null : undefined;

  const store = await DaemonStateStore.open(vault).catch(() => undefined);
  try {
    const res = await bootstrapContext(vault, {
      project,
      task,
      maxChars: maxChars && Number.isFinite(maxChars) ? maxChars : undefined,
      includeGlobal: flags["no-global"] !== "true",
      stateStore: store,
      embedder,
    });
    console.log(res.markdown);
  } finally {
    store?.close();
  }
}

async function cmdCapture(
  positionals: string[],
  pathOverride: string | undefined,
  flags: Record<string, string>,
): Promise<void> {
  try {
    await loadEnvFile(join(configDir(), ".env"));
    const config = await loadConfig();
    const vault = resolveVaultPath(config.vault_path, pathOverride);
    const stdinText = flags.stdin === "true" ? await readStdinText() : "";
    const summary = [flags.text, positionals.join(" ").trim(), stdinText]
      .filter(Boolean)
      .join("\n")
      .trim();

    const store = await DaemonStateStore.open(vault);
    try {
      const res = await ingestSessionToPending(vault, store, {
        summary: summary || undefined,
        cwd: flags.cwd,
        project: flags.project,
        app: flags.app ?? "hook",
        session: flags.session,
      });
      console.log(JSON.stringify(res, null, 2));
    } finally {
      store.close();
    }
  } catch (err) {
    // Fail open when called from hooks (--fail-open or default hook app)
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = flags["fail-open"] === "true" || flags.app === "hook" ? 0 : 1;
  }
}

async function cmdPending(
  positionals: string[],
  pathOverride: string | undefined,
  flags: Record<string, string>,
): Promise<void> {
  await loadEnvFile(join(configDir(), ".env"));
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path, pathOverride);
  const [sub, idRaw] = positionals;
  const store = await DaemonStateStore.open(vault);
  try {
    switch (sub ?? "list") {
      case "list": {
        const status =
          flags.status === "approved" ||
          flags.status === "dismissed" ||
          flags.status === "approving" ||
          flags.status === "all"
            ? flags.status
            : "pending";
        const items = store.listPendingMemories({
          status,
          project: flags.project,
          limit: flags.limit ? Number(flags.limit) : 50,
        });
        console.log(JSON.stringify({ count: items.length, pending: items }, null, 2));
        break;
      }
      case "approve": {
        const id = flags.id || idRaw;
        if (!id) {
          console.error(
            "Usage: brain pending approve <id> [--title <t>] [--scope global|project] [--project <slug>] [--category <c>] [--tags a,b]",
          );
          process.exitCode = 1;
          return;
        }
        const category = flags.category as MemoryCategory | undefined;
        if (category && !(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
          console.error(`Unknown --category: ${category}`);
          process.exitCode = 1;
          return;
        }
        const scope = parseOptionalScope(flags.scope) ?? (flags.project ? "project" : undefined);
        const res = await approvePendingMemory(vault, store, id, {
          title: flags.title,
          content: flags.content,
          scope,
          project: flags.project,
          category,
          tags: parseTagList(flags.tags),
          embedder: flags["no-embed"] === "true" ? null : undefined,
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "dismiss": {
        const id = flags.id || idRaw;
        if (!id) {
          console.error("Usage: brain pending dismiss <id>");
          process.exitCode = 1;
          return;
        }
        const res = store.dismissPendingMemory(id);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      default:
        console.error("Usage: brain pending <list|approve|dismiss> [id]");
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

async function cmdDream(
  pathOverride: string | undefined,
  flags: Record<string, string>,
): Promise<void> {
  await loadEnvFile(join(configDir(), ".env"));
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path, pathOverride);
  const pruneDays =
    flags["prune-days"] !== undefined ? Number(flags["prune-days"]) : undefined;
  if (pruneDays !== undefined && (!Number.isInteger(pruneDays) || pruneDays < 0)) {
    console.error(`Invalid --prune-days: ${flags["prune-days"]}`);
    process.exitCode = 1;
    return;
  }
  const report = await runDreamConsolidation(vault, {
    apply: flags.apply === "true",
    project: flags.project,
    pruneDays,
    embedder: flags["no-embed"] === "true" ? null : undefined,
  });
  console.log(JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  const { command, path, target, positionals, flags } = parseArgs(processArgs());

  switch (command) {
    case "setup":
      await runSetup({
        vault: path,
        target: (target as InjectTarget) || "all",
      });
      break;
    case "init":
      await cmdInit(path);
      break;
    case "inject":
      await cmdInject(target ?? "all", flags);
      break;
    case "daemon":
      await cmdDaemon(path, flags);
      break;
    case "acl":
      await cmdAcl(positionals, path, flags);
      break;
    case "bootstrap":
      await cmdBootstrap(positionals, path, flags);
      break;
    case "capture":
      await cmdCapture(positionals, path, flags);
      break;
    case "pending":
      await cmdPending(positionals, path, flags);
      break;
    case "dream":
      await cmdDream(path, flags);
      break;
    case "reindex":
      await cmdReindex(path, flags);
      break;
    case "search":
      await cmdSearch(positionals, path, flags);
      break;
    case "memory":
      await cmdMemory(positionals, path, flags);
      break;
    case "orchesto-update":
      await cmdOrchestoUpdate(target ?? "all");
      break;
    case "orchesto-remove":
      await cmdOrchestoRemove(target ?? "all");
      break;
    case "ingest":
      console.log("[ingest] not implemented yet");
      break;
    case "work-event":
      await cmdWorkEvent(flags);
      break;
    case "help":
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
