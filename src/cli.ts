#!/usr/bin/env node
import { loadConfig, resolveVaultPath } from "./config.ts";
import { searchHybrid, syncVaultIndex, type SearchMode } from "./index/index.ts";
import { formatInitReport, initVault } from "./init.ts";
import {
  addMemorySmart,
  deleteMemory,
  listMemories,
  MEMORY_CATEGORIES,
  searchMemories,
  supersedeMemory,
  updateMemory,
  type MemoryCategory,
} from "./memory/index.ts";
import {
  formatInjectReport,
  injectHarnesses,
  type InjectTarget,
} from "./inject.ts";
import {
  injectOrchestoOnly,
  removeOrchestoSkills,
  updateOrchesto,
} from "./orchesto-skills.ts";
import { isMainModule, processArgs } from "./runtime.ts";
import { runSetup } from "./setup.ts";
import { appendEvent } from "./work/ledger.ts";
import type { LedgerEventKind } from "./work/types.ts";

type Command =
  | "setup"
  | "init"
  | "inject"
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
  inject [--target <t>] [--orchesto-only]
                          Harness MCP/rules + Orchesto packs, or packs only
  orchesto-update         git pull --ff-only this clone, then refresh Orchesto packs
  orchesto-remove         Delete global Orchesto skill dirs (not vault notes)
  reindex [--vault <dir>] [--force] [--no-embed]
                          Sync or rebuild the local SQLite hybrid search index
  search <query> [--project <slug>] [--mode hybrid|fts|vector] [--limit N]
                          Run hybrid search from the terminal
  memory <add|list|search|update|supersede|delete> [options]
                          Manage atomic ID-tracked memories in Markdown
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
    if (arg === "--orchesto-only" || arg === "--force" || arg === "--no-embed") {
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
  const { vaultPath, actions } = isOrchestoOnly(flags)
    ? await injectOrchestoOnly(target)
    : await injectHarnesses(target);
  console.log(formatInjectReport(vaultPath, actions));
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
