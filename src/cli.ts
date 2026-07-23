#!/usr/bin/env node
import { loadConfig, resolveVaultPath } from "./config.ts";
import { formatInitReport, initVault } from "./init.ts";
import {
  formatInjectReport,
  injectHarnesses,
  type InjectTarget,
} from "./inject.ts";
import { isMainModule, processArgs } from "./runtime.ts";
import { runSetup } from "./setup.ts";

type Command = "setup" | "init" | "inject" | "ingest" | "help";

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
  inject [--target <t>]   Harness MCP/rules only
  ingest                  (planned) promote external/ drops
  help

Env:
  BRAIN_VAULT             Overrides vault path
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
    if (arg === "--path" || arg === "--vault") {
      path = rest[++i];
      continue;
    }
    if (arg === "--target") {
      target = rest[++i];
      continue;
    }
    if (arg?.startsWith("--path=")) path = arg.slice("--path=".length);
    if (arg?.startsWith("--vault=")) path = arg.slice("--vault=".length);
    if (arg?.startsWith("--target=")) target = arg.slice("--target=".length);
  }
  return { command, path, target };
}

async function cmdInit(pathOverride?: string): Promise<void> {
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path, pathOverride);
  console.log(formatInitReport(await initVault(vault)));
}

async function cmdInject(targetRaw = "all"): Promise<void> {
  const allowed = new Set(["cursor", "claude", "codex", "zed", "all"]);
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

async function main(): Promise<void> {
  const { command, path, target } = parseArgs(processArgs());

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
      await cmdInject(target ?? "all");
      break;
    case "ingest":
      console.log("[ingest] not implemented yet");
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
