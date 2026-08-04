import { join } from "node:path";
import { pathExists, readText, writeText } from "../runtime.ts";
import { ensureWorkDirs } from "./today.ts";
import {
  JIRA_CACHE_TTL_MS,
  JIRA_CACHE_VERSION,
  WORK_CACHE_REL,
  type JiraCacheFile,
  type JiraIssueRow,
} from "./types.ts";

export function cachePath(vault: string): string {
  return join(vault, WORK_CACHE_REL);
}

export function isCacheFresh(
  cache: JiraCacheFile,
  now = Date.now(),
  ttlMs = JIRA_CACHE_TTL_MS,
): boolean {
  const t = Date.parse(cache.fetched_at);
  if (Number.isNaN(t)) return false;
  return now - t < ttlMs;
}

export async function readJiraCache(
  vault: string,
): Promise<JiraCacheFile | null> {
  await ensureWorkDirs(vault);
  const path = cachePath(vault);
  if (!(await pathExists(path))) return null;
  try {
    const raw = JSON.parse(await readText(path)) as JiraCacheFile;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.issues)) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export async function writeJiraCache(
  vault: string,
  opts: { filter: string; issues: JiraIssueRow[]; fetchedAt?: string },
): Promise<JiraCacheFile> {
  await ensureWorkDirs(vault);
  const file: JiraCacheFile = {
    version: JIRA_CACHE_VERSION,
    fetched_at: opts.fetchedAt ?? new Date().toISOString(),
    filter: opts.filter,
    issues: opts.issues,
  };
  await writeText(cachePath(vault), JSON.stringify(file, null, 2) + "\n");
  return file;
}
