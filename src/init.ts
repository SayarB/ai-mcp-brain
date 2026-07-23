import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configDir } from "./config.ts";

export type InitResult = {
  vaultPath: string;
  created: string[];
  skipped: string[];
};

function templatesRoot(): string {
  return resolve(configDir(), "templates", "vault");
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const glob = new Bun.Glob("**/*");
  for await (const path of glob.scan({ cwd: dir, onlyFiles: true, dot: false })) {
    yield path;
  }
}

export async function initVault(vaultPath: string): Promise<InitResult> {
  const templateDir = templatesRoot();
  const templateRoot = Bun.file(join(templateDir, "AGENTS.md"));
  if (!(await templateRoot.exists())) {
    throw new Error(`Vault templates missing at ${templateDir}`);
  }

  await mkdir(vaultPath, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  for await (const rel of walkFiles(templateDir)) {
    // Project pack templates are materialised via ensureProject, not copied as literals
    if (rel.split("/").includes("_template")) {
      continue;
    }

    const src = join(templateDir, rel);
    const dest = join(vaultPath, rel);
    const destFile = Bun.file(dest);

    if (await destFile.exists()) {
      skipped.push(rel);
      continue;
    }

    await mkdir(resolve(dest, ".."), { recursive: true });
    await Bun.write(dest, Bun.file(src));
    created.push(rel);
  }

  // Ensure empty-capable dirs exist even if a template file was skipped somehow
  const dirs = [
    "inbox",
    "external",
    "projects",
    "patterns",
    "stack",
    "stack/catalog",
    "media",
    "agents",
    "_meta",
  ];
  for (const dir of dirs) {
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
