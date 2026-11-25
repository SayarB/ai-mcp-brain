/**
 * Obsidian Markdown-backed atomic memory store.
 * Each memory is a human-readable `### Title` section with a stable HTML metadata comment:
 *   <!-- mem:id=m_a1b2c3d4 status=active app=claude category=preferences created=2026-11-25 updated=2026-11-25 tags=a,b -->
 *
 * Global memories live in `memories/<category>.md`.
 * Project memories live in `projects/<slug>/memories.md`.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathExists, readText, writeText } from "../runtime.ts";
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
const SECTION_HEADING_RE = /^###\s+(.+?)\s*$/;
const SUPERSEDED_CALLOUT_RE = /^>\s*_Superseded by\s+\S+.*?_\s*$/;

export function generateMemoryId(): string {
  return `m_${randomBytes(4).toString("hex")}`;
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
  lines.push("", mem.content.trim());
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
  const lines = markdown.split(/\r?\n/);
  const { scope, project, defaultCategory } = scopeProjectFromPath(relPath);
  const blocks: ParsedBlock[] = [];

  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      i++;
      continue;
    }
    if (inFence) {
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

    // Scan until next heading of level <= 3 outside code fences
    let end = metaIdx + 1;
    let blockFence = false;
    while (end < lines.length) {
      const cur = lines[end]!;
      if (/^\s*(`{3,}|~{3,})/.test(cur)) {
        blockFence = !blockFence;
        end++;
        continue;
      }
      if (!blockFence && /^#{1,3}\s+/.test(cur)) {
        break;
      }
      end++;
    }

    const bodyLines = lines
      .slice(metaIdx + 1, end)
      .filter((l) => !SUPERSEDED_CALLOUT_RE.test(l.trim()));
    const content = bodyLines.join("\n").trim();

    const categoryRaw = meta.category as MemoryCategory | undefined;
    const category: MemoryCategory =
      categoryRaw && (MEMORY_CATEGORIES as readonly string[]).includes(categoryRaw)
        ? categoryRaw
        : defaultCategory;

    const status: MemoryStatus =
      meta.status === "superseded" ? "superseded" : "active";

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

/** Insert a new atomic memory block right after the H1 heading (newest-first!) so top reads stay fresh. */
function insertBlockNewestFirst(markdown: string, block: string): string {
  const lines = markdown.split(/\r?\n/);
  // Skip frontmatter
  let idx = 0;
  if (lines[0]?.trim() === "---") {
    idx = 1;
    while (idx < lines.length && lines[idx]?.trim() !== "---") idx++;
    if (idx < lines.length) idx++;
  }
  // Advance past optional H1 title line
  while (idx < lines.length && !lines[idx]?.trim()) idx++;
  if (lines[idx]?.startsWith("# ")) {
    idx++;
  }
  while (idx < lines.length && !lines[idx]?.trim()) idx++;

  const before = lines.slice(0, idx).join("\n").trimEnd();
  const after = lines.slice(idx).join("\n").trimStart();
  const parts = [before, block.trim(), after].filter(Boolean);
  return `${parts.join("\n\n")}\n`;
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

  return filter.limit ? out.slice(0, filter.limit) : out;
}

export async function findMemoryById(
  vaultPath: string,
  id: string,
): Promise<{ block: ParsedBlock; markdown: string; absPath: string } | null> {
  const needle = id.trim();
  if (!needle) return null;
  const files = await listMemoryFiles(vaultPath);
  for (const relPath of files) {
    const absPath = resolve(vaultPath, relPath);
    const markdown = await readText(absPath);
    const blocks = parseMemoryFile(relPath, markdown);
    const hit = blocks.find((b) => b.memory.id === needle);
    if (hit) {
      return { block: hit, markdown, absPath };
    }
  }
  return null;
}

export async function addMemoryRaw(
  vaultPath: string,
  input: AddMemoryRawInput,
): Promise<AtomicMemory> {
  assertNoSecrets(input.title, input.content);

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
  await mkdir(dirname(absPath), { recursive: true });

  const id = generateMemoryId();
  const memory: AtomicMemory = {
    id,
    title: input.title.trim(),
    content: input.content.trim(),
    scope,
    project: resolvedProject,
    category,
    status: "active",
    app: input.app?.trim() || "unknown",
    tags: (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    created: date,
    updated: date,
    supersededBy: null,
    supersedes: input.supersedes ?? null,
    supersededAt: null,
    path: relPath,
  };

  const block = renderMemoryBlock(memory);
  const existing = (await pathExists(absPath))
    ? await readText(absPath)
    : seedMemoryFile(scope, category, resolvedProject, date);
  const next = bumpFrontmatterUpdated(insertBlockNewestFirst(existing, block), date);
  await writeText(absPath, next);
  return memory;
}

export async function updateMemory(
  vaultPath: string,
  input: UpdateMemoryInput,
): Promise<AtomicMemory> {
  assertNoSecrets(input.title, input.content);

  const found = await findMemoryById(vaultPath, input.id);
  if (!found) {
    throw new Error(`Memory not found: ${input.id}`);
  }

  const date = todayIso();
  const prev = found.block.memory;
  const updatedMem: AtomicMemory = {
    ...prev,
    title: input.title?.trim() || prev.title,
    content: input.content?.trim() || prev.content,
    tags:
      input.tags !== undefined
        ? input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean)
        : prev.tags,
    category: input.category ?? prev.category,
    app: input.app?.trim() || prev.app,
    updated: date,
  };

  const lines = found.markdown.split(/\r?\n/);
  const replacement = renderMemoryBlock(updatedMem).split("\n");
  const nextLines = [
    ...lines.slice(0, found.block.startLine),
    ...replacement,
    "",
    ...lines.slice(found.block.endLine),
  ];
  const nextMd = bumpFrontmatterUpdated(
    nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    date,
  );
  await writeText(found.absPath, nextMd);
  return updatedMem;
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
  assertNoSecrets(replacement.title, replacement.content);

  const found = await findMemoryById(vaultPath, oldId);
  if (!found) {
    throw new Error(`Memory not found: ${oldId}`);
  }

  const prev = found.block.memory;
  const date = todayIso();

  // Create the replacement memory in the same scope/project (and category unless overridden)
  const created = await addMemoryRaw(vaultPath, {
    title: replacement.title?.trim() || prev.title,
    content: replacement.content,
    scope: prev.scope,
    project: prev.project ?? undefined,
    category: replacement.category ?? prev.category,
    app: replacement.app ?? prev.app,
    tags: replacement.tags ?? prev.tags,
    supersedes: prev.id,
  });

  // Re-read the file (it may be the same file we just inserted into) and mark oldId superseded
  const latestFound = await findMemoryById(vaultPath, oldId);
  if (!latestFound) {
    throw new Error(`Failed to locate ${oldId} after inserting replacement`);
  }

  const superseded: AtomicMemory = {
    ...latestFound.block.memory,
    status: "superseded",
    supersededBy: created.id,
    supersededAt: date,
    updated: date,
  };

  const lines = latestFound.markdown.split(/\r?\n/);
  const nextLines = [
    ...lines.slice(0, latestFound.block.startLine),
    ...renderMemoryBlock(superseded).split("\n"),
    "",
    ...lines.slice(latestFound.block.endLine),
  ];
  const nextMd = bumpFrontmatterUpdated(
    nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    date,
  );
  await writeText(latestFound.absPath, nextMd);

  return { superseded, created };
}

export async function deleteMemory(
  vaultPath: string,
  id: string,
): Promise<{ deleted: AtomicMemory }> {
  const found = await findMemoryById(vaultPath, id);
  if (!found) {
    throw new Error(`Memory not found: ${id}`);
  }

  const date = todayIso();
  const lines = found.markdown.split(/\r?\n/);
  const nextLines = [
    ...lines.slice(0, found.block.startLine),
    ...lines.slice(found.block.endLine),
  ];
  const nextMd = bumpFrontmatterUpdated(
    nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    date,
  );
  await writeText(found.absPath, nextMd);
  return { deleted: found.block.memory };
}

export function slugifyCategory(raw?: string): MemoryCategory | undefined {
  if (!raw) return undefined;
  const s = slugify(raw);
  return (MEMORY_CATEGORIES as readonly string[]).includes(s)
    ? (s as MemoryCategory)
    : undefined;
}
