import { loadConfig, resolveVaultPath } from "../config.ts";
import {
  fetchJiraAssigned,
  JiraNotConfiguredError,
  resolveJiraConfig,
} from "../jira/client.ts";
import { readJiraCache, writeJiraCache } from "./cache.ts";
import { buildPlateFromCache, readCacheIfFresh } from "./plate.ts";
import { todayAdd, todayComplete, todayList } from "./today.ts";

async function vaultPath(): Promise<string> {
  const config = await loadConfig();
  return resolveVaultPath(config.vault_path);
}

export async function toolJiraAssigned(opts: {
  refresh?: boolean;
  jql?: string;
}) {
  const config = await loadConfig();
  const jira = resolveJiraConfig(config);
  if (!jira) throw new JiraNotConfiguredError();

  const vault = await vaultPath();

  if (!opts.refresh && !opts.jql) {
    const { cache, fresh } = await readCacheIfFresh(vault);
    if (cache && fresh) {
      return {
        source: "cache" as const,
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

  const { filter, issues } = await fetchJiraAssigned(jira, opts.jql);
  const cache = await writeJiraCache(vault, { filter, issues });
  return {
    source: "network" as const,
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

export async function toolWorkPlate(opts: { refresh?: boolean }) {
  const config = await loadConfig();
  const vault = resolveVaultPath(config.vault_path);

  let jiraError: string | undefined;
  const { fresh } = await readCacheIfFresh(vault);

  if (opts.refresh || !fresh) {
    const jira = resolveJiraConfig(config);
    if (!jira) {
      jiraError = new JiraNotConfiguredError().message;
    } else {
      try {
        const { filter, issues } = await fetchJiraAssigned(jira);
        await writeJiraCache(vault, { filter, issues });
      } catch (err) {
        jiraError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const cache = await readJiraCache(vault);
  return buildPlateFromCache(vault, cache, jiraError);
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
