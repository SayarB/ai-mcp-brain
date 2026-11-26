/**
 * Token-budgeted, ACL-aware session-start briefing (`bootstrap_context`).
 * Combines global standing preferences/profile, project active memories & pack highlights,
 * optional task-relevant hybrid recall, and pending review count in a single call.
 */
import {
  canReadTarget,
  resolveRealNoteScopeAndProject,
  type AppPolicy,
} from "../daemon/acl.ts";
import type { DaemonStateStore } from "../daemon/state.ts";
import {
  searchHybrid,
  type Embedder,
  type HybridSearchHit,
} from "../index/index.ts";
import {
  getProjectContext,
  noteToTailSummary,
  resolveProjectSlug,
} from "../vault.ts";
import { searchMemories, type MemorySearchHit } from "./extract.ts";
import { listMemories, type AtomicMemory } from "./store.ts";

export type BootstrapContextOptions = {
  project?: string;
  task?: string;
  maxChars?: number;
  includeGlobal?: boolean;
  /** Optional ACL policy enforced when invoked through the HTTP daemon. */
  policy?: AppPolicy | null;
  /** Optional daemon state store (used to report pending memory count). */
  stateStore?: DaemonStateStore;
  indexDbPath?: string;
  embedder?: Embedder | null;
};

export type BootstrapContextResult = {
  project: string | null;
  globalMemories: AtomicMemory[];
  projectMemories: AtomicMemory[];
  taskMemoryHits: MemorySearchHit[];
  taskNoteHits: HybridSearchHit[];
  projectNotesIncluded: string[];
  pendingCount: number;
  markdown: string;
};

async function canReadRealPath(
  vaultPath: string,
  policy: AppPolicy | null | undefined,
  relPath: string,
): Promise<boolean> {
  if (!policy) return true;
  try {
    const real = await resolveRealNoteScopeAndProject(vaultPath, relPath);
    return canReadTarget(policy, real.scope, real.project);
  } catch {
    return false;
  }
}

function formatMemLine(m: AtomicMemory, maxBodyChars = 220): string {
  const compact = m.content.replace(/\s+/g, " ").trim();
  const body =
    compact.length > maxBodyChars ? `${compact.slice(0, maxBodyChars - 1)}…` : compact;
  const tagStr = m.tags.length ? ` #${m.tags.join(" #")}` : "";
  return `- [${m.id}] **${m.title}** (${m.category}, ${m.updated}${tagStr}): ${body}`;
}

export async function bootstrapContext(
  vaultPath: string,
  opts: BootstrapContextOptions = {},
): Promise<BootstrapContextResult> {
  const policy = opts.policy ?? null;
  const maxChars = Math.min(32_000, Math.max(800, Math.trunc(opts.maxChars ?? 6000)));
  const includeGlobal =
    opts.includeGlobal !== false && (!policy || canReadTarget(policy, "global"));

  const canonicalProject = opts.project?.trim()
    ? await resolveProjectSlug(vaultPath, opts.project.trim())
    : null;
  const canReadProject = Boolean(
    canonicalProject && (!policy || canReadTarget(policy, "project", canonicalProject)),
  );

  // 1. Global standing profile + preferences (highest-signal global memories)
  let globalMemories: AtomicMemory[] = [];
  if (includeGlobal) {
    const allGlobal = await listMemories(vaultPath, {
      scope: "global",
      status: "active",
      limit: 30,
    });
    const priorityOrder: Record<string, number> = {
      profile: 0,
      preferences: 1,
      decisions: 2,
      gotchas: 3,
      facts: 4,
    };
    globalMemories = allGlobal
      .sort((a, b) => {
        const pa = priorityOrder[a.category] ?? 9;
        const pb = priorityOrder[b.category] ?? 9;
        if (pa !== pb) return pa - pb;
        return b.updated.localeCompare(a.updated);
      })
      .slice(0, 12);
  }

  // 2. Project active memories & key pack notes (never creates files on disk)
  let projectMemories: AtomicMemory[] = [];
  const projectNotesIncluded: string[] = [];
  const projectNoteExcerpts: { path: string; summary: string }[] = [];

  if (canonicalProject && canReadProject) {
    const rawProjMems = await listMemories(vaultPath, {
      scope: "project",
      project: canonicalProject,
      status: "active",
      limit: 15,
    });
    projectMemories = policy
      ? rawProjMems.filter((m) => canReadTarget(policy, m.scope, m.project))
      : rawProjMems;

    const { notes } = await getProjectContext(vaultPath, canonicalProject, 12, {
      createIfMissing: false,
    });
    // Prioritize README, decisions, gotchas, then tools (skip memories.md — already listed above)
    const noteOrder = (p: string): number => {
      if (p.endsWith("/README.md")) return 0;
      if (p.endsWith("/decisions.md")) return 1;
      if (p.endsWith("/gotchas.md")) return 2;
      if (p.endsWith("/tools.md")) return 3;
      return 4;
    };
    const sortedNotes = notes
      .filter((n) => !/^projects\/[^/]+\/memories\.md$/.test(n.path))
      .sort((a, b) => noteOrder(a.path) - noteOrder(b.path));

    for (const n of sortedNotes) {
      if (projectNoteExcerpts.length >= 4) break;
      if (!(await canReadRealPath(vaultPath, policy, n.path))) continue;
      // Skip bare template-only files with minimal content
      const plainLen = n.body.replace(/^---[\s\S]*?---/, "").trim().length;
      if (plainLen < 24) continue;
      projectNotesIncluded.push(n.path);
      projectNoteExcerpts.push({
        path: n.path,
        summary: noteToTailSummary(n, 900),
      });
    }
  }

  // 3. Task-focused semantic recall (when task is provided and at least one scope is readable)
  let taskMemoryHits: MemorySearchHit[] = [];
  let taskNoteHits: HybridSearchHit[] = [];
  const task = opts.task?.trim();
  if (task && (includeGlobal || canReadProject)) {
    const memSearch = await searchMemories(vaultPath, task, {
      limit: 10,
      project: canReadProject && !includeGlobal ? canonicalProject! : undefined,
      scope: !includeGlobal && canReadProject ? "project" : includeGlobal && !canReadProject ? "global" : undefined,
      status: "active",
      dbPath: opts.indexDbPath,
      embedder: opts.embedder,
    });
    const seenIds = new Set([
      ...globalMemories.map((m) => m.id),
      ...projectMemories.map((m) => m.id),
    ]);
    taskMemoryHits = memSearch.hits
      .filter((h) => {
        if (seenIds.has(h.memory.id)) return false;
        if (!includeGlobal && h.memory.scope === "global") return false;
        return !policy || canReadTarget(policy, h.memory.scope, h.memory.project);
      })
      .slice(0, 5);

    const noteSearch = await searchHybrid(vaultPath, task, {
      limit: 8,
      project: canReadProject && !includeGlobal ? canonicalProject! : undefined,
      scope: !includeGlobal && canReadProject ? "project" : includeGlobal && !canReadProject ? "global" : undefined,
      dbPath: opts.indexDbPath,
      embedder: opts.embedder,
    }).catch(() => null);
    if (noteSearch) {
      for (const hit of noteSearch.hits) {
        if (taskNoteHits.length >= 3) break;
        if (projectNotesIncluded.includes(hit.path)) continue;
        if (!includeGlobal && hit.scope === "global" && !hit.project) continue;
        if (!(await canReadRealPath(vaultPath, policy, hit.path))) continue;
        if (
          policy &&
          hit.project &&
          !canReadTarget(policy, "project", hit.project)
        ) {
          continue;
        }
        taskNoteHits.push(hit);
      }
    }
  }

  // 4. Count pending memories visible to this caller (SQL ACL push-down; no 200-row cap)
  const pendingCount = opts.stateStore ? opts.stateStore.countPendingMemories(policy) : 0;

  // 5. Assemble token-budgeted Markdown (priority order: header -> project mems -> task hits -> global mems -> project pack)
  const sections: string[] = [];
  const headerLines = [
    `# Session Context Briefing`,
    canonicalProject ? `Project: \`${canonicalProject}\`` : "Scope: global",
    task ? `Task: ${task}` : null,
    pendingCount > 0
      ? `Pending review queue: ${pendingCount} candidate ${pendingCount === 1 ? "memory" : "memories"} awaiting approval`
      : null,
  ].filter(Boolean);
  sections.push(headerLines.join("\n"));

  if (projectMemories.length) {
    sections.push(
      `## Project Memories (${projectMemories.length})\n` +
        projectMemories.map((m) => formatMemLine(m)).join("\n"),
    );
  }
  if (taskMemoryHits.length || taskNoteHits.length) {
    const lines: string[] = [];
    for (const h of taskMemoryHits) {
      lines.push(formatMemLine(h.memory));
    }
    for (const h of taskNoteHits) {
      lines.push(`- **${h.path}** (${h.heading || h.title}): ${h.snippet}`);
    }
    sections.push(`## Task-Relevant Recall\n${lines.join("\n")}`);
  }
  if (globalMemories.length) {
    sections.push(
      `## Standing Preferences & Profile (${globalMemories.length})\n` +
        globalMemories.map((m) => formatMemLine(m)).join("\n"),
    );
  }
  if (projectNoteExcerpts.length) {
    sections.push(
      `## Project Pack Notes\n` +
        projectNoteExcerpts.map((n) => `### ${n.path}\n${n.summary}`).join("\n\n"),
    );
  }

  if (sections.length === 1) {
    sections.push("_No matching active memories or project notes found yet._");
  }

  let markdown = "";
  for (const sec of sections) {
    const candidate = markdown ? `${markdown}\n\n${sec}` : sec;
    if (candidate.length <= maxChars) {
      markdown = candidate;
    } else {
      const remaining = maxChars - markdown.length - 40;
      if (remaining > 120) {
        markdown = `${markdown}\n\n${sec.slice(0, remaining).trimEnd()}\n… [truncated to ${maxChars} chars]`;
      }
      break;
    }
  }

  return {
    project: canonicalProject,
    globalMemories,
    projectMemories,
    taskMemoryHits,
    taskNoteHits,
    projectNotesIncluded,
    pendingCount,
    markdown,
  };
}
