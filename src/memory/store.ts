/**
 * Obsidian Markdown-backed atomic memory store.
 * Each memory is a human-readable `### Title` section bounded by invisible HTML markers:
 *   ### Prefer Bun over Node
 *   <!-- mem:id=m_a1b2c3d4 status=active app=claude category=preferences created=2026-11-25 updated=2026-11-25 tags=a,b -->
 *
 *   Use Bun when available.
 *   <!-- /mem:m_a1b2c3d4 -->
 *
 * Explicit closing markers prevent absorbing surrounding hand-written prose and allow
 * Markdown headings inside memory content without splitting blocks.
 * All writes are serialized per file and written via atomic temp-file + rename.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathExists, readText } from "../runtime.ts";
import {
  assertInsideVault,
  bumpFrontmatterUpdated,
  ensureProject,
  listNotePaths,
  resolveProjectSlug,
  slugify,
} from "../vault.ts";
import { assertNoSecrets } from "./guard.ts";

export const MEMORY_CATEGORIES = [
  "profile",
  "preferences",
  "decisions",
  "facts",
  "gotchas",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryStatus = "active" | "superseded";
export type MemoryScope = "global" | "project";

export type AtomicMemory = {
  id: string;
  title: string;
  content: string;
  scope: MemoryScope;
  project: string | null;
  category: MemoryCategory;
  status: MemoryStatus;
  app: string;
  tags: string[];
  created: string;
  updated: string;
  supersededBy: string | null;
  supersedes: string | null;
  supersededAt: string | null;
  path: string;
};

export type ListMemoriesFilter = {
  scope?: MemoryScope;
  project?: string;
  category?: MemoryCategory;
  app?: string;
  tags?: string[];
  status?: MemoryStatus | "all";
  limit?: number;
};

export type AddMemoryRawInput = {
  title: string;
  content: string;
  scope?: MemoryScope;
  project?: string;
  category?: MemoryCategory;
  app?: string;
  tags?: string[];
  supersedes?: string;
};

export type UpdateMemoryInput = {
  id: string;
  title?: string;
  content?: string;
  tags?: string[];
  category?: MemoryCategory;
  app?: string;
};

const MEM_COMMENT_RE = /^<!--\s*mem:(.+?)\s*-->$/;
const MEM_END_RE = /^<!--\s*\/mem:([^\s<>]+)\s*-->$/;
const SECTION_HEADING_RE = /^###\s+(.+?)\s*$/;
const SUPERSEDED_CALLOUT_RE = /^>\s*_Superseded by\s+\S+.*?_\s*$/;

/** Per-file in-process mutex + cross-process O_EXCL lockfile so MCP servers and CLI never clobber writes. */
const fileLocks = new Map<string, Promise<void>>();
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function acquireLockfile(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const ownerToken = `${process.pid}:${randomBytes(6).toString("hex")}`;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${ownerToken}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = (await readText(lockPath)).trim();
          if (current === ownerToken) {
            await rm(lockPath, { force: true });
          }
        } catch {
          /* already removed */
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      try {
        const [st, rawOwner] = await Promise.all([
          stat(lockPath),
          readText(lockPath).catch(() => ""),
        ]);
        const holderPid = Number(rawOwner.trim().split(":")[0]);
        const ownerDead =
          rawOwner.trim().length > 0 &&
          Number.isInteger(holderPid) &&
          holderPid > 0 &&
          !isPidAlive(holderPid);
        const isStale = Date.now() - st.mtimeMs > STALE_LOCK_MS || ownerDead;
        if (isStale) {
          // Verify lock content unchanged before removing so we never unlink a fresh owner's lock
          const latest = await readText(lockPath).catch(() => "");
          if (latest === rawOwner) {
            await rm(lockPath, { force: true }).catch(() => {});
            continue;
          }
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lockfile: ${lockPath}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function withFileLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(absPath);
  const prev = fileLocks.get(key) ?? Promise.resolve();
  let releaseInProcess!: () => void;
  const gate = new Promise<void>((r) => {
    releaseInProcess = r;
  });
  const chained = prev.then(() => gate);
  fileLocks.set(key, chained);

  await prev;
  let releaseLockfile: (() => Promise<void>) | null = null;
  try {
    releaseLockfile = await acquireLockfile(`${key}.lock`);
    return await fn();
  } finally {
    if (releaseLockfile) await releaseLockfile();
    releaseInProcess();
    if (fileLocks.get(key) === chained) {
      fileLocks.delete(key);
    }
  }
}

async function withFilesLock<T>(absPaths: string[], fn: () => Promise<T>): Promise<T> {
  const unique = [...new Set(absPaths.map((p) => resolve(p)))].sort();
  const runAt = (idx: number): Promise<T> => {
    if (idx >= unique.length) return fn();
    return withFileLock(unique[idx]!, () => runAt(idx + 1));
  };
  return runAt(0);
}

/** Atomic file write via sibling temp file + rename so concurrent readers never see partial files. */
async function writeTextAtomic(absPath: string, contents: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmpPath, contents, "utf8");
    await rename(tmpPath, absPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function applyEol(lfText: string, eol: "\r\n" | "\n"): string {
  const normalized = lfText.replace(/\r\n/g, "\n");
  return eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

export function sanitizeMemoryTitle(raw: string): string {
  const cleaned = raw
    .replace(/<!--/g, "")
    .replace(/-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    throw new Error("Memory title must be non-empty after trimming.");
  }
  return cleaned;
}

/** Track Markdown fenced code blocks respecting fence char (` vs ~) and fence length per CommonMark. */
function updateFenceState(
  line: string,
  state: { char: string; len: number } | null,
): { char: string; len: number } | null {
  const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!m?.[1]) return state;
  const ch = m[1][0]!;
  const len = m[1].length;
  const rest = (m[2] ?? "").trim();
  if (!state) {
    return { char: ch, len };
  }
  if (ch === state.char && len >= state.len && rest === "") {
    return null;
  }
  return state;
}

/** Splice replacement lines into `lines[start..end)` cleanly without collapsing blank lines elsewhere in the file. */
function spliceLinesCleanly(
  lines: string[],
  startLine: number,
  endLine: number,
  replacement: string[],
): string {
  const before = lines.slice(0, startLine);
  while (before.length && before[before.length - 1]!.trim() === "") before.pop();
  const after = lines.slice(endLine);
  while (after.length && after[0]!.trim() === "") after.shift();

  const out: string[] = [];
  if (before.length) out.push(...before);
  if (replacement.length) {
    if (out.length) out.push("");
    out.push(...replacement);
  }
  if (after.length) {
    if (out.length) out.push("");
    out.push(...after);
  }
  return out.join("\n").trimEnd() + "\n";
}

export function sanitizeMemoryContent(raw: string): string {
  let cleaned = raw
    .replace(/<!--(\s*\/?mem:)/gi, "&lt;!--$1")
    .trim();
  if (!cleaned) {
    throw new Error("Memory content must be non-empty after trimming.");
  }
  // Balance any unclosed Markdown code fence so rendering in Obsidian never bleeds into the next memory
  let fence: { char: string; len: number } | null = null;
  for (const line of cleaned.split(/\r?\n/)) {
    fence = updateFenceState(line, fence);
  }
  if (fence) {
    cleaned = `${cleaned}\n${fence.char.repeat(fence.len)}`;
  }
  return cleaned;
}

export function generateMemoryId(existingIds?: Set<string>): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = `m_${randomBytes(4).toString("hex")}`;
    if (!existingIds?.has(id)) return id;
  }
  return `m_${randomBytes(6).toString("hex")}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeMetaValue(val: string): string {
  return val.replace(/[\s<>|]+/g, "-").replace(/--+/g, "-").trim();
}

function formatMetaComment(mem: {
  id: string;
  status: MemoryStatus;
  app: string;
  category: MemoryCategory;
  created: string;
  updated: string;
  tags: string[];
  supersededBy?: string | null;
  supersedes?: string | null;
  supersededAt?: string | null;
}): string {
  const fields: string[] = [
    `id=${sanitizeMetaValue(mem.id)}`,
    `status=${mem.status}`,
    `app=${sanitizeMetaValue(mem.app || "unknown")}`,
    `category=${mem.category}`,
    `created=${mem.created}`,
    `updated=${mem.updated}`,
  ];
  if (mem.tags.length) {
    fields.push(
      `tags=${mem.tags.map((t) => sanitizeMetaValue(t.toLowerCase())).filter(Boolean).join(",")}`,
    );
  }
  if (mem.supersedes) fields.push(`supersedes=${sanitizeMetaValue(mem.supersedes)}`);
  if (mem.supersededBy) fields.push(`superseded_by=${sanitizeMetaValue(mem.supersededBy)}`);
  if (mem.supersededAt) fields.push(`superseded_at=${mem.supersededAt}`);
  return `<!-- mem:${fields.join(" ")} -->`;
}

function parseMetaComment(line: string): Record<string, string> | null {
  const m = line.trim().match(MEM_COMMENT_RE);
  if (!m?.[1]) return null;
  const out: Record<string, string> = {};
  for (const part of m[1].trim().split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out.id ? out : null;
}

export function renderMemoryBlock(mem: Omit<AtomicMemory, "path">): string {
  const lines = [
    `### ${mem.title.trim()}`,
    formatMetaComment(mem),
  ];
  if (mem.status === "superseded" && mem.supersededBy) {
    lines.push(
      `> _Superseded by ${mem.supersededBy}${mem.supersededAt ? ` on ${mem.supersededAt}` : ""}_`,
    );
  }
  lines.push("", mem.content.trim(), `<!-- /mem:${sanitizeMetaValue(mem.id)} -->`);
  return lines.join("\n");
}

function isMemoryFilePath(relPath: string): boolean {
  if (relPath.startsWith("memories/") && relPath.endsWith(".md")) {
    return !relPath.endsWith("README.md") && !relPath.endsWith("_index.md");
  }
  return /^projects\/[^/]+\/memories\.md$/.test(relPath);
}

function scopeProjectFromPath(relPath: string): {
  scope: MemoryScope;
  project: string | null;
  defaultCategory: MemoryCategory;
} {
  const projMatch = relPath.match(/^projects\/([^/]+)\/memories\.md$/);
  if (projMatch?.[1]) {
    return { scope: "project", project: projMatch[1], defaultCategory: "decisions" };
  }
  const stem = relPath.replace(/^memories\//, "").replace(/\.md$/i, "") as MemoryCategory;
  const category: MemoryCategory = (MEMORY_CATEGORIES as readonly string[]).includes(stem)
    ? stem
    : "facts";
  return { scope: "global", project: null, defaultCategory: category };
}

type ParsedBlock = {
  memory: AtomicMemory;
  startLine: number;
  endLine: number; // exclusive
};

/** Parse all atomic memory blocks inside a Markdown file along with their exact line spans. */
export function parseMemoryFile(relPath: string, markdown: string): ParsedBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const { scope, project, defaultCategory } = scopeProjectFromPath(relPath);
  const blocks: ParsedBlock[] = [];

  let i = 0;
  let outerFence: { char: string; len: number } | null = null;
  while (i < lines.length) {
    const line = lines[i]!;
    const nextOuterFence = updateFenceState(line, outerFence);
    if (nextOuterFence !== outerFence) {
      outerFence = nextOuterFence;
      i++;
      continue;
    }
    if (outerFence) {
      i++;
      continue;
    }

    const headMatch = line.match(SECTION_HEADING_RE);
    if (!headMatch) {
      i++;
      continue;
    }

    // Look at the next non-empty line for `<!-- mem:... -->`
    let metaIdx = i + 1;
    while (metaIdx < lines.length && !lines[metaIdx]!.trim()) metaIdx++;
    const meta = metaIdx < lines.length ? parseMetaComment(lines[metaIdx]!) : null;
    if (!meta?.id) {
      i++;
      continue;
    }

    // Scan for explicit closing marker `<!-- /mem:<id> -->` BEFORE fence tracking:
    // the sanitizer escapes `<!-- /mem:` in user content, so a matching closing marker is always
    // authoritative even if user content contains an unclosed code fence.
    let end = metaIdx + 1;
    let bodyEnd = end;
    let blockFence: { char: string; len: number } | null = null;
    let foundEndMarker = false;
    while (end < lines.length) {
      const cur = lines[end]!;
      const endMatch = cur.trim().match(MEM_END_RE);
      if (endMatch?.[1] === meta.id) {
        bodyEnd = end;
        end++; // include closing marker in block span
        foundEndMarker = true;
        break;
      }
      const nextBlockFence = updateFenceState(cur, blockFence);
      if (nextBlockFence !== blockFence) {
        blockFence = nextBlockFence;
        end++;
        bodyEnd = end;
        continue;
      }
      if (!blockFence) {
        // Fallback boundary for legacy blocks without closing marker: stop at next memory header
        if (SECTION_HEADING_RE.test(cur)) {
          let probe = end + 1;
          while (probe < lines.length && !lines[probe]!.trim()) probe++;
          if (probe < lines.length && parseMetaComment(lines[probe]!)) {
            bodyEnd = end;
            break;
          }
        }
      }
      end++;
      bodyEnd = end;
    }
    if (!foundEndMarker) {
      // Legacy fallback: if no end marker was present and there's an H1/H2 heading inside, trim at first H1/H2
      let scanFence: { char: string; len: number } | null = null;
      for (let k = metaIdx + 1; k < bodyEnd; k++) {
        const cur = lines[k]!;
        const nextScan = updateFenceState(cur, scanFence);
        if (nextScan !== scanFence) {
          scanFence = nextScan;
          continue;
        }
        if (!scanFence && /^#{1,2}\s+/.test(cur)) {
          bodyEnd = k;
          end = k;
          break;
        }
      }
    }

    const status: MemoryStatus =
      meta.status === "superseded" ? "superseded" : "active";

    // Only strip the synthetic superseded callout if it appears right after the metadata comment
    let contentStart = metaIdx + 1;
    while (contentStart < bodyEnd && !lines[contentStart]!.trim()) contentStart++;
    if (
      status === "superseded" &&
      contentStart < bodyEnd &&
      SUPERSEDED_CALLOUT_RE.test(lines[contentStart]!.trim())
    ) {
      contentStart++;
    }

    const content = lines.slice(contentStart, bodyEnd).join("\n").trim();

    const categoryRaw = meta.category as MemoryCategory | undefined;
    const category: MemoryCategory =
      categoryRaw && (MEMORY_CATEGORIES as readonly string[]).includes(categoryRaw)
        ? categoryRaw
        : defaultCategory;

    blocks.push({
      startLine: i,
      endLine: end,
      memory: {
        id: meta.id,
        title: headMatch[1]!.trim(),
        content,
        scope,
        project,
        category,
        status,
        app: meta.app ?? "unknown",
        tags: meta.tags ? meta.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        created: meta.created ?? todayIso(),
        updated: meta.updated ?? meta.created ?? todayIso(),
        supersededBy: meta.superseded_by ?? null,
        supersedes: meta.supersedes ?? null,
        supersededAt: meta.superseded_at ?? null,
        path: relPath,
      },
    });

    i = end;
  }

  return blocks;
}

/**
 * Strip `status=superseded` atomic memory blocks from Markdown text (used by `src/index/chunker.ts`
 * so `search_notes` never surfaces superseded memories in active recall).
 */
export function stripSupersededMemories(relPath: string, markdown: string): string {
  if (!isMemoryFilePath(relPath)) return markdown;
  const blocks = parseMemoryFile(relPath, markdown).filter(
    (b) => b.memory.status === "superseded",
  );
  if (!blocks.length) return markdown;

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const b of blocks) {
    if (b.startLine > cursor) {
      out.push(...lines.slice(cursor, b.startLine));
    }
    cursor = Math.max(cursor, b.endLine);
  }
  if (cursor < lines.length) {
    out.push(...lines.slice(cursor));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function memoryTargetPath(
  vaultPath: string,
  scope: MemoryScope,
  category: MemoryCategory,
  project?: string,
): Promise<{ relPath: string; resolvedProject: string | null }> {
  if (scope === "project") {
    if (!project?.trim()) {
      throw new Error("scope=project requires `project` (git repo slug or path).");
    }
    const slug = await resolveProjectSlug(vaultPath, project);
    await ensureProject(vaultPath, slug);
    return {
      relPath: `projects/${slug}/memories.md`,
      resolvedProject: slug,
    };
  }
  return {
    relPath: `memories/${category}.md`,
    resolvedProject: null,
  };
}

function seedMemoryFile(
  scope: MemoryScope,
  category: MemoryCategory,
  project: string | null,
  date: string,
): string {
  const heading =
    scope === "project" && project
      ? `Memories: ${project}`
      : `Memories: ${category}`;
  return [
    "---",
    "type: memory",
    `scope: ${scope}`,
    project ? `project: ${project}` : null,
    `category: ${category}`,
    `tags: ["memory", ${JSON.stringify(category)}]`,
    `updated: ${date}`,
    "---",
    "",
    `# ${heading}`,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * Insert a new atomic memory block newest-first WITHOUT absorbing hand-written intro prose:
 * - If existing memory blocks exist in the file, insert directly before the first memory block.
 * - Otherwise (new file or hand-written intro prose only), append after all existing intro content.
 */
function insertBlockPreservingProse(
  relPath: string,
  markdown: string,
  block: string,
): string {
  const lf = markdown.replace(/\r\n/g, "\n");
  const existingBlocks = parseMemoryFile(relPath, lf);
  const lines = lf.split("\n");

  if (existingBlocks.length > 0) {
    const firstStart = existingBlocks[0]!.startLine;
    const before = lines.slice(0, firstStart).join("\n").trimEnd();
    const after = lines.slice(firstStart).join("\n").trimStart();
    const parts = [before, block.trim(), after].filter(Boolean);
    return `${parts.join("\n\n")}\n`;
  }

  const base = lf.trimEnd();
  if (!base) return `${block.trim()}\n`;
  return `${base}\n\n${block.trim()}\n`;
}

export async function listMemoryFiles(vaultPath: string): Promise<string[]> {
  const all = await listNotePaths(vaultPath);
  return all.filter(isMemoryFilePath);
}

export async function listMemories(
  vaultPath: string,
  filter: ListMemoriesFilter = {},
): Promise<AtomicMemory[]> {
  const files = await listMemoryFiles(vaultPath);
  const resolvedProj = filter.project
    ? await resolveProjectSlug(vaultPath, filter.project)
    : null;
  const wantStatus = filter.status ?? "active";
  const wantTags = (filter.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);

  const out: AtomicMemory[] = [];
  for (const relPath of files) {
    const abs = resolve(vaultPath, relPath);
    const md = await readText(abs);
    for (const { memory } of parseMemoryFile(relPath, md)) {
      if (wantStatus !== "all" && memory.status !== wantStatus) continue;
      if (filter.scope && memory.scope !== filter.scope) continue;
      if (resolvedProj && memory.project !== resolvedProj) continue;
      if (filter.category && memory.category !== filter.category) continue;
      if (filter.app && memory.app.toLowerCase() !== filter.app.trim().toLowerCase()) {
        continue;
      }
      if (wantTags.length) {
        const memTagSet = new Set(memory.tags.map((t) => t.toLowerCase()));
        if (!wantTags.every((t) => memTagSet.has(t))) continue;
      }
      out.push(memory);
    }
  }

  out.sort((a, b) => {
    if (a.updated !== b.updated) return b.updated.localeCompare(a.updated);
    return b.created.localeCompare(a.created);
  });

  if (filter.limit !== undefined) {
    return out.slice(0, Math.max(0, filter.limit));
  }
  return out;
}

export async function findMemoryById(
  vaultPath: string,
  id: string,
): Promise<{ block: ParsedBlock; markdown: string; absPath: string; relPath: string } | null> {
  const needle = id.trim();
  if (!needle) return null;
  const files = await listMemoryFiles(vaultPath);
  for (const relPath of files) {
    const absPath = resolve(vaultPath, relPath);
    const markdown = await readText(absPath);
    const blocks = parseMemoryFile(relPath, markdown);
    const hit = blocks.find((b) => b.memory.id === needle);
    if (hit) {
      return { block: hit, markdown, absPath, relPath };
    }
  }
  return null;
}

export async function addMemoryRaw(
  vaultPath: string,
  input: AddMemoryRawInput,
): Promise<AtomicMemory> {
  const title = sanitizeMemoryTitle(input.title);
  const content = sanitizeMemoryContent(input.content);
  assertNoSecrets(title, content);

  const scope: MemoryScope =
    input.scope ?? (input.project ? "project" : "global");
  const category: MemoryCategory =
    input.category ?? (scope === "project" ? "decisions" : "facts");
  const date = todayIso();

  const { relPath, resolvedProject } = await memoryTargetPath(
    vaultPath,
    scope,
    category,
    input.project,
  );
  const absPath = resolve(vaultPath, relPath);
  assertInsideVault(vaultPath, absPath);

  return withFileLock(absPath, async () => {
    const existed = await pathExists(absPath);
    const existingRaw = existed
      ? await readText(absPath)
      : seedMemoryFile(scope, category, resolvedProject, date);
    const eol = existed ? detectEol(existingRaw) : "\n";

    const existingIds = new Set(
      parseMemoryFile(relPath, existingRaw).map((b) => b.memory.id),
    );
    const id = generateMemoryId(existingIds);
    const memory: AtomicMemory = {
      id,
      title,
      content,
      scope,
      project: resolvedProject,
      category,
      status: "active",
      app: input.app?.trim() || "unknown",
      tags: [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))],
      created: date,
      updated: date,
      supersededBy: null,
      supersedes: input.supersedes ?? null,
      supersededAt: null,
      path: relPath,
    };

    const block = renderMemoryBlock(memory);
    const inserted = insertBlockPreservingProse(relPath, existingRaw, block);
    const next = applyEol(bumpFrontmatterUpdated(inserted, date), eol);
    await writeTextAtomic(absPath, next);
    return memory;
  });
}

/**
 * Refresh `updated` date (and merge any new tags as a union) on an existing memory
 * without overwriting its original `app`, `title`, or `content`.
 */
export async function touchMemory(
  vaultPath: string,
  id: string,
  mergeTags?: string[],
): Promise<AtomicMemory> {
  const located = await findMemoryById(vaultPath, id);
  if (!located) {
    throw new Error(`Memory not found: ${id}`);
  }

  return withFileLock(located.absPath, async () => {
    const raw = await readText(located.absPath);
    const eol = detectEol(raw);
    const lf = raw.replace(/\r\n/g, "\n");
    const blocks = parseMemoryFile(located.relPath, lf);
    const hit = blocks.find((b) => b.memory.id === id.trim());
    if (!hit) {
      throw new Error(`Memory not found: ${id}`);
    }

    const date = todayIso();
    const prev = hit.memory;
    const mergedTags = [
      ...new Set([
        ...prev.tags,
        ...(mergeTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
      ]),
    ];
    const updatedMem: AtomicMemory = {
      ...prev,
      tags: mergedTags,
      updated: date,
    };

    const lines = lf.split("\n");
    const replacement = renderMemoryBlock(updatedMem).split("\n");
    const spliced = spliceLinesCleanly(lines, hit.startLine, hit.endLine, replacement);
    const nextMd = applyEol(bumpFrontmatterUpdated(spliced, date), eol);
    await writeTextAtomic(located.absPath, nextMd);
    return updatedMem;
  });
}

export async function updateMemory(
  vaultPath: string,
  input: UpdateMemoryInput,
): Promise<AtomicMemory> {
  const nextTitle = input.title !== undefined ? sanitizeMemoryTitle(input.title) : undefined;
  const nextContent =
    input.content !== undefined ? sanitizeMemoryContent(input.content) : undefined;
  assertNoSecrets(nextTitle, nextContent);

  const located = await findMemoryById(vaultPath, input.id);
  if (!located) {
    throw new Error(`Memory not found: ${input.id}`);
  }

  const prevMeta = located.block.memory;
  const targetCategory = input.category ?? prevMeta.category;
  const needsMove =
    prevMeta.scope === "global" && targetCategory !== prevMeta.category;
  const destRelPath = needsMove ? `memories/${targetCategory}.md` : located.relPath;
  const destAbsPath = resolve(vaultPath, destRelPath);
  assertInsideVault(vaultPath, destAbsPath);

  return withFilesLock([located.absPath, destAbsPath], async () => {
    const srcRaw = await readText(located.absPath);
    const srcEol = detectEol(srcRaw);
    const srcLf = srcRaw.replace(/\r\n/g, "\n");
    const srcBlocks = parseMemoryFile(located.relPath, srcLf);
    const hit = srcBlocks.find((b) => b.memory.id === input.id.trim());
    if (!hit) {
      throw new Error(`Memory not found: ${input.id}`);
    }

    const date = todayIso();
    const prev = hit.memory;
    const updatedMem: AtomicMemory = {
      ...prev,
      title: nextTitle ?? prev.title,
      content: nextContent ?? prev.content,
      tags:
        input.tags !== undefined
          ? [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
          : prev.tags,
      category: targetCategory,
      app: input.app?.trim() || prev.app,
      updated: date,
      path: destRelPath,
    };

    const srcLines = srcLf.split("\n");
    if (!needsMove) {
      const replacement = renderMemoryBlock(updatedMem).split("\n");
      const spliced = spliceLinesCleanly(srcLines, hit.startLine, hit.endLine, replacement);
      const nextMd = applyEol(bumpFrontmatterUpdated(spliced, date), srcEol);
      await writeTextAtomic(located.absPath, nextMd);
      return updatedMem;
    }

    // Move atomically from old category file to new category file
    const destExisted = await pathExists(destAbsPath);
    const destRaw = destExisted
      ? await readText(destAbsPath)
      : seedMemoryFile("global", targetCategory, null, date);
    const destEol = destExisted ? detectEol(destRaw) : "\n";
    const destInserted = insertBlockPreservingProse(
      destRelPath,
      destRaw,
      renderMemoryBlock(updatedMem),
    );
    await writeTextAtomic(
      destAbsPath,
      applyEol(bumpFrontmatterUpdated(destInserted, date), destEol),
    );

    const srcRemoved = spliceLinesCleanly(srcLines, hit.startLine, hit.endLine, []);
    await writeTextAtomic(
      located.absPath,
      applyEol(bumpFrontmatterUpdated(srcRemoved, date), srcEol),
    );

    return updatedMem;
  });
}

export async function supersedeMemory(
  vaultPath: string,
  oldId: string,
  replacement: {
    title?: string;
    content: string;
    tags?: string[];
    app?: string;
    category?: MemoryCategory;
  },
): Promise<{ superseded: AtomicMemory; created: AtomicMemory }> {
  const newContent = sanitizeMemoryContent(replacement.content);
  const explicitTitle =
    replacement.title !== undefined
      ? sanitizeMemoryTitle(replacement.title)
      : undefined;
  assertNoSecrets(explicitTitle, newContent);

  const located = await findMemoryById(vaultPath, oldId);
  if (!located) {
    throw new Error(`Memory not found: ${oldId}`);
  }

  const initialPrev = located.block.memory;
  const destCategory = replacement.category ?? initialPrev.category;
  const { relPath: destRelPath, resolvedProject } = await memoryTargetPath(
    vaultPath,
    initialPrev.scope,
    destCategory,
    initialPrev.project ?? undefined,
  );
  const destAbsPath = resolve(vaultPath, destRelPath);
  assertInsideVault(vaultPath, destAbsPath);

  return withFilesLock([located.absPath, destAbsPath], async () => {
    const srcRaw = await readText(located.absPath);
    const srcEol = detectEol(srcRaw);
    const srcLf = srcRaw.replace(/\r\n/g, "\n");
    const srcBlocks = parseMemoryFile(located.relPath, srcLf);
    const hit = srcBlocks.find((b) => b.memory.id === oldId.trim());
    if (!hit) {
      throw new Error(`Memory not found: ${oldId}`);
    }

    const prev = hit.memory;
    if (prev.status === "superseded") {
      throw new Error(
        `Memory ${prev.id} is already superseded${
          prev.supersededBy ? ` by ${prev.supersededBy}` : ""
        }. Supersede the current active memory instead.`,
      );
    }

    const date = todayIso();
    const sameFile = resolve(located.absPath) === resolve(destAbsPath);

    const existingIds = new Set(srcBlocks.map((b) => b.memory.id));
    let destRaw = srcRaw;
    let destEol = srcEol;
    if (!sameFile) {
      const destExisted = await pathExists(destAbsPath);
      destRaw = destExisted
        ? await readText(destAbsPath)
        : seedMemoryFile(prev.scope, destCategory, resolvedProject, date);
      destEol = destExisted ? detectEol(destRaw) : "\n";
      for (const b of parseMemoryFile(destRelPath, destRaw)) {
        existingIds.add(b.memory.id);
      }
    }

    const created: AtomicMemory = {
      id: generateMemoryId(existingIds),
      title: explicitTitle ?? prev.title,
      content: newContent,
      scope: prev.scope,
      project: resolvedProject,
      category: destCategory,
      status: "active",
      app: replacement.app?.trim() || prev.app,
      tags:
        replacement.tags !== undefined
          ? [...new Set(replacement.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
          : prev.tags,
      created: date,
      updated: date,
      supersededBy: null,
      supersedes: prev.id,
      supersededAt: null,
      path: destRelPath,
    };

    const superseded: AtomicMemory = {
      ...prev,
      status: "superseded",
      supersededBy: created.id,
      supersededAt: date,
      updated: date,
    };

    // Replace old block in source file
    const srcLines = srcLf.split("\n");
    const srcWithSuperseded = spliceLinesCleanly(
      srcLines,
      hit.startLine,
      hit.endLine,
      renderMemoryBlock(superseded).split("\n"),
    );

    if (sameFile) {
      // Single atomic write: mark old superseded AND prepend new replacement
      const combined = insertBlockPreservingProse(
        located.relPath,
        srcWithSuperseded,
        renderMemoryBlock(created),
      );
      await writeTextAtomic(
        located.absPath,
        applyEol(bumpFrontmatterUpdated(combined, date), srcEol),
      );
    } else {
      const destCombined = insertBlockPreservingProse(
        destRelPath,
        destRaw,
        renderMemoryBlock(created),
      );
      await writeTextAtomic(
        destAbsPath,
        applyEol(bumpFrontmatterUpdated(destCombined, date), destEol),
      );
      await writeTextAtomic(
        located.absPath,
        applyEol(bumpFrontmatterUpdated(srcWithSuperseded, date), srcEol),
      );
    }

    return { superseded, created };
  });
}

export async function deleteMemory(
  vaultPath: string,
  id: string,
): Promise<{ deleted: AtomicMemory; warning?: string }> {
  const located = await findMemoryById(vaultPath, id);
  if (!located) {
    throw new Error(`Memory not found: ${id}`);
  }

  const deleted = await withFileLock(located.absPath, async () => {
    const raw = await readText(located.absPath);
    const eol = detectEol(raw);
    const lf = raw.replace(/\r\n/g, "\n");
    const blocks = parseMemoryFile(located.relPath, lf);
    const hit = blocks.find((b) => b.memory.id === id.trim());
    if (!hit) {
      throw new Error(`Memory not found: ${id}`);
    }

    const date = todayIso();
    const lines = lf.split("\n");
    const spliced = spliceLinesCleanly(lines, hit.startLine, hit.endLine, []);
    const nextMd = applyEol(bumpFrontmatterUpdated(spliced, date), eol);
    await writeTextAtomic(located.absPath, nextMd);
    return hit.memory;
  });

  let warning: string | undefined;
  if (deleted.supersedes) {
    const pred = await findMemoryById(vaultPath, deleted.supersedes);
    if (pred && pred.block.memory.supersededBy === deleted.id) {
      warning = `Predecessor ${deleted.supersedes} remains status=superseded with superseded_by=${deleted.id} (now deleted).`;
    }
  }

  return warning ? { deleted, warning } : { deleted };
}

export function slugifyCategory(raw?: string): MemoryCategory | undefined {
  if (!raw) return undefined;
  const s = slugify(raw);
  return (MEMORY_CATEGORIES as readonly string[]).includes(s)
    ? (s as MemoryCategory)
    : undefined;
}
