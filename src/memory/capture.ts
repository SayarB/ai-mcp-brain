/**
 * Passive session capture & Pending Approval Queue promotion.
 *
 * Extracts durable candidate memories (decisions, preferences, gotchas, facts)
 * deterministically offline from session summaries, transcripts, and/or recent git commits.
 * Every candidate is secret-scanned and deduplicated ONLY within its own `(scope, project)`
 * bucket (and readable ACL scope) BEFORE staging into `pending_memories`.
 */
import { basename } from "node:path";
import {
  PendingStateConflictError,
  type DaemonStateStore,
  type PendingMemoryRecord,
} from "../daemon/state.ts";
import { tokenizeForFts, type Embedder } from "../index/index.ts";
import { resolveProjectSlug } from "../vault.ts";
import {
  harvestDayCommits,
  readGitUserEmail,
  type HarvestedCommit,
} from "../work/git.ts";
import { addMemorySmart, type AddMemorySmartResult } from "./extract.ts";
import { scanForSecrets } from "./guard.ts";
import {
  listMemories,
  type MemoryCategory,
  type MemoryScope,
} from "./store.ts";

export type ExtractedCandidate = {
  title: string;
  content: string;
  scope: MemoryScope;
  project: string | null;
  category: MemoryCategory;
  tags: string[];
  reason: string;
  confidence: number;
};

export type SessionIngestInput = {
  /** Free-form session summary, notes, or transcript snippet. */
  summary?: string;
  /** Optional raw transcript lines. */
  transcript?: string;
  /** Optional git diff or commit messages text. */
  diff?: string;
  /** Explicit commit subjects/messages to inspect. */
  commits?: string[];
  /** Optional working directory; if given, harvests today's own git commits & infers project slug. */
  cwd?: string;
  /** Optional git repo slug/path/remote override. */
  project?: string;
  /** Source harness name (e.g. cursor, claude, codex, hook). */
  app?: string;
  /** Session or conversation ID for provenance. */
  session?: string;
  /** Max candidates to stage from one session (default 8). */
  maxCandidates?: number;
  /** Optional write-ACL filter applied before dedup/staging each candidate. */
  allowCandidate?: (candidate: ExtractedCandidate) => boolean;
  /** Optional read-ACL filter controlling which buckets may be consulted for duplicate checks. */
  canReadScope?: (scope: MemoryScope, project: string | null) => boolean;
};

export type SessionIngestResult = {
  staged: PendingMemoryRecord[];
  skippedDuplicates: number;
  skippedSecrets: number;
  skippedByPolicy: number;
  totalExtracted: number;
};

const EPHEMERAL_NOISE_RE =
  /^(?:ok|okay|sure|thanks|thank you|got it|sounds good|lgtm|done|yes|no|let me check|checking|running tests?|building|compiling|looking at|reading|searching|here is|here's|wip|merge branch|merge pull request|fix typo|formatting|lint fix)\b/i;

const SIGNAL_RULES: {
  category: MemoryCategory;
  reason: string;
  confidence: number;
  regex: RegExp;
  preferGlobal?: boolean;
}[] = [
  {
    category: "decisions",
    reason: "explicit architecture/decision signal",
    confidence: 0.88,
    regex:
      /\b(?:decided to\b|decision:|adr:|switched (?:from .+ )?to\b|migrated (?:from .+ )?to\b|chose\b|chosen:|we use .+ instead of\b|replaced .+ with\b|standardized on\b)/i,
  },
  {
    category: "gotchas",
    reason: "gotcha/root-cause signal",
    confidence: 0.86,
    regex:
      /\b(?:gotcha:|pitfall:|caveat:|workaround:|root cause:|watch out\b|beware\b|important:|fails when\b|breaks when\b|do not forget\b|must not\b|never commit\b|avoid doing\b)/i,
  },
  {
    category: "preferences",
    reason: "standing preference/convention signal",
    confidence: 0.84,
    preferGlobal: true,
    regex:
      /\b(?:prefer(?:s|red)?\b|always use\b|never use\b|from now on\b|default to\b|convention:|style rule:|standing preference\b)/i,
  },
  {
    category: "facts",
    reason: "durable technical constraint/fact",
    confidence: 0.72,
    regex:
      /\b(?:requires\b|must run\b|runs on\b|listens on\b|stored in\b|configured via\b|deployed (?:on|to)\b|backed by\b|uses (?:sqlite|postgres|redis|bun|node|docker|oauth|jwt|grpc|graphql)\b)/i,
  },
];

const NOISY_COMMIT_RE =
  /^(?:wip\b|merge\b|revert\b|bump\b|chore\(deps\)|fixup!|squash!|style:|fmt\b|format\b|typo\b|lint\b)/i;

function localDateIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeForDedup(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a: string, b: string): number {
  const sa = new Set(tokenizeForFts(a));
  const sb = new Set(tokenizeForFts(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

function isNearDuplicateText(a: string, b: string): boolean {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 24 && nb.length >= 24 && (na.includes(nb) || nb.includes(na))) {
    return true;
  }
  return jaccard(a, b) >= 0.78;
}

function buildConciseTitle(text: string, fallbackPrefix: string): string {
  const cleaned = text
    .replace(/^(?:[-*•]\s+|\d+\.\s+)/, "")
    .replace(/^(?:decision|gotcha|pitfall|caveat|workaround|root cause|important|note|preference|convention|adr)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const firstClause = cleaned.split(/[.;—–\n]/)[0]?.trim() || cleaned;
  const base = firstClause.length >= 8 ? firstClause : cleaned;
  if (!base) return fallbackPrefix;
  if (base.length <= 72) return base;
  return `${base.slice(0, 69).replace(/\s+\S*$/, "")}…`;
}

function splitCandidateUnits(text: string): string[] {
  const units: string[] = [];
  const withoutFences = text.replace(/```[\s\S]*?```/g, "\n").replace(/~~~[\s\S]*?~~~/g, "\n");
  for (const rawLine of withoutFences.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*•>]+|\d+\.)\s*/, "").trim();
    if (line.length < 20 || line.length > 600) continue;
    if (line.startsWith("#")) continue;
    if (/^\s*at\s+\S+\s+\(/.test(line) || /^(?:Error|TypeError|ReferenceError):/.test(line)) {
      continue;
    }
    if (line.length <= 280) {
      units.push(line);
      continue;
    }
    for (const sentence of line.split(/(?<=[.!])\s+(?=[A-Z])/)) {
      const s = sentence.trim();
      if (s.length >= 20 && s.length <= 360) units.push(s);
    }
  }
  return units;
}

/**
 * Deterministically extract durable memory candidates from session text and/or git commits.
 * Automatically drops secrets and noisy ephemeral lines.
 */
export function extractSessionCandidates(opts: {
  summary?: string;
  transcript?: string;
  commits?: string[];
  project?: string | null;
  maxCandidates?: number;
}): { candidates: ExtractedCandidate[]; skippedSecrets: number } {
  const maxCandidates = Math.min(20, Math.max(1, Math.trunc(opts.maxCandidates ?? 8)));
  const project = opts.project?.trim() || null;
  const extracted: ExtractedCandidate[] = [];
  let skippedSecrets = 0;

  const tryPush = (cand: ExtractedCandidate): void => {
    if (scanForSecrets(cand.title, cand.content).length > 0) {
      skippedSecrets++;
      return;
    }
    if (
      extracted.some(
        (e) =>
          e.scope === cand.scope &&
          e.project === cand.project &&
          isNearDuplicateText(`${e.title} ${e.content}`, `${cand.title} ${cand.content}`),
      )
    ) {
      return;
    }
    extracted.push(cand);
  };

  const combinedText = [opts.summary, opts.transcript].filter(Boolean).join("\n");
  for (const unit of splitCandidateUnits(combinedText)) {
    if (unit.endsWith("?")) continue;
    if (EPHEMERAL_NOISE_RE.test(unit)) continue;
    if (scanForSecrets(unit).length > 0) {
      skippedSecrets++;
      continue;
    }

    for (const rule of SIGNAL_RULES) {
      if (!rule.regex.test(unit)) continue;
      const scope: MemoryScope =
        project && !rule.preferGlobal
          ? "project"
          : project && /\b(?:this repo|in this project|for this service)\b/i.test(unit)
            ? "project"
            : rule.preferGlobal
              ? "global"
              : project
                ? "project"
                : "global";
      tryPush({
        title: buildConciseTitle(unit, `${rule.category} note`),
        content: unit,
        scope,
        project: scope === "project" ? project : null,
        category: rule.category,
        tags: ["captured"],
        reason: rule.reason,
        confidence: rule.confidence,
      });
      break;
    }
  }

  for (const rawSubject of opts.commits ?? []) {
    const subject = rawSubject.replace(/\s+/g, " ").trim();
    if (subject.length < 18 || subject.length > 260) continue;
    if (NOISY_COMMIT_RE.test(subject)) continue;
    if (scanForSecrets(subject).length > 0) {
      skippedSecrets++;
      continue;
    }

    const isFix =
      /^(?:fix|bugfix|hotfix)\b/i.test(subject) ||
      /\b(?:race|deadlock|leak|bypass|traversal|corruption)\b/i.test(subject);
    const isArch =
      /^(?:feat|refactor|perf|arch)\b/i.test(subject) ||
      /\b(?:migrate|switch|replace|add|implement|enforce)\b/i.test(subject);
    if (!isFix && !isArch) continue;

    const category: MemoryCategory = isFix ? "gotchas" : "decisions";
    const scope: MemoryScope = project ? "project" : "global";
    tryPush({
      title: buildConciseTitle(subject.replace(/^[a-z]+(?:\([^)]*\))?:\s*/i, ""), "Commit learning"),
      content: `Commit: ${subject}`,
      scope,
      project: scope === "project" ? project : null,
      category,
      tags: ["captured", "git"],
      reason: "git commit signal",
      confidence: 0.65,
    });
  }

  extracted.sort((a, b) => b.confidence - a.confidence);
  return {
    candidates: extracted.slice(0, maxCandidates),
    skippedSecrets,
  };
}

function scopeKey(scope: MemoryScope, project: string | null): string {
  return `${scope}|${scope === "project" ? (project ?? "") : ""}`;
}

/**
 * Extract candidates from session input (+ optional today's local-time own git commits in `cwd`),
 * deduplicate ONLY within the candidate's own `(scope, project)` bucket (and readable ACL scope),
 * and stage into `pending_memories`.
 */
export async function ingestSessionToPending(
  vaultPath: string,
  stateStore: DaemonStateStore,
  input: SessionIngestInput,
): Promise<SessionIngestResult> {
  let resolvedProject: string | null = null;
  if (input.project?.trim()) {
    resolvedProject = await resolveProjectSlug(vaultPath, input.project.trim());
  } else if (input.cwd?.trim()) {
    const inferredName = basename(input.cwd.trim());
    if (inferredName) {
      resolvedProject = await resolveProjectSlug(vaultPath, input.cwd.trim());
    }
  }

  const commits: string[] = [...(input.commits ?? [])];
  if (input.cwd?.trim()) {
    const todayLocal = localDateIso();
    const authorEmail = await readGitUserEmail(input.cwd.trim());
    const harvested: HarvestedCommit[] = await harvestDayCommits(
      input.cwd.trim(),
      todayLocal,
      authorEmail ? { authorEmail } : undefined,
    );
    for (const c of harvested) {
      if (c.subject) commits.push(c.subject);
    }
  }

  const { candidates, skippedSecrets } = extractSessionCandidates({
    summary: input.summary,
    transcript: input.transcript,
    commits,
    project: resolvedProject,
    maxCandidates: input.maxCandidates,
  });

  if (!candidates.length) {
    return {
      staged: [],
      skippedDuplicates: 0,
      skippedSecrets,
      skippedByPolicy: 0,
      totalExtracted: 0,
    };
  }

  // Group existing pending + active vault memories strictly by (scope, project) bucket so dedup
  // never crosses project boundaries or leaks existence of memories from another project!
  const existingPending = stateStore.listPendingMemories({ status: "pending", limit: 200 });
  const existingActive = await listMemories(vaultPath, { status: "active", limit: 400 });
  const buckets = new Map<string, string[]>();
  const addToBucket = (scope: MemoryScope, project: string | null, text: string) => {
    const key = scopeKey(scope, project);
    const list = buckets.get(key) ?? [];
    list.push(text);
    buckets.set(key, list);
  };
  for (const p of existingPending) {
    addToBucket(p.scope, p.project, `${p.title} ${p.content}`);
  }
  for (const m of existingActive) {
    addToBucket(m.scope, m.project, `${m.title} ${m.content}`);
  }

  const staged: PendingMemoryRecord[] = [];
  let skippedDuplicates = 0;
  let skippedByPolicy = 0;

  for (const cand of candidates) {
    if (input.allowCandidate && !input.allowCandidate(cand)) {
      skippedByPolicy++;
      continue;
    }
    const candText = `${cand.title} ${cand.content}`;
    const mayCheckDedup = !input.canReadScope || input.canReadScope(cand.scope, cand.project);
    const key = scopeKey(cand.scope, cand.project);
    const bucket = mayCheckDedup ? (buckets.get(key) ?? []) : [];

    if (mayCheckDedup && bucket.some((ex) => isNearDuplicateText(ex, candText))) {
      skippedDuplicates++;
      continue;
    }
    const rec = stateStore.stagePendingMemory({
      title: cand.title,
      content: cand.content,
      scope: cand.scope,
      project: cand.project,
      category: cand.category,
      app: input.app ?? "hook",
      tags: cand.tags,
      sourceSession: input.session ?? null,
      reason: cand.reason,
      confidence: cand.confidence,
    });
    staged.push(rec);
    addToBucket(cand.scope, cand.project, candText);
  }

  return {
    staged,
    skippedDuplicates,
    skippedSecrets,
    skippedByPolicy,
    totalExtracted: candidates.length,
  };
}

export type ApprovePendingOverrides = {
  title?: string;
  content?: string;
  scope?: MemoryScope;
  project?: string;
  category?: MemoryCategory;
  tags?: string[];
  app?: string;
  indexDbPath?: string;
  embedder?: Embedder | null;
  /** Override stale `approving` reclaim threshold in ms (default 5 min). */
  staleAfterMs?: number;
};

/** Atomically claim a pending candidate, promote it to vault Markdown via `addMemorySmart`, and mark approved. */
export async function approvePendingMemory(
  vaultPath: string,
  stateStore: DaemonStateStore,
  pendingId: string,
  overrides: ApprovePendingOverrides = {},
): Promise<{ pending: PendingMemoryRecord; promoted: AddMemorySmartResult }> {
  const claimed = stateStore.claimPendingMemory(pendingId, {
    staleAfterMs: overrides.staleAfterMs,
  });
  if (!claimed) {
    const existing = stateStore.getPendingMemory(pendingId);
    if (!existing) {
      throw new Error(`Pending memory not found: ${pendingId}`);
    }
    throw new PendingStateConflictError(pendingId, existing.status, "approve");
  }

  try {
    const scope = overrides.scope ?? claimed.scope;
    const project =
      scope === "project"
        ? (overrides.project?.trim() || claimed.project || undefined)
        : undefined;
    if (scope === "project" && !project) {
      throw new Error("Project slug is required when approving a project-scoped memory.");
    }
    const promoted = await addMemorySmart(vaultPath, {
      title: overrides.title?.trim() || claimed.title,
      content: overrides.content?.trim() || claimed.content,
      scope,
      project,
      category: overrides.category ?? claimed.category,
      app: overrides.app?.trim() || claimed.app,
      tags: overrides.tags ?? claimed.tags,
      dbPath: overrides.indexDbPath,
      embedder: overrides.embedder,
    });
    const pending = stateStore.completePendingApproval(claimed.id, promoted.memory.id);
    return { pending, promoted };
  } catch (err) {
    stateStore.revertPendingClaim(claimed.id);
    throw err;
  }
}
