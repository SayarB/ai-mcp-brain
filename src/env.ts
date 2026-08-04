import { join } from "node:path";
import { pathExists, readText, writeText } from "./runtime.ts";

/**
 * Load KEY=VALUE pairs from a .env file into process.env.
 * Does not override keys already set. No dependency on dotenv package.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

export async function loadEnvFile(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!(await pathExists(filePath))) return false;
  const parsed = parseEnvFile(await readText(filePath));
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined || env[k] === "") env[k] = v;
  }
  return true;
}

export async function ensureEnvExample(repoRoot: string): Promise<string | null> {
  const example = join(repoRoot, ".env.example");
  const target = join(repoRoot, ".env");
  if (await pathExists(target)) return null;
  if (!(await pathExists(example))) return null;
  // Do not auto-copy secrets template into .env during MCP start — setup owns that.
  return example;
}

export async function copyEnvExampleIfMissing(repoRoot: string): Promise<boolean> {
  const example = join(repoRoot, ".env.example");
  const target = join(repoRoot, ".env");
  if (await pathExists(target)) return false;
  if (!(await pathExists(example))) return false;
  await writeText(target, await readText(example));
  return true;
}

export const JIRA_ENV_KEYS = [
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
] as const;

export function pickJiraEnvPassThrough(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of JIRA_ENV_KEYS) {
    const v = env[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
}
