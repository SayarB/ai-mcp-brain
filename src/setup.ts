#!/usr/bin/env node
/**
 * Single portable entrypoint: create vault + inject harness MCP/rules.
 * Prefer this over separate init/inject when installing.
 */
import { writeConfig, resolveVaultPath, loadConfig, configDir } from "./config.ts";
import { copyEnvExampleIfMissing } from "./env.ts";
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

  const jiraConfigured = Boolean(
    process.env.JIRA_BASE_URL?.trim() &&
      process.env.JIRA_EMAIL?.trim() &&
      process.env.JIRA_API_TOKEN?.trim(),
  );
  console.log(
    `[setup] Jira: ${jiraConfigured ? "configured (env present)" : "not configured (optional — see .env.example)"}`,
  );

  const copied = await copyEnvExampleIfMissing(configDir());
  if (copied) {
    console.log(`[setup] created .env from .env.example — fill Jira vars if desired`);
  }

  console.log(`
[setup] done.

Next:
  1. Open the vault folder in Obsidian (optional but recommended)
  2. Optional work desk: copy .env.example → .env, set JIRA_* , restart MCP
  3. Restart Cursor / Claude / Codex / Zed so MCP + Orchesto skill reload
  4. Call MCP tool vault_info — expect readable: true
  5. Soft prefs auto-log to suggestions/; binding rules go in instructions/ only when you mean hard process
  6. Orchesto is installed globally (no separate "setup orchesto" needed) — ship features; ensure .plans/ is gitignored in product repos
  7. In this repo: git config core.hooksPath .githooks  (post-push restarts local MCP)
`);
}

if (isMainModule(import.meta.url)) {
  const { vault, target } = parseSetupArgs(processArgs());
  await runSetup({ vault, target });
}
