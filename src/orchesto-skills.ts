/**
 * Orchesto lifecycle: orchesto-only inject, git-pull update, and remove.
 * Pack copy + vault persona safe-sync live in inject.ts / orchesto-sync.ts.
 */
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { configDir, loadConfig, resolveVaultPath } from "./config.ts";
import {
  installOrchestoSkills,
  orchestoGlobalSkillDirs,
  orchestoPackDir,
  type InjectAction,
  type InjectTarget,
  type OrchestoInstallOpts,
} from "./inject.ts";
import { pathExists } from "./runtime.ts";
import { syncOrchestoVaultPersonas } from "./orchesto-sync.ts";

const execFileAsync = promisify(execFile);

export type OrchestoSkillOpts = OrchestoInstallOpts & {
  vaultPath?: string;
  repoRoot?: string;
};

async function resolveVault(opts?: OrchestoSkillOpts): Promise<string> {
  if (opts?.vaultPath) return opts.vaultPath;
  const config = await loadConfig();
  return resolveVaultPath(config.vault_path);
}

/** Copy Orchesto packs + safe-sync vault personas. No harness MCP/rules. */
export async function injectOrchestoOnly(
  target: InjectTarget = "all",
  opts?: OrchestoSkillOpts,
): Promise<{ vaultPath: string; actions: InjectAction[] }> {
  const vaultPath = await resolveVault(opts);
  const actions: InjectAction[] = [
    ...(await installOrchestoSkills(target, opts)),
    ...(await syncOrchestoVaultPersonas(vaultPath, orchestoPackDir())),
  ];
  return { vaultPath, actions };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 120_000,
    encoding: "utf8",
  });
  return stdout;
}

/** Fast-forward pull of the brain clone, then orchesto-only install. */
export async function updateOrchesto(
  target: InjectTarget = "all",
  opts?: OrchestoSkillOpts,
): Promise<{ vaultPath: string; actions: InjectAction[]; pulled?: string }> {
  const repoRoot = opts?.repoRoot ?? configDir();
  const porcelain = (await git(repoRoot, ["status", "--porcelain"])).trim();
  if (porcelain) {
    throw new Error(
      `Dirty clone at ${repoRoot}; working tree is not clean. Commit or discard locally, then retry. git status --porcelain:\n${porcelain}`,
    );
  }
  let pulled: string;
  try {
    pulled = (await git(repoRoot, ["pull", "--ff-only"])).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git pull --ff-only failed in ${repoRoot}: ${msg}`);
  }
  const { vaultPath, actions } = await injectOrchestoOnly(target, opts);
  return { vaultPath, actions, pulled };
}

/** Delete global Orchesto skill dirs only. Never vault or project-local copies. */
export async function removeOrchestoSkills(
  target: InjectTarget = "all",
  opts?: OrchestoInstallOpts,
): Promise<InjectAction[]> {
  const actions: InjectAction[] = [];
  for (const dir of orchestoGlobalSkillDirs(target, opts)) {
    const existed = await pathExists(dir);
    await rm(dir, { recursive: true, force: true });
    actions.push({
      target: "orchesto-skill",
      path: dir,
      action: existed ? "removed" : "skipped",
      detail: existed ? "removed skill dir" : "missing",
    });
  }
  return actions;
}
