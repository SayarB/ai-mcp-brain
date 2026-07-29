#!/usr/bin/env node
/**
 * Single portable entrypoint: create vault + inject harness MCP/rules.
 * Prefer this over separate init/inject when installing.
 */
import { writeConfig, resolveVaultPath, loadConfig } from "./config.ts";
import { formatInitReport, initVault } from "./init.ts";
import {
  formatInjectReport,
  injectHarnesses,
  type InjectTarget,
} from "./inject.ts";
import { isMainModule, processArgs, whichSync } from "./runtime.ts";

function parseSetupArgs(argv: string[]): {
  vault?: string;
  target: InjectTarget;
} {
  let vault: string | undefined;
  let target: InjectTarget = "all";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" || a === "--path") {
      vault = argv[++i];
      continue;
    }
    if (a === "--target") {
      target = argv[++i] as InjectTarget;
      continue;
    }
    if (a?.startsWith("--vault=")) vault = a.slice("--vault=".length);
    if (a?.startsWith("--path=")) vault = a.slice("--path=".length);
    if (a?.startsWith("--target=")) {
      target = a.slice("--target=".length) as InjectTarget;
    }
  }
  return { vault, target };
}

export async function runSetup(opts?: {
  vault?: string;
  target?: InjectTarget;
}): Promise<void> {
  const hasBun = Boolean(whichSync("bun") || whichSync("bun.exe"));
  const hasNode = Boolean(whichSync("node") || whichSync("node.exe"));
  if (!hasBun && !hasNode && !process.execPath) {
    console.error(
      "[setup] Bun or Node.js is required. Install from https://bun.sh or https://nodejs.org",
    );
    process.exitCode = 1;
    return;
  }

  const vaultInput =
    opts?.vault?.trim() ||
    process.env.BRAIN_VAULT?.trim() ||
    (await loadConfig()).vault_path;

  // Preserve spaces if caller forgot quotes (join leftover? — prefer single arg only)
  const configPath = await writeConfig(vaultInput);
  const vaultPath = resolveVaultPath(vaultInput);
  console.log(`[setup] config → ${configPath}`);
  console.log(`[setup] vault  → ${vaultPath}`);

  const initResult = await initVault(vaultPath);
  console.log(formatInitReport(initResult));

  const target = opts?.target ?? "all";
  const { actions } = await injectHarnesses(target);
  console.log(formatInjectReport(vaultPath, actions));

  console.log(`
[setup] done.

Next:
  1. Open the vault folder in Obsidian (optional but recommended)
  2. Restart Cursor / Claude / Codex / Zed so MCP reloads
  3. Call MCP tool vault_info — expect readable: true
  4. Soft prefs auto-log to suggestions/; binding rules go in instructions/ only when you mean hard process
  5. In this repo: git config core.hooksPath .githooks  (post-push restarts local MCP)
`);
}

if (isMainModule(import.meta.url)) {
  const { vault, target } = parseSetupArgs(processArgs());
  await runSetup({ vault, target });
}
