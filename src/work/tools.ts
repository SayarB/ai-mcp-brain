import { loadConfig, resolveVaultPath } from "../config.ts";
import {
  fetchJiraAssigned,
  JiraNotConfiguredError,
  resolveJiraConfig,
} from "../jira/client.ts";
import { readJiraCache, writeJiraCache } from "./cache.ts";
import { buildPlateFromCache, readCacheIfFresh } from "./plate.ts";
import { todayAdd, todayComplete, todayList } from "./today.ts";
import { ALL_ASSIGNED_JIRA_JQL, DEFAULT_JIRA_JQL } from "./types.ts";

export type JiraScope = "sprint" | "all";

async function vaultPath(): Promise<string> {
  const config = await loadConfig();
  return resolveVaultPath(config.vault_path);
}

/** Resolve JQL: explicit jql > scope=all > sprint default (config or openSprints). */
export function jqlForScope(
  scope: JiraScope | undefined,
  jqlOverride: string | undefined,
  configuredDefault: string,
): string {
  if (jqlOverride?.trim()) return jqlOverride.trim();
  if (scope === "all") return ALL_ASSIGNED_JIRA_JQL;
  // sprint (default)
  if (
    configuredDefault.includes("openSprints") ||
    configuredDefault === DEFAULT_JIRA_JQL
  ) {
    return configuredDefault;
  }
  // Legacy config default was all-assigned — prefer sprint filter for default scope
  if (configuredDefault === ALL_ASSIGNED_JIRA_JQL) {
    return DEFAULT_JIRA_JQL;
  }
  return configuredDefault || DEFAULT_JIRA_JQL;
}

export async function toolJiraAssigned(opts: {
  refresh?: boolean;
  jql?: string;
  scope?: JiraScope;
}) {
  const config = await loadConfig();
  const jira = resolveJiraConfig(config);
  if (!jira) throw new JiraNotConfiguredError();

  const vault = await vaultPath();
  const filter = jqlForScope(opts.scope, opts.jql, jira.defaultJql);

  if (!opts.refresh && !opts.jql) {
    const { cache, fresh } = await readCacheIfFresh(vault);
    if (cache && fresh && cache.filter === filter) {
      return {
        source: "cache" as const,
        scope: opts.scope ?? "sprint",
        fetched_at: cache.fetched_at,
        filter: cache.filter,
        count: cache.issues.length,
        issues: cache.issues.map((i) => ({
          key: i.key,
          summary: i.summary,
          status: i.status,
          url: i.url,
        })),
      };
    }
  }

  const { filter: usedFilter, issues } = await fetchJiraAssigned(jira, filter);
  const cache = await writeJiraCache(vault, { filter: usedFilter, issues });
  return {
    source: "network" as const,
    scope: opts.jql ? "custom" : (opts.scope ?? "sprint"),
    fetched_at: cache.fetched_at,
    filter: cache.filter,
    count: issues.length,
    issues: issues.map((i) => ({
      key: i.key,
      summary: i.summary,
      status: i.status,
      url: i.url,
    })),
  };
}

export async function toolWorkPlate(opts: {
  refresh?: boolean;
  scope?: JiraScope;
}) {
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path);
  const jira = resolveJiraConfig(config);
  const filter = jira
    ? jqlForScope(opts.scope, undefined, jira.defaultJql)
    : DEFAULT_JIRA_JQL;

  let jiraError: string | undefined;
  const { fresh } = await readCacheIfFresh(vault);
  const existing = await readJiraCache(vault);
  const cacheMatches = Boolean(existing && existing.filter === filter);

  if (opts.refresh || !fresh || !cacheMatches) {
    if (!jira) {
      jiraError = new JiraNotConfiguredError().message;
    } else {
      try {
        const { filter: usedFilter, issues } = await fetchJiraAssigned(
          jira,
          filter,
        );
        await writeJiraCache(vault, { filter: usedFilter, issues });
      } catch (err) {
        jiraError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const cache = await readJiraCache(vault);
  const plate = await buildPlateFromCache(vault, cache, jiraError);
  return { ...plate, scope: opts.scope ?? "sprint", filter_used: filter };
}

export async function toolWorkToday(opts: {
  op: "list" | "add" | "complete";
  key?: string;
  text?: string;
  note?: string;
  log?: string;
}) {
  const vault = await vaultPath();

  if (opts.op === "list") return todayList(vault);
  if (opts.op === "add") {
    return todayAdd(vault, {
      key: opts.key,
      text: opts.text,
      note: opts.note,
    });
  }
  return todayComplete(vault, {
    key: opts.key,
    text: opts.text,
    log: opts.log,
  });
}
