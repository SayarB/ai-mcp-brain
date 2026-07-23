#!/usr/bin/env bun
import { loadConfig, resolveVaultPath } from "./config.ts";
import { formatInitReport, initVault } from "./init.ts";
import {
  formatInjectReport,
  injectHarnesses,
  type InjectTarget,
} from "./inject.ts";

type Command = "init" | "inject" | "ingest" | "help";

function printHelp(): void {
  console.log(`brain — second-brain scaffolding CLI

Usage:
  bun run brain -- <command> [options]

Commands:
  init [--path <dir>]     Create Obsidian vault structure (idempotent)
  inject [--target <t>]   Inject memory rules + MCP into harnesses
                          targets: cursor | claude | codex | all
  ingest                  Promote vault/external into notes (phase 5+)
  help                    Show this help

Config:
  Copy config.example.toml → config.toml
  BRAIN_VAULT env overrides vault_path
`);
}

function parseArgs(argv: string[]): {
  command: Command;
  path?: string;
  target?: string;
} {
  const [commandRaw, ...rest] = argv;
  const command = (commandRaw ?? "help") as Command;

  let path: string | undefined;
  let target: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--path") {
      path = rest[++i];
      continue;
    }
    if (arg === "--target") {
      target = rest[++i];
      continue;
    }
    if (arg?.startsWith("--path=")) {
      path = arg.slice("--path=".length);
      continue;
    }
    if (arg?.startsWith("--target=")) {
      target = arg.slice("--target=".length);
      continue;
    }
  }

  return { command, path, target };
}

async function cmdInit(pathOverride?: string): Promise<void> {
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path, pathOverride);
  const result = await initVault(vault);
  console.log(formatInitReport(result));
}

async function cmdInject(targetRaw = "all"): Promise<void> {
  const allowed = new Set(["cursor", "claude", "codex", "all"]);
  if (!allowed.has(targetRaw)) {
    console.error(`Unknown inject target: ${targetRaw}`);
    process.exitCode = 1;
    return;
  }
  const { vaultPath, actions } = await injectHarnesses(
    targetRaw as InjectTarget,
  );
  console.log(formatInjectReport(vaultPath, actions));
}

async function cmdIngest(): Promise<void> {
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path);
  console.log(`[ingest] stub — would scan: ${vault}/external`);
  console.log("[ingest] not implemented yet (phase 5)");
}

async function main(): Promise<void> {
  const { command, path, target } = parseArgs(Bun.argv.slice(2));

  switch (command) {
    case "init":
      await cmdInit(path);
      break;
    case "inject":
      await cmdInject(target ?? "all");
      break;
    case "ingest":
      await cmdIngest();
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

await main();
