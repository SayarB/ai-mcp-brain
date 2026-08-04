import { normalizeIssueKey, todayList } from "./today.ts";
import { isCacheFresh, readJiraCache } from "./cache.ts";
import type { JiraCacheFile, JiraIssueRow } from "./types.ts";
import { compactTodayItems } from "./today.ts";

export type PlateResult = {
  cache_fresh: boolean;
  fetched_at?: string;
  filter?: string;
  counts: {
    jira_open: number;
    on_today: number;
    jira_only: number;
    today_only: number;
  };
  on_today: Array<{ key: string; summary?: string; status?: string; today_note?: string }>;
  jira_only: Array<{ key: string; summary: string; status: string }>;
  today_only: ReturnType<typeof compactTodayItems>;
  jira_error?: string;
};

function todayKeys(items: { key?: string }[]): Set<string> {
  const s = new Set<string>();
  for (const i of items) {
    if (i.key) s.add(i.key);
  }
  return s;
}

export function comparePlate(
  issues: JiraIssueRow[],
  openToday: ReturnType<typeof compactTodayItems>,
): Omit<PlateResult, "cache_fresh" | "fetched_at" | "filter" | "jira_error"> {
  const jiraByKey = new Map(issues.map((i) => [i.key.toUpperCase(), i]));
  const openKeys = todayKeys(openToday);

  const on_today: PlateResult["on_today"] = [];
  const jira_only: PlateResult["jira_only"] = [];
  const today_only = openToday.filter((t) => {
    if (!t.key) return true;
    return !jiraByKey.has(t.key);
  });

  for (const issue of issues) {
    const k = issue.key.toUpperCase();
    if (openKeys.has(k)) {
      const t = openToday.find((x) => x.key === k);
      on_today.push({
        key: issue.key,
        summary: issue.summary,
        status: issue.status,
        today_note: t?.note,
      });
    } else {
      jira_only.push({
        key: issue.key,
        summary: issue.summary,
        status: issue.status,
      });
    }
  }

  return {
    counts: {
      jira_open: issues.length,
      on_today: on_today.length,
      jira_only: jira_only.length,
      today_only: today_only.length,
    },
    on_today,
    jira_only,
    today_only,
  };
}

export async function buildPlateFromCache(
  vault: string,
  cache: JiraCacheFile | null,
  jiraError?: string,
): Promise<PlateResult> {
  const listed = await todayList(vault);
  const open = listed.open;
  if (!cache) {
    return {
      cache_fresh: false,
      counts: {
        jira_open: 0,
        on_today: 0,
        jira_only: 0,
        today_only: open.length,
      },
      on_today: [],
      jira_only: [],
      today_only: open,
      jira_error: jiraError ?? "no_cache",
    };
  }
  const cmp = comparePlate(cache.issues, open);
  return {
    cache_fresh: isCacheFresh(cache),
    fetched_at: cache.fetched_at,
    filter: cache.filter,
    ...cmp,
    jira_error: jiraError,
  };
}

export async function readCacheIfFresh(vault: string) {
  const cache = await readJiraCache(vault);
  if (!cache) return { cache: null, fresh: false };
  return { cache, fresh: isCacheFresh(cache) };
}

/** Re-export for tests */
export { normalizeIssueKey };
