/**
 * Per-harness Access Control Lists (ACLs), app identity validation,
 * tool operation classification, scope/project guards (with symlink resolution),
 * and secret-safe log summaries.
 */
import { realpath } from "node:fs/promises";
import { posix, relative, resolve } from "node:path";
import { scanForSecrets } from "../memory/guard.ts";
import { slugify } from "../vault.ts";

export type AccessMode = "read-write" | "read-only" | "disabled";
export type ScopeFilter = "global" | "project";
export type ToolOperation = "read" | "write";
export type PolicySource = "config" | "override" | "auto";

export const REGISTERED_TOOL_NAMES = [
  "vault_info",
  "search_notes",
  "read_note",
  "remember",
  "get_project_context",
  "bootstrap_context",
  "add_memory",
  "search_memory",
  "list_memories",
  "update_memory",
  "supersede_memory",
  "delete_memory",
  "list_pending_memories",
  "approve_pending_memory",
  "dismiss_pending_memory",
  "ingest_session",
  "consolidate_memories",
  "list_recent",
  "track_tool",
  "resolve_guidance",
  "list_guidance",
  "upsert_guidance",
  "resolve_action",
  "list_actions",
  "jira_assigned",
  "work_today",
  "work_plate",
  "work_log",
  "jira_release",
] as const;

const REGISTERED_TOOL_SET = new Set<string>(REGISTERED_TOOL_NAMES);

export type AppPolicy = {
  app: string;
  enabled: boolean;
  mode: AccessMode;
  readScopes: ScopeFilter[];
  writeScopes: ScopeFilter[];
  /** Empty array or ["*"] allows all projects; otherwise allowlist of canonical project slugs. */
  allowedProjects: string[];
  /** Optional list of MCP tool names denied for this app. "*" denies all tools. */
  deniedTools: string[];
};

export type AppPolicyPatch = {
  enabled?: boolean;
  mode?: AccessMode;
  readScopes?: ScopeFilter[];
  writeScopes?: ScopeFilter[];
  allowedProjects?: string[];
  deniedTools?: string[];
};

export type AppRecord = AppPolicy & {
  source: PolicySource;
  firstSeen: string;
  lastSeen: string;
  updatedAt: string;
};

const APP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const VALID_MODES = new Set<string>(["read-write", "read-only", "disabled"]);
const VALID_SCOPES = new Set<string>(["global", "project"]);

export function validateAppName(raw: string): string {
  const cleaned = raw.trim().toLowerCase();
  if (!APP_NAME_RE.test(cleaned)) {
    throw new Error(
      `Invalid app name "${raw}": expected 1–32 lowercase letters, digits, hyphens, or underscores starting with a letter/digit.`,
    );
  }
  return cleaned;
}

export function normalizeAppNameOrDefault(raw: string | undefined | null, fallback = "anonymous"): string {
  if (!raw || !raw.trim()) return fallback;
  return validateAppName(raw);
}

export function validateAccessMode(raw: unknown, field = "mode"): AccessMode {
  if (typeof raw !== "string" || !VALID_MODES.has(raw)) {
    throw new Error(
      `Invalid ${field} "${String(raw)}": expected "read-write", "read-only", or "disabled".`,
    );
  }
  return raw as AccessMode;
}

export function defaultAppPolicy(app: string, defaultMode: AccessMode = "read-write"): AppPolicy {
  const validMode = validateAccessMode(defaultMode, "default_mode");
  return {
    app: validateAppName(app),
    enabled: validMode !== "disabled",
    mode: validMode,
    readScopes: ["global", "project"],
    writeScopes: validMode === "read-write" ? ["global", "project"] : [],
    allowedProjects: [],
    deniedTools: [],
  };
}

function normalizeScopeList(raw: unknown, field: string): ScopeFilter[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid ${field}: expected an array of "global" | "project".`);
  }
  const out: ScopeFilter[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error(`Invalid ${field} entry: expected string ("global" | "project").`);
    }
    const lower = item.trim().toLowerCase();
    if (!VALID_SCOPES.has(lower)) {
      throw new Error(`Invalid ${field} entry "${item}": expected "global" or "project".`);
    }
    if (!out.includes(lower as ScopeFilter)) {
      out.push(lower as ScopeFilter);
    }
  }
  return out;
}

function normalizeProjectAllowList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid ${field}: expected an array of project slugs (or ["*"]).`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error(`Invalid ${field} entry: expected string.`);
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed === "*") return [];
    const val = slugify(trimmed);
    if (val && !out.includes(val)) out.push(val);
  }
  return out;
}

export function normalizeDeniedToolList(raw: unknown, field = "deniedTools"): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid ${field}: expected an array of MCP tool names (or ["*"]).`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error(`Invalid ${field} entry: expected tool name string.`);
    }
    const trimmed = item.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed === "*") return ["*"];
    if (!REGISTERED_TOOL_SET.has(trimmed)) {
      throw new Error(
        `Unknown tool "${item}" in ${field}. Expected "*" or one of: ${REGISTERED_TOOL_NAMES.join(", ")}`,
      );
    }
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function mergeAppPolicy(base: AppPolicy, patch: AppPolicyPatch): AppPolicy {
  let mode: AccessMode =
    patch.mode !== undefined ? validateAccessMode(patch.mode, "mode") : base.mode;

  const enabled =
    patch.enabled !== undefined
      ? (() => {
          if (typeof patch.enabled !== "boolean") {
            throw new Error(`Invalid enabled value: expected boolean.`);
          }
          return patch.enabled;
        })()
      : mode === "disabled"
        ? false
        : base.enabled;

  // Resuming a previously disabled app without specifying a mode restores read-write
  if (patch.enabled === true && patch.mode === undefined && mode === "disabled") {
    mode = "read-write";
  }

  const readScopes =
    patch.readScopes !== undefined
      ? normalizeScopeList(patch.readScopes, "readScopes")
      : [...base.readScopes];

  let writeScopes =
    patch.writeScopes !== undefined
      ? normalizeScopeList(patch.writeScopes, "writeScopes")
      : [...base.writeScopes];

  // If upgrading from read-only/disabled to read-write without explicitly passing writeScopes,
  // restore default write scopes if they were previously empty.
  if (
    mode === "read-write" &&
    patch.writeScopes === undefined &&
    base.mode !== "read-write" &&
    writeScopes.length === 0
  ) {
    writeScopes = ["global", "project"];
  }

  const allowedProjects =
    patch.allowedProjects !== undefined
      ? normalizeProjectAllowList(patch.allowedProjects, "allowedProjects")
      : [...base.allowedProjects];

  const deniedTools =
    patch.deniedTools !== undefined
      ? normalizeDeniedToolList(patch.deniedTools, "deniedTools")
      : [...base.deniedTools];

  return {
    app: base.app,
    enabled,
    mode,
    readScopes,
    writeScopes,
    allowedProjects,
    deniedTools,
  };
}

export class AclDeniedError extends Error {
  readonly app: string;
  readonly tool: string;
  readonly reason: string;

  constructor(app: string, tool: string, reason: string) {
    super(`ACL denied for app "${app}" on tool "${tool}": ${reason}`);
    this.name = "AclDeniedError";
    this.app = app;
    this.tool = tool;
    this.reason = reason;
  }
}

const WRITE_TOOLS = new Set([
  "remember",
  "add_memory",
  "update_memory",
  "supersede_memory",
  "delete_memory",
  "approve_pending_memory",
  "dismiss_pending_memory",
  "ingest_session",
  "track_tool",
  "upsert_guidance",
]);

const READ_TOOLS = new Set([
  "vault_info",
  "search_notes",
  "read_note",
  "get_project_context",
  "bootstrap_context",
  "search_memory",
  "list_memories",
  "list_pending_memories",
  "list_recent",
  "resolve_guidance",
  "list_guidance",
  "resolve_action",
  "list_actions",
  "jira_assigned",
  "work_plate",
]);

/** Classify an MCP tool invocation as read or write (handles op-dependent tools). */
export function classifyToolOperation(
  tool: string,
  args?: Record<string, unknown>,
): ToolOperation {
  if (WRITE_TOOLS.has(tool)) return "write";
  if (READ_TOOLS.has(tool)) return "read";

  if (tool === "consolidate_memories") {
    return args?.apply === true ? "write" : "read";
  }
  const op = typeof args?.op === "string" ? args.op.trim().toLowerCase() : "";
  if (tool === "work_today") {
    return op === "list" ? "read" : "write";
  }
  if (tool === "work_log") {
    return op === "review" ? "read" : "write";
  }
  if (tool === "jira_release") {
    return op === "sprints" || op === "preview" ? "read" : "write";
  }
  // Fail safe: unknown tools default to write
  return "write";
}

export function checkToolAccess(
  policy: AppPolicy,
  tool: string,
  operation: ToolOperation,
): void {
  if (!policy.enabled || policy.mode === "disabled") {
    throw new AclDeniedError(
      policy.app,
      tool,
      policy.mode === "disabled" ? "app is disabled" : "app is paused",
    );
  }
  if (policy.deniedTools.includes("*") || policy.deniedTools.includes(tool.toLowerCase())) {
    throw new AclDeniedError(policy.app, tool, `tool "${tool}" is explicitly denied`);
  }
  if (operation === "write" && policy.mode === "read-only") {
    throw new AclDeniedError(policy.app, tool, "app has read-only access");
  }
  if (operation === "read" && policy.readScopes.length === 0) {
    throw new AclDeniedError(policy.app, tool, "no readable scopes configured");
  }
  if (operation === "write" && policy.writeScopes.length === 0) {
    throw new AclDeniedError(policy.app, tool, "no writable scopes configured");
  }
}

export function isProjectAllowed(policy: AppPolicy, projectSlug: string | null | undefined): boolean {
  if (!policy.allowedProjects.length) return true;
  if (!projectSlug) return false;
  const canonical = slugify(projectSlug);
  return policy.allowedProjects.includes(canonical);
}

export function canReadTarget(
  policy: AppPolicy,
  scope: ScopeFilter,
  projectSlug?: string | null,
): boolean {
  if (!policy.enabled || policy.mode === "disabled") return false;
  if (!policy.readScopes.includes(scope)) return false;
  if (scope === "project") {
    return isProjectAllowed(policy, projectSlug);
  }
  return true;
}

export function canWriteTarget(
  policy: AppPolicy,
  scope: ScopeFilter,
  projectSlug?: string | null,
): boolean {
  if (!policy.enabled || policy.mode !== "read-write") return false;
  if (!policy.writeScopes.includes(scope)) return false;
  if (scope === "project") {
    return isProjectAllowed(policy, projectSlug);
  }
  return true;
}

export function assertScopeAccess(
  policy: AppPolicy,
  tool: string,
  operation: ToolOperation,
  scope: ScopeFilter,
  projectSlug?: string | null,
): void {
  const allowed =
    operation === "read"
      ? canReadTarget(policy, scope, projectSlug)
      : canWriteTarget(policy, scope, projectSlug);
  if (!allowed) {
    const scopeDesc =
      scope === "project" && projectSlug
        ? `project "${slugify(projectSlug)}"`
        : `${scope} scope`;
    throw new AclDeniedError(
      policy.app,
      tool,
      `${operation} access to ${scopeDesc} is not permitted`,
    );
  }
}

/** Infer scope and project slug from a vault-relative note path (normalizing .. segments safely). */
export function inferNoteScopeAndProject(relPath: string): {
  scope: ScopeFilter;
  project: string | null;
} {
  const normalized = posix.normalize(relPath.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Invalid relative note path: ${relPath}`);
  }
  const m = normalized.match(/^projects\/([^/]+)(?:\/|$)/i);
  if (m && m[1] && m[1] !== "_template") {
    return { scope: "project", project: slugify(m[1]) };
  }
  return { scope: "global", project: null };
}

/**
 * Resolve symlinks via `realpath` before classifying a vault-relative note path,
 * preventing symlinks inside the vault from bypassing project/scope ACLs or escaping the vault.
 */
export async function resolveRealNoteScopeAndProject(
  vaultPath: string,
  relPath: string,
): Promise<{ scope: ScopeFilter; project: string | null }> {
  const lexical = inferNoteScopeAndProject(relPath);
  const absTarget = resolve(vaultPath, relPath.replace(/\\/g, "/").replace(/^\/+/, ""));
  try {
    const [realVault, realTarget] = await Promise.all([
      realpath(vaultPath),
      realpath(absTarget),
    ]);
    const rel = relative(realVault, realTarget).replace(/\\/g, "/");
    if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
      throw new Error(`Path escapes vault via symlink: ${relPath}`);
    }
    return inferNoteScopeAndProject(rel);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return lexical;
    }
    throw err;
  }
}

/** Produce a concise, secret-redacted summary string safe to persist in access_log. */
export function redactLogSummary(raw: string, maxChars = 180): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (scanForSecrets(compact).length > 0) {
    return "[redacted: potential secret]";
  }
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

/** Build a human-readable, secret-safe summary of a tool call's arguments. */
export function summarizeToolCall(tool: string, args?: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return tool;
  const pick = (key: string): string | null => {
    const v = args[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  switch (tool) {
    case "search_notes":
    case "search_memory": {
      const q = pick("query");
      const proj = pick("project");
      const mode = pick("mode");
      return redactLogSummary(
        [q ? `q="${q}"` : null, proj ? `project=${proj}` : null, mode ? `mode=${mode}` : null]
          .filter(Boolean)
          .join(" "),
      );
    }
    case "read_note": {
      const p = pick("path");
      const sec = pick("section");
      return redactLogSummary([p, sec ? `#${sec}` : null].filter(Boolean).join(" "));
    }
    case "add_memory":
    case "remember": {
      const title = pick("title");
      const scope = pick("scope");
      const proj = pick("project");
      const cat = pick("category");
      const content = pick("content");
      if (content && scanForSecrets(content).length > 0) {
        return "[redacted: potential secret]";
      }
      return redactLogSummary(
        [
          title ? `"${title}"` : null,
          proj ? `project=${proj}` : scope ? `scope=${scope}` : null,
          cat ? `cat=${cat}` : null,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    case "update_memory":
    case "delete_memory": {
      const id = pick("id");
      const title = pick("title");
      const content = pick("content");
      if (content && scanForSecrets(content).length > 0) {
        return `[redacted: potential secret]${id ? ` (${id})` : ""}`;
      }
      return redactLogSummary([id, title ? `"${title}"` : null].filter(Boolean).join(" "));
    }
    case "supersede_memory": {
      const oldId = pick("old_id");
      const content = pick("content");
      if (content && scanForSecrets(content).length > 0) {
        return `[redacted: potential secret]${oldId ? ` (${oldId})` : ""}`;
      }
      return redactLogSummary(oldId ? `old_id=${oldId}` : "supersede");
    }
    case "get_project_context":
    case "list_actions":
    case "list_guidance": {
      const proj = pick("project");
      return redactLogSummary(proj ? `project=${proj}` : "global");
    }
    case "list_memories": {
      const scope = pick("scope");
      const proj = pick("project");
      const cat = pick("category");
      const status = pick("status");
      return redactLogSummary(
        [
          proj ? `project=${proj}` : scope ? `scope=${scope}` : null,
          cat ? `cat=${cat}` : null,
          status ? `status=${status}` : null,
        ]
          .filter(Boolean)
          .join(" ") || "all active",
      );
    }
    case "resolve_action": {
      return redactLogSummary(
        [pick("action"), pick("intent"), pick("project") ? `project=${pick("project")}` : null]
          .filter(Boolean)
          .join(" "),
      );
    }
    case "resolve_guidance":
    case "upsert_guidance": {
      const content = pick("content");
      if (content && scanForSecrets(content).length > 0) {
        return "[redacted: potential secret]";
      }
      return redactLogSummary(
        [
          pick("type"),
          pick("kind") ?? pick("workflow_id"),
          pick("project") ? `project=${pick("project")}` : pick("scope"),
          pick("mode"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    case "track_tool": {
      const sum = pick("summary");
      if (sum && scanForSecrets(sum).length > 0) {
        return "[redacted: potential secret]";
      }
      return redactLogSummary(
        [pick("name"), pick("project") ? `project=${pick("project")}` : null]
          .filter(Boolean)
          .join(" "),
      );
    }
    case "bootstrap_context": {
      return redactLogSummary(
        [
          pick("project") ? `project=${pick("project")}` : null,
          pick("task") ? `task="${pick("task")}"` : null,
        ]
          .filter(Boolean)
          .join(" ") || "global",
      );
    }
    case "list_pending_memories": {
      return redactLogSummary(
        [
          pick("status") ? `status=${pick("status")}` : null,
          pick("project") ? `project=${pick("project")}` : null,
        ]
          .filter(Boolean)
          .join(" ") || "pending",
      );
    }
    case "approve_pending_memory":
    case "dismiss_pending_memory": {
      const content = pick("content");
      if (content && scanForSecrets(content).length > 0) {
        return "[redacted: potential secret]";
      }
      return redactLogSummary([pick("id"), pick("title") ? `"${pick("title")}"` : null].filter(Boolean).join(" "));
    }
    case "consolidate_memories": {
      const apply = args.apply === true ? "apply" : "dry-run";
      return redactLogSummary(
        [apply, pick("project") ? `project=${pick("project")}` : null].filter(Boolean).join(" "),
      );
    }
    case "work_today":
    case "work_log":
    case "jira_release": {
      return redactLogSummary(
        [pick("op") ? `op=${pick("op")}` : null, pick("key") ?? pick("name")]
          .filter(Boolean)
          .join(" "),
      );
    }
    default:
      return redactLogSummary(tool);
  }
}
