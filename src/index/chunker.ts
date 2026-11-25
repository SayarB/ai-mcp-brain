/**
 * Markdown frontmatter parser, heading-aware section chunker, and [[wikilink]] extractor.
 */
import { basename } from "node:path";
import { parseYaml } from "../runtime.ts";

export type NoteMetadata = {
  title: string;
  type: string | null;
  scope: string | null;
  project: string | null;
  tags: string[];
  updated: string | null;
};

export type NoteChunk = {
  chunkIndex: number;
  heading: string;
  content: string;
};

const MAX_CHUNK_CHARS = 900;
const CHUNK_OVERLAP_CHARS = 100;

export function parseFrontmatter(body: string): {
  data: Record<string, unknown>;
  content: string;
} {
  if (!body.startsWith("---")) {
    return { data: {}, content: body };
  }
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { data: {}, content: body };
  }
  const rawYaml = match[1] ?? "";
  const content = body.slice(match[0].length).replace(/^\s+/, "");
  try {
    const parsed = parseYaml<unknown>(rawYaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, content };
    }
  } catch {
    /* tolerate malformed human frontmatter */
  }
  return { data: {}, content };
}

function asString(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t || null;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  return null;
}

function asTags(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
      .filter(Boolean);
  }
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Infer missing type/scope/project from vault path conventions. */
export function inferPathMetadata(relPath: string): {
  type: string | null;
  scope: string | null;
  project: string | null;
} {
  const parts = relPath.split("/");
  if (parts[0] === "projects" && parts.length >= 3) {
    const project = parts[1] ?? null;
    const sub = parts[2];
    if (sub === "instructions") return { type: "instruction", scope: "project", project };
    if (sub === "suggestions") return { type: "suggestion", scope: "project", project };
    if (sub === "workflows") return { type: "workflow", scope: "project", project };
    if (sub === "actions") return { type: "action", scope: "project", project };
    return { type: "project", scope: "project", project };
  }

  const top = parts[0] ?? "";
  const map: Record<string, string> = {
    inbox: "inbox",
    patterns: "pattern",
    stack: "stack",
    media: "media",
    agents: "agent",
    external: "external",
    instructions: "instruction",
    suggestions: "suggestion",
    workflows: "workflow",
    actions: "action",
    work: "work",
    memories: "memory",
    profile: "profile",
  };
  const type = map[top] ?? null;
  return { type, scope: type ? "global" : null, project: null };
}

export function extractNoteMetadata(
  relPath: string,
  body: string,
  mtimeMs?: number,
): { meta: NoteMetadata; content: string } {
  const { data, content } = parseFrontmatter(body);
  const inferred = inferPathMetadata(relPath);

  const heading = content.match(/^#\s+(.+)$/m);
  const title =
    asString(data.title) ||
    heading?.[1]?.trim() ||
    basename(relPath).replace(/\.(md|txt)$/i, "");

  const updated =
    asString(data.updated) ||
    asString(data.date) ||
    (mtimeMs ? new Date(mtimeMs).toISOString().slice(0, 10) : null);

  return {
    meta: {
      title,
      type: asString(data.type) ?? inferred.type,
      scope: asString(data.scope) ?? inferred.scope,
      project: asString(data.project) ?? inferred.project,
      tags: asTags(data.tags),
      updated,
    },
    content,
  };
}

function splitLongText(text: string, maxChars: number, overlap: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed ? [trimmed] : [];

  const paragraphs = trimmed.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const out = current.trim();
    if (out) chunks.push(out);
    current = "";
  };

  for (const rawPara of paragraphs) {
    const para = rawPara.trim();
    if (!para) continue;

    if (para.length > maxChars) {
      flush();
      let pos = 0;
      while (pos < para.length) {
        const slice = para.slice(pos, pos + maxChars).trim();
        if (slice) chunks.push(slice);
        if (pos + maxChars >= para.length) break;
        pos += Math.max(1, maxChars - overlap);
      }
      continue;
    }

    if (!current) {
      current = para;
    } else if (current.length + 2 + para.length <= maxChars) {
      current = `${current}\n\n${para}`;
    } else {
      const tail = overlap > 0 ? current.slice(-overlap).trim() : "";
      flush();
      current =
        tail && tail.length + 2 + para.length <= maxChars
          ? `${tail}\n\n${para}`
          : para;
    }
  }
  flush();
  return chunks;
}

/**
 * Split a Markdown document into heading-aware semantic chunks.
 * Preserves heading breadcrumbs so each chunk stays self-contained for BM25 + embeddings.
 */
export function chunkMarkdown(
  title: string,
  content: string,
  maxChars = MAX_CHUNK_CHARS,
): NoteChunk[] {
  const lines = content.split(/\r?\n/);
  type Section = { heading: string; lines: string[] };
  const sections: Section[] = [];

  const stack: { level: number; text: string }[] = [];
  let currentHeading = title;
  let currentLines: string[] = [];
  let inFence = false;

  const pushSection = () => {
    const text = currentLines.join("\n").trim();
    if (text) {
      sections.push({ heading: currentHeading, lines: currentLines });
    }
    currentLines = [];
  };

  for (const line of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      currentLines.push(line);
      continue;
    }
    const headingMatch = !inFence ? line.match(/^(#{1,4})\s+(.+?)\s*$/) : null;
    if (headingMatch) {
      pushSection();
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }
      stack.push({ level, text });
      currentHeading = stack.map((s) => s.text).join(" > ");
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  pushSection();

  if (!sections.length) {
    const fallback = content.trim() || title;
    return [{ chunkIndex: 0, heading: title, content: fallback }];
  }

  const result: NoteChunk[] = [];
  let idx = 0;
  for (const section of sections) {
    const raw = section.lines.join("\n").trim();
    for (const piece of splitLongText(raw, maxChars, CHUNK_OVERLAP_CHARS)) {
      result.push({
        chunkIndex: idx++,
        heading: section.heading,
        content: piece,
      });
    }
  }

  return result;
}

/** Extract Obsidian [[target]] and [[target|alias]] wikilinks outside code fences/spans. */
export function extractWikilinks(content: string): string[] {
  // Strip fenced code blocks and inline code spans before matching links
  const cleaned = content
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "\n")
    .replace(/`[^`\n]+`/g, "");

  const links = new Set<string>();
  const re = /(?<!!)\[\[([^\]|#\n]+)(?:#[^\]|\n]+)?(?:\|[^\]\n]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned)) !== null) {
    const target = match[1]?.trim();
    if (target) links.add(target);
  }
  return [...links];
}
