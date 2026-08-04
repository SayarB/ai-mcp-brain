/** Work-desk types (today list + Jira cache). */

export type TodayItem = {
  done: boolean;
  /** Normalized key without provider prefix, e.g. AD-206 */
  key?: string;
  /** Original key token including optional jira: prefix */
  keyRaw?: string;
  note: string;
  /** Full checklist line without leading `- [ ]` / `- [x]` */
  rest: string;
};

export type JiraIssueRow = {
  key: string;
  summary: string;
  status: string;
  url: string;
  updated: string;
};

export type JiraCacheFile = {
  version: number;
  fetched_at: string;
  filter: string;
  issues: JiraIssueRow[];
};

export const JIRA_CACHE_VERSION = 1;
export const JIRA_CACHE_TTL_MS = 60 * 60 * 1000;

/** Default: mine, not Done, in an open sprint (not the full backlog of assignments). */
export const DEFAULT_JIRA_JQL =
  "assignee = currentUser() AND statusCategory != Done AND sprint in openSprints()";

/** Full assigned open list — only when user asks for all / outside sprints. */
export const ALL_ASSIGNED_JIRA_JQL =
  "assignee = currentUser() AND statusCategory != Done";

export const WORK_TODAY_REL = "work/today.md";
export const WORK_CACHE_REL = "work/cache/jira-assigned.json";
export const WORK_LOG_DIR_REL = "work/log";
