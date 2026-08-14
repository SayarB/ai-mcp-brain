import { localDateString } from "../work/today.ts";
import type { JiraRuntimeConfig } from "./client.ts";

export type JiraFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

let fetchImpl: JiraFetch = globalThis.fetch;

/** Test seam — restore with `resetJiraFetch()`. */
export function setJiraFetch(fn: JiraFetch): void {
  fetchImpl = fn;
}
export function resetJiraFetch(): void {
  fetchImpl = globalThis.fetch;
}

export function adfDoc(text: string): {
  type: "doc";
  version: 1;
  content: unknown[];
} {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: text.trim()
          ? [{ type: "text", text: text.trim() }]
          : [],
      },
    ],
  };
}

export function authHeader(cfg: JiraRuntimeConfig): string {
  return `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64")}`;
}

export class JiraRequestError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, hint?: string) {
    super(hint ?? `Jira request failed (${status}): ${body.slice(0, 240)}`);
    this.name = "JiraRequestError";
    this.status = status;
    this.body = body;
  }
}

export async function jiraRequest<T = unknown>(
  cfg: JiraRuntimeConfig,
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | undefined>;
  } = {},
): Promise<T> {
  const url = new URL(
    path.startsWith("http") ? path : `${cfg.baseUrl}${path}`,
  );
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  const res = await fetchImpl(url.toString(), {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      Authorization: authHeader(cfg),
      Accept: "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data: T | { errorMessages?: string[]; errors?: Record<string, string> } =
    {} as T;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      if (!res.ok) throw new JiraRequestError(res.status, text);
      throw new JiraRequestError(res.status, text, `Jira returned non-JSON (${res.status})`);
    }
  }
  if (!res.ok) {
    const parsed = data as {
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    const msg =
      parsed.errorMessages?.join("; ") ||
      (parsed.errors && Object.values(parsed.errors).join("; ")) ||
      text.slice(0, 240);
    throw new JiraRequestError(res.status, text, `Jira request failed (${res.status}): ${msg}`);
  }
  return data as T;
}

export async function postWorklog(
  cfg: JiraRuntimeConfig,
  opts: { key: string; seconds: number; comment?: string; started?: string },
): Promise<{ id: string }> {
  const body: Record<string, unknown> = {
    timeSpentSeconds: opts.seconds,
    comment: adfDoc(opts.comment ?? ""),
  };
  if (opts.started) body.started = opts.started;
  const data = await jiraRequest<{ id?: string }>(
    cfg,
    `/rest/api/3/issue/${encodeURIComponent(opts.key)}/worklog`,
    { method: "POST", body },
  );
  if (!data.id) throw new Error(`Jira worklog POST returned no id for ${opts.key}`);
  return { id: data.id };
}

export async function createIssue(
  cfg: JiraRuntimeConfig,
  opts: { project: string; issueType: string; summary: string },
): Promise<{ key: string; id: string }> {
  const data = await jiraRequest<{ key?: string; id?: string }>(
    cfg,
    "/rest/api/3/issue",
    {
      method: "POST",
      body: {
        fields: {
          project: { key: opts.project },
          issuetype: { name: opts.issueType },
          summary: opts.summary,
        },
      },
    },
  );
  if (!data.key || !data.id) {
    throw new Error("Jira create issue returned no key");
  }
  return { key: data.key, id: data.id };
}

export async function resolveProjectId(
  cfg: JiraRuntimeConfig,
  projectKey: string,
): Promise<{ id: number; key: string; name: string }> {
  const data = await jiraRequest<{ id?: string; key?: string; name?: string }>(
    cfg,
    `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
  );
  const id = Number(data.id);
  if (!Number.isFinite(id)) {
    throw new Error(`Jira project ${projectKey} has no numeric id`);
  }
  return { id, key: data.key ?? projectKey, name: data.name ?? projectKey };
}

export type JiraVersion = {
  id: string;
  name: string;
  released: boolean;
  projectId?: number;
};

export async function createVersion(
  cfg: JiraRuntimeConfig,
  opts: { name: string; projectId: number; description?: string },
): Promise<JiraVersion> {
  try {
    const data = await jiraRequest<JiraVersion>(cfg, "/rest/api/3/version", {
      method: "POST",
      body: {
        name: opts.name,
        projectId: opts.projectId,
        released: false,
        archived: false,
        ...(opts.description ? { description: opts.description } : {}),
      },
    });
    return data;
  } catch (err) {
    if (err instanceof JiraRequestError && (err.status === 403 || err.status === 404)) {
      throw new JiraRequestError(
        err.status,
        err.body,
        `Cannot create version (${err.status}). This needs the *Manage Versions* or *Administer Projects* permission on the project. ${err.message}`,
      );
    }
    throw err;
  }
}

export async function addFixVersion(
  cfg: JiraRuntimeConfig,
  opts: { key: string; versionId: string },
): Promise<void> {
  await jiraRequest(cfg, `/rest/api/3/issue/${encodeURIComponent(opts.key)}`, {
    method: "PUT",
    body: {
      update: { fixVersions: [{ add: { id: opts.versionId } }] },
    },
  });
}

export async function releaseVersion(
  cfg: JiraRuntimeConfig,
  opts: { id: string; releaseDate?: string },
): Promise<JiraVersion> {
  return jiraRequest<JiraVersion>(
    cfg,
    `/rest/api/3/version/${encodeURIComponent(opts.id)}`,
    {
      method: "PUT",
      body: {
        released: true,
        releaseDate: opts.releaseDate ?? localDateString(),
      },
    },
  );
}

export type JiraSprint = {
  id: number;
  name: string;
  state: string;
  boardId?: number;
};

export async function listBoards(
  cfg: JiraRuntimeConfig,
  projectKey: string,
): Promise<Array<{ id: number; name: string }>> {
  const data = await jiraRequest<{
    values?: Array<{ id: number; name: string }>;
  }>(cfg, "/rest/agile/1.0/board", {
    query: { projectKeyOrId: projectKey },
  });
  return data.values ?? [];
}

export async function listSprints(
  cfg: JiraRuntimeConfig,
  boardId: number,
): Promise<JiraSprint[]> {
  const data = await jiraRequest<{
    values?: Array<{ id: number; name: string; state: string }>;
  }>(cfg, `/rest/agile/1.0/board/${boardId}/sprint`, {
    query: { state: "active,closed,future" },
  });
  return (data.values ?? []).map((s) => ({ ...s, boardId }));
}

export async function fetchSprintIssues(
  cfg: JiraRuntimeConfig,
  sprintId: number,
): Promise<Array<{ key: string; summary: string; status: string }>> {
  const issues: Array<{ key: string; summary: string; status: string }> = [];
  let startAt = 0;
  for (let page = 0; page < 10; page++) {
    const data = await jiraRequest<{
      issues?: Array<{
        key: string;
        fields?: { summary?: string; status?: { name?: string } };
      }>;
      maxResults?: number;
      total?: number;
    }>(cfg, `/rest/agile/1.0/sprint/${sprintId}/issue`, {
      query: {
        startAt: String(startAt),
        maxResults: "50",
        fields: "summary,status",
      },
    });
    const batch = data.issues ?? [];
    for (const iss of batch) {
      issues.push({
        key: iss.key,
        summary: iss.fields?.summary ?? "",
        status: iss.fields?.status?.name ?? "",
      });
    }
    startAt += batch.length;
    if (
      !batch.length ||
      batch.length < 50 ||
      (data.total !== undefined && startAt >= data.total)
    ) {
      break;
    }
  }
  return issues;
}

export type ExistingWorklog = {
  id: string;
  key: string;
  minutes: number;
  started: string;
  comment: string;
  author: string;
};

function worklogCommentText(comment: unknown): string {
  if (typeof comment === "string") return comment;
  if (!comment || typeof comment !== "object") return "";
  const bits: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const o = n as { text?: string; content?: unknown[] };
    if (typeof o.text === "string") bits.push(o.text);
    for (const c of o.content ?? []) walk(c);
  };
  walk(comment);
  return bits.join(" ").trim();
}

function startedOnDate(started: string, date: string): boolean {
  const t = Date.parse(started);
  if (Number.isNaN(t)) return started.startsWith(date);
  return localDateString(new Date(t)) === date;
}

function authorMatches(
  author: { emailAddress?: string; accountId?: string } | undefined,
  email: string,
): boolean {
  if (!author) return false;
  if (author.emailAddress && author.emailAddress.toLowerCase() === email.toLowerCase()) {
    return true;
  }
  return false;
}

/**
 * Current user's worklogs whose `started` falls on `date` (local calendar).
 * Throws on network/API failure — callers must not push if this fails.
 */
export async function fetchMyWorklogsOnDate(
  cfg: JiraRuntimeConfig,
  date: string,
): Promise<ExistingWorklog[]> {
  const jql = `worklogAuthor = currentUser() AND worklogDate = "${date}"`;
  const keys: string[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const body: Record<string, unknown> = {
      jql,
      maxResults: 100,
      fields: ["summary"],
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await jiraRequest<{
      issues?: Array<{ key: string }>;
      nextPageToken?: string;
    }>(cfg, "/rest/api/3/search/jql", { method: "POST", body });
    for (const iss of data.issues ?? []) keys.push(iss.key);
    nextPageToken = data.nextPageToken;
    if (!nextPageToken) break;
  }

  const out: ExistingWorklog[] = [];
  for (const key of keys) {
    const data = await jiraRequest<{
      worklogs?: Array<{
        id?: string;
        timeSpentSeconds?: number;
        started?: string;
        comment?: unknown;
        author?: { emailAddress?: string; displayName?: string };
      }>;
    }>(cfg, `/rest/api/3/issue/${encodeURIComponent(key)}/worklog`);
    for (const w of data.worklogs ?? []) {
      if (!w.started || !startedOnDate(w.started, date)) continue;
      if (!authorMatches(w.author, cfg.email)) continue;
      out.push({
        id: w.id ?? "",
        key,
        minutes: Math.round((w.timeSpentSeconds ?? 0) / 60),
        started: w.started,
        comment: worklogCommentText(w.comment),
        author: w.author?.emailAddress ?? w.author?.displayName ?? "",
      });
    }
  }
  return out;
}

export function minutesByKey(logs: ExistingWorklog[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of logs) {
    m.set(l.key, (m.get(l.key) ?? 0) + l.minutes);
  }
  return m;
}
