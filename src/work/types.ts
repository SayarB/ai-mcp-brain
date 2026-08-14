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

/* ── Day ledger (activity events → derived blocks → Jira worklogs) ────────── */

export type LedgerEventKind =
  | "session-start"
  | "session-end"
  | "note"
  | "commit"
  | "done"
  | "focus";

export type LedgerEvent = {
  /** Epoch ms, resolved from the ledger's date + the line's HH:MM. */
  at: number;
  /** Local time as written, HH:MM. */
  time: string;
  kind: LedgerEventKind;
  /** Only ever a user-supplied key — never derived from text or branch. */
  key?: string;
  /** Session/conversation id, so parallel threads stay separable. */
  session?: string;
  text: string;
  raw: string;
};

export type DerivedBlock = {
  /** Undefined = unattributed; the user assigns a key at review. */
  key?: string;
  /** Bucket minutes, split across tasks sharing a bucket (may be fractional). */
  minutes: number;
  buckets: number;
  /** True when at least one bucket was shared with another task. */
  shared: boolean;
  first: string;
  last: string;
  evidence: string[];
  /** Display-only sparsity hint. Never feeds pushed minutes. */
  estimate_note?: string;
};

export type PushEntry = {
  key: string;
  minutes: number;
  comment?: string;
};

export type PushReceipt = {
  key: string;
  minutes: number;
  worklog_id: string;
  at: string;
};

/**
 * Time is measured as *activity*, not elapsed span: the day is sliced into
 * buckets and only buckets containing an event count. Parallel work splits a
 * shared bucket instead of double-counting it, so no idle threshold is needed
 * and an abandoned open session costs nothing.
 */
export const WORK_BUCKET_MS = 15 * 60 * 1000;

/** Refuse rather than truncate: a silently capped day hides derivation bugs. */
export const WORK_ABSURD_MS = 12 * 60 * 60 * 1000;

export const WORK_RECEIPTS_HEADING = "## Pushed to Jira";
