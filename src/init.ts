import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configDir } from "./config.ts";
import {
  copyFileEnsured,
  globFiles,
  pathExists,
} from "./runtime.ts";
import { REQUIRED_VAULT_DIRS } from "./vault-layout.ts";

export type InitResult = {
  vaultPath: string;
  created: string[];
  skipped: string[];
};

function templatesRoot(): string {
  return resolve(configDir(), "templates", "vault");
}

export async function initVault(vaultPath: string): Promise<InitResult> {
  const templateDir = templatesRoot();
  if (!(await pathExists(join(templateDir, "AGENTS.md")))) {
    throw new Error(`Vault templates missing at ${templateDir}`);
  }

  await mkdir(vaultPath, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];
  const files = await globFiles(templateDir, "**/*");

  for (const rel of files) {
    // Project pack templates are materialised via ensureProject, not copied as literals
    if (rel.split("/").includes("_template") || rel.split("\\").includes("_template")) {
      continue;
    }

    const src = join(templateDir, rel);
    const dest = join(vaultPath, rel);

    if (await pathExists(dest)) {
      skipped.push(rel);
      continue;
    }

    await copyFileEnsured(src, dest);
    created.push(rel);
  }

  // Ensure empty-capable dirs exist even if a template file was skipped somehow
  for (const dir of REQUIRED_VAULT_DIRS) {
    await mkdir(join(vaultPath, dir), { recursive: true });
  }

  return { vaultPath, created, skipped };
}

export function formatInitReport(result: InitResult): string {
  const lines = [
    `[init] vault: ${result.vaultPath}`,
    `[init] created: ${result.created.length}`,
    `[init] skipped (already exist): ${result.skipped.length}`,
  ];
  if (result.created.length) {
    lines.push("[init] new files:");
    for (const f of result.created) {
      lines.push(`  + ${f}`);
    }
  }
  lines.push("[init] open this folder in Obsidian if it is not already open.");
  return lines.join("\n");
}
