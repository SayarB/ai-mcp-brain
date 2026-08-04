/**
 * Node-compatible IO / parsing helpers (also run under Bun).
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  writeFile,
  constants,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "glob";
import { parse as parseTomlLib } from "smol-toml";
import { parse as parseYamlLib } from "yaml";

export function moduleDir(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}

function isUserScriptArg(arg: string): boolean {
  if (!/\.(m?[jt]sx?|cjs|mjs)$/.test(arg)) return false;
  if (arg.includes("node_modules")) return false;
  return true;
}

/** True when this module is the process entry script (works with Bun and tsx). */
export function isMainModule(importMetaUrl: string): boolean {
  const self = resolve(fileURLToPath(importMetaUrl));
  for (const arg of process.argv.slice(1)) {
    if (!isUserScriptArg(arg)) continue;
    try {
      if (resolve(arg) === self) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** CLI args after the runtime + entry script (Bun or `node`/`tsx`). */
export function processArgs(): string[] {
  const argv = process.argv.slice(1);
  for (let i = 0; i < argv.length; i++) {
    if (isUserScriptArg(argv[i]!)) return argv.slice(i + 1);
  }
  return process.argv.slice(2);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(path: string): boolean {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeText(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

export async function copyFileEnsured(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

export async function globFiles(
  cwd: string,
  pattern: string,
): Promise<string[]> {
  return glob(pattern, {
    cwd,
    nodir: true,
    dot: false,
    absolute: false,
  });
}

export function parseYaml<T = unknown>(text: string): T {
  return parseYamlLib(text) as T;
}

export function parseToml<T = unknown>(text: string): T {
  return parseTomlLib(text) as T;
}

export function whichSync(cmd: string): string | null {
  try {
    const bin = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(bin, [cmd], { encoding: "utf8" });
    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

export type McpLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  runtime: "bun" | "node";
};

/**
 * Prefer Bun when available; otherwise Node + local tsx.
 * Passes through optional JIRA_* when already set in the parent environment.
 */
export function resolveMcpLaunch(
  repoRoot: string,
  serverScript: string,
  vaultPath: string,
): McpLaunch {
  const env: Record<string, string> = { BRAIN_VAULT: vaultPath };
  for (const k of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const) {
    const v = process.env[k]?.trim();
    if (v) env[k] = v;
  }
  const bun =
    whichSync("bun") ||
    whichSync("bun.exe") ||
    (() => {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      if (!home) return null;
      const candidate = resolve(
        home,
        ".bun",
        "bin",
        process.platform === "win32" ? "bun.exe" : "bun",
      );
      return pathExistsSync(candidate) ? candidate : null;
    })();

  if (bun) {
    return {
      command: bun,
      args: [serverScript],
      cwd: repoRoot,
      env,
      runtime: "bun",
    };
  }

  const node =
    whichSync("node") ||
    whichSync("node.exe") ||
    (process.execPath.includes("node") ? process.execPath : null);
  if (!node) {
    throw new Error(
      "Neither Bun nor Node found on PATH. Install Bun (https://bun.sh) or Node.js 20+.",
    );
  }

  const tsxCli = resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (!pathExistsSync(tsxCli)) {
    throw new Error(
      `tsx missing at ${tsxCli}. Run npm install (or bun install) in the repo first.`,
    );
  }

  return {
    command: node,
    args: [tsxCli, serverScript],
    cwd: repoRoot,
    env,
    runtime: "node",
  };
}
