import { loadConfig, resolveVaultPath } from "../config.ts";
import {
  fetchJiraAssigned,
  JiraNotConfiguredError,
  resolveJiraConfig,
} from "../jira/client.ts";
import {
  addFixVersion,
  createIssue,
  createVersion,
  fetchMyWorklogsOnDate,
  fetchSprintIssues,
  listBoards,
  listSprints,
  minutesByKey,
  postWorklog,
  releaseVersion,
  resolveProjectId,
  type ExistingWorklog,
} from "../jira/write.ts";
import { readJiraCache, writeJiraCache } from "./cache.ts";
import { deriveBlocks } from "./derive.ts";
import { commitsToEvents, harvestDayCommits, mergeCommitEvents } from "./git.ts";
import {
  appendEvent,
  appendReceipts,
  readLedger,
} from "./ledger.ts";
import { buildPlateFromCache, readCacheIfFresh } from "./plate.ts";
import { localDateString, todayAdd, todayComplete, todayList } from "./today.ts";
import {
  ALL_ASSIGNED_JIRA_JQL,
  DEFAULT_JIRA_JQL,
  WORK_ABSURD_MS,
  type LedgerEventKind,
  type PushEntry,
  type PushReceipt,
} from "./types.ts";
import { normalizeIssueKey } from "./today.ts";

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

const EVENT_KINDS: LedgerEventKind[] = [
  "session-start",
  "session-end",
  "note",
  "commit",
  "done",
  "focus",
];

export async function toolWorkLog(opts: {
  op: "event" | "review" | "push";
  kind?: string;
  session?: string;
  key?: string;
  text?: string;
  date?: string;
  time?: string;
  cwd?: string;
  entries?: Array<PushEntry & { force?: boolean }>;
  create?: Array<{ summary: string; project?: string; issueType?: string }>;
}) {
  const vault = await vaultPath();
  const date = opts.date ?? localDateString();

  if (opts.op === "event") {
    const kind = (opts.kind ?? "note") as LedgerEventKind;
    if (!EVENT_KINDS.includes(kind)) {
      throw new Error(`unknown event kind: ${opts.kind}`);
    }
    // Never invent a key from text — only the explicit `key` argument counts.
    const key = normalizeIssueKey(opts.key);
    return appendEvent(vault, {
      kind,
      session: opts.session,
      key,
      text: opts.text,
      date,
      time: opts.time,
    });
  }

  const ledger = await readLedger(vault, date);
  const harvested = commitsToEvents(
    await harvestDayCommits(opts.cwd ?? process.cwd(), date),
  );
  const events = mergeCommitEvents(ledger.events, harvested);
  const derived = deriveBlocks(events);
  if (derived.absurd) {
    throw new Error(
      `Derived day total ${derived.total_minutes}m exceeds the ${WORK_ABSURD_MS / 3_600_000}h absurdity guard — refusing rather than truncating. Check the ledger.`,
    );
  }

  const config = await loadConfig();
  const jira = resolveJiraConfig(config);

  let existing: ExistingWorklog[] = [];
  let existingError: string | undefined;
  if (jira) {
    try {
      existing = await fetchMyWorklogsOnDate(jira, date);
    } catch (err) {
      existingError = err instanceof Error ? err.message : String(err);
    }
  }
  const already = minutesByKey(existing);

  if (opts.op === "review") {
    const blocks = derived.blocks.map((b) => {
      const logged = b.key ? (already.get(b.key) ?? 0) : 0;
      return {
        ...b,
        already_logged_minutes: logged,
        overlap: Boolean(b.key && logged > 0),
        existing_worklogs: b.key
          ? existing.filter((w) => w.key === b.key)
          : [],
        minutes_to_push: b.key
          ? Math.max(0, b.minutes - logged)
          : 0,
      };
    });
    return {
      date,
      total_minutes: derived.total_minutes,
      active_buckets: derived.active_buckets,
      unparsed: ledger.unparsed,
      receipts: ledger.receipts,
      jira_worklogs_error: existingError,
      blocks,
    };
  }

  // push
  if (existingError) {
    throw new Error(
      `Refusing to push: could not fetch today's Jira worklogs (${existingError}). A failed lookup would risk double-logging.`,
    );
  }
  if (!jira) throw new JiraNotConfiguredError();
  if (!opts.entries?.length) {
    throw new Error("work_log push requires an explicit entries array");
  }

  const created: Array<{ key: string; summary: string }> = [];
  if (opts.create?.length) {
    for (const c of opts.create) {
      const project = c.project || jira.defaultProject;
      if (!project) {
        throw new Error(
          "create requires project (or [jira] default_project in config.toml)",
        );
      }
      const iss = await createIssue(jira, {
        project,
        issueType: c.issueType || jira.defaultIssueType || "Task",
        summary: c.summary,
      });
      created.push({ key: iss.key, summary: c.summary });
    }
  }

  const receiptIds = new Set(ledger.receipts.map((r) => `${r.key}:${r.minutes}`));
  const results: Array<Record<string, unknown>> = [];
  const newReceipts: PushReceipt[] = [];

  for (const entry of opts.entries) {
    const key = normalizeIssueKey(entry.key);
    if (!key) {
      throw new Error(`push entry missing a valid issue key: ${entry.key}`);
    }
    const requested = Number(entry.minutes);
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new Error(`push entry for ${key} needs minutes > 0`);
    }
    const logged = already.get(key) ?? 0;
    const delta = entry.force ? requested : Math.max(0, requested - logged);
    if (delta <= 0) {
      results.push({
        key,
        skipped: "already_logged",
        already_logged_minutes: logged,
        requested,
      });
      continue;
    }
    // Receipts are a fallback when Jira hasn't shown the earlier post yet.
    // If Jira already accounts for time, the delta handles duplicates.
    if (logged === 0 && receiptIds.has(`${key}:${delta}`) && !entry.force) {
      results.push({ key, skipped: "local_receipt", minutes: delta });
      continue;
    }
    try {
      const posted = await postWorklog(jira, {
        key,
        seconds: Math.round(delta * 60),
        comment: entry.comment,
      });
      const receipt: PushReceipt = {
        key,
        minutes: delta,
        worklog_id: posted.id,
        at: new Date().toISOString(),
      };
      newReceipts.push(receipt);
      await appendReceipts(vault, date, [receipt]);
      already.set(key, logged + delta);
      results.push({
        key,
        posted: true,
        minutes: delta,
        worklog_id: posted.id,
        already_logged_minutes: logged,
      });
    } catch (err) {
      results.push({
        key,
        posted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    date,
    created,
    results,
    receipts_written: newReceipts.length,
  };
}

export async function toolJiraRelease(opts: {
  op: "sprints" | "preview" | "create" | "release";
  project?: string;
  sprintId?: number;
  name?: string;
  keys?: string[];
  versionId?: string;
  releaseDate?: string;
  description?: string;
}) {
  const config = await loadConfig();
  const jira = resolveJiraConfig(config);
  if (!jira) throw new JiraNotConfiguredError();
  const project = opts.project || jira.defaultProject;
  if (!project && opts.op !== "release" && opts.op !== "preview") {
    throw new Error(
      "jira_release needs a project (argument or [jira] default_project)",
    );
  }

  if (opts.op === "sprints") {
    const boards = await listBoards(jira, project!);
    const sprints = [];
    for (const b of boards) {
      const list = await listSprints(jira, b.id);
      for (const s of list) sprints.push({ ...s, board: b.name });
    }
    return { project, boards, sprints };
  }

  if (opts.op === "preview") {
    if (opts.sprintId == null) {
      throw new Error("preview requires sprintId");
    }
    const issues = await fetchSprintIssues(jira, opts.sprintId);
    return { sprintId: opts.sprintId, issues };
  }

  if (opts.op === "create") {
    const name = opts.name?.trim();
    if (!name) {
      throw new Error(
        "create requires an explicit version name — never derived from the sprint",
      );
    }
    const keys = (opts.keys ?? [])
      .map((k) => normalizeIssueKey(k))
      .filter((k): k is string => Boolean(k));
    if (!keys.length) {
      throw new Error(
        "create requires an explicit keys array — the agent must not choose issues",
      );
    }
    const proj = await resolveProjectId(jira, project!);
    const version = await createVersion(jira, {
      name,
      projectId: proj.id,
      description: opts.description,
    });
    const stamped: Array<{ key: string; ok: boolean; error?: string }> = [];
    for (const key of keys) {
      try {
        await addFixVersion(jira, { key, versionId: version.id });
        stamped.push({ key, ok: true });
      } catch (err) {
        stamped.push({
          key,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      version: {
        id: version.id,
        name: version.name,
        released: false,
        projectId: proj.id,
      },
      stamped,
    };
  }

  // release
  if (!opts.versionId?.trim()) {
    throw new Error("release requires versionId");
  }
  const version = await releaseVersion(jira, {
    id: opts.versionId.trim(),
    releaseDate: opts.releaseDate,
  });
  return { version };
}
