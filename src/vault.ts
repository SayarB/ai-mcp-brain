import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { configDir } from "./config.ts";
import {
  copyFileEnsured,
  globFiles,
  pathExists,
  readText,
  writeText,
} from "./runtime.ts";

const NOTE_GLOBS = ["**/*.md", "**/*.txt"];
const SKIP_DIR_PARTS = new Set([".obsidian", ".git", "node_modules", "_template"]);
const RECENT_PATH = "stack/recent.md";
const RECENT_MAX_ENTRIES = 50;
const PROJECT_FILES = ["README.md", "decisions.md", "tools.md", "gotchas.md"] as const;

export type VaultNote = {
  path: string;
  absolutePath: string;
  title: string;
  excerpt: string;
  body: string;
};

export type SearchHit = {
  path: string;
  title: string;
  score: number;
  snippet: string;
};

export type RememberScope = "global" | "project";

export type RememberInput = {
  title: string;
  content: string;
  scope?: RememberScope;
  folder?:
    | "inbox"
    | "projects"
    | "patterns"
    | "stack"
    | "media"
    | "agents";
  /** Git repo slug when scope is project (or for frontmatter). */
  project?: string;
  /** Subfile under projects/<slug>/ e.g. decisions | tools | gotchas | README */
  projectFile?: "README" | "decisions" | "tools" | "gotchas" | string;
  tags?: string[];
  filename?: string;
};

export type TrackToolInput = {
  name: string;
  summary: string;
  slug?: string;
  project?: string;
  tags?: string[];
};

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function shouldSkip(relPosix: string): boolean {
  return relPosix.split("/").some((part) => SKIP_DIR_PARTS.has(part));
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "note"
  );
}

function extractTitle(body: string, fallback: string): string {
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();
  return fallback.replace(/\.md$/i, "");
}

function stripFrontmatter(body: string): string {
  if (!body.startsWith("---")) return body;
  const end = body.indexOf("\n---", 3);
  if (end === -1) return body;
  return body.slice(end + 4).replace(/^\s+/, "");
}

export function assertInsideVault(vaultPath: string, targetAbs: string): void {
  const root = resolve(vaultPath) + sep;
  const target = resolve(targetAbs);
  if (target !== resolve(vaultPath) && !target.startsWith(root)) {
    throw new Error(`Path escapes vault: ${targetAbs}`);
  }
}

export async function listNotePaths(vaultPath: string): Promise<string[]> {
  const root = resolve(vaultPath);
  const paths: string[] = [];

  for (const pattern of NOTE_GLOBS) {
    for (const rel of await globFiles(root, pattern)) {
      const posix = toPosix(rel);
      if (shouldSkip(posix)) continue;
      paths.push(posix);
    }
  }

  return [...new Set(paths)].sort();
}

export async function readNote(
  vaultPath: string,
  relPath: string,
): Promise<VaultNote> {
  const cleaned = toPosix(relPath).replace(/^\/+/, "");
  const absolutePath = resolve(vaultPath, cleaned);
  assertInsideVault(vaultPath, absolutePath);

  if (!(await pathExists(absolutePath))) {
    throw new Error(`Note not found: ${cleaned}`);
  }

  const body = await readText(absolutePath);
  const title = extractTitle(stripFrontmatter(body), basename(cleaned));
  const plain = stripFrontmatter(body).replace(/\s+/g, " ").trim();

  return {
    path: cleaned,
    absolutePath,
    title,
    excerpt: plain.slice(0, 240),
    body,
  };
}

export async function searchNotes(
  vaultPath: string,
  query: string,
  limit = 10,
): Promise<SearchHit[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (!terms.length) return [];

  const paths = await listNotePaths(vaultPath);
  const hits: SearchHit[] = [];

  for (const path of paths) {
    const note = await readNote(vaultPath, path);
    const hay = `${note.path}\n${note.title}\n${note.body}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!hay.includes(term)) {
        score = -1;
        break;
      }
      score += (hay.split(term).length - 1) * 2;
      if (note.title.toLowerCase().includes(term)) score += 5;
      if (note.path.toLowerCase().includes(term)) score += 3;
    }
    if (score < 0) continue;

    const idx = hay.indexOf(terms[0]!);
    const start = Math.max(0, idx - 60);
    const snippet = note.body
      .replace(/\s+/g, " ")
      .trim()
      .slice(start, start + 180);

    hits.push({ path: note.path, title: note.title, score, snippet });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function projectTemplateDir(): string {
  return resolve(configDir(), "templates", "vault", "projects", "_template");
}

export async function ensureProject(
  vaultPath: string,
  projectSlug: string,
): Promise<{ slug: string; created: string[] }> {
  const slug = slugify(projectSlug);
  const created: string[] = [];
  const destDir = join(vaultPath, "projects", slug);
  await mkdir(destDir, { recursive: true });

  const templateDir = projectTemplateDir();
  for (const name of PROJECT_FILES) {
    const dest = join(destDir, name);
    if (await pathExists(dest)) continue;

    const src = join(templateDir, name);
    let body: string;
    if (await pathExists(src)) {
      body = (await readText(src)).replaceAll("{{PROJECT_SLUG}}", slug);
    } else {
      body = `# ${slug}\n`;
    }
    await writeText(dest, body);
    created.push(toPosix(join("projects", slug, name)));
  }

  return { slug, created };
}

export async function getProjectContext(
  vaultPath: string,
  project: string,
  limit = 20,
): Promise<{ notes: VaultNote[]; ensured: string[] }> {
  const { slug, created } = await ensureProject(vaultPath, project);
  const needle = slug.toLowerCase();
  const paths = await listNotePaths(vaultPath);
  const matched: VaultNote[] = [];

  for (const path of paths) {
    const underProject = path.startsWith(`projects/${slug}/`);
    const note = await readNote(vaultPath, path);
    const front = note.body.slice(0, 500).toLowerCase();
    const pathHit =
      path.startsWith("projects/") && path.toLowerCase().includes(needle);
    const metaHit =
      front.includes(`project: ${needle}`) ||
      front.includes(`project: "${needle}"`);

    if (underProject || pathHit || metaHit) {
      matched.push(note);
    }
  }

  matched.sort((a, b) => {
    const ap = a.path.startsWith(`projects/${slug}/`) ? 0 : 1;
    const bp = b.path.startsWith(`projects/${slug}/`) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.path.localeCompare(b.path);
  });

  const seen = new Set<string>();
  const unique: VaultNote[] = [];
  for (const n of matched) {
    if (seen.has(n.path)) continue;
    seen.add(n.path);
    unique.push(n);
  }

  return { notes: unique.slice(0, limit), ensured: created };
}

function parseRecentEntries(body: string): string[] {
  const lines = body.split("\n");
  const logIdx = lines.findIndex((l) => /^##\s+Log\s*$/i.test(l.trim()));
  const start = logIdx === -1 ? 0 : logIdx + 1;
  return lines
    .slice(start)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().startsWith("- "));
}

async function ensureRecentFile(vaultPath: string): Promise<string> {
  const abs = resolve(vaultPath, RECENT_PATH);
  assertInsideVault(vaultPath, abs);
  if (!(await pathExists(abs))) {
    await mkdir(dirname(abs), { recursive: true });
    const template = resolve(
      configDir(),
      "templates",
      "vault",
      "stack",
      "recent.md",
    );
    if (await pathExists(template)) {
      await copyFileEnsured(template, abs);
    } else {
      await writeText(
        abs,
        "---\ntype: stack\ntags: [recent]\n---\n\n# Recent\n\n## Log\n\n",
      );
    }
  }
  return abs;
}

export async function prependRecent(
  vaultPath: string,
  entryLine: string,
): Promise<void> {
  const abs = await ensureRecentFile(vaultPath);
  const body = await readText(abs);
  const date = new Date().toISOString().slice(0, 10);
  const line = entryLine.trim().startsWith("- ")
    ? entryLine.trim()
    : `- ${date} · ${entryLine.trim()}`;

  const entries = [line, ...parseRecentEntries(body)].slice(0, RECENT_MAX_ENTRIES);
  const headerEnd = body.search(/^##\s+Log\s*$/im);
  const header =
    headerEnd === -1
      ? `${body.trimEnd()}\n\n## Log\n\n`
      : body.slice(0, headerEnd) + "## Log\n\n";

  await writeText(abs, `${header.trimEnd()}\n\n${entries.join("\n")}\n`);
}

export async function listRecent(
  vaultPath: string,
  limit = 20,
): Promise<string[]> {
  await ensureRecentFile(vaultPath);
  const note = await readNote(vaultPath, RECENT_PATH);
  return parseRecentEntries(note.body).slice(0, limit);
}

export async function trackTool(
  vaultPath: string,
  input: TrackToolInput,
): Promise<{ catalog: VaultNote; recent: string[] }> {
  const slug = slugify(input.slug ?? input.name);
  const date = new Date().toISOString().slice(0, 10);
  const relPath = toPosix(join("stack", "catalog", `${slug}.md`));
  const abs = resolve(vaultPath, relPath);
  assertInsideVault(vaultPath, abs);
  await mkdir(dirname(abs), { recursive: true });

  const tags = input.tags ?? [];
  if (await pathExists(abs)) {
    const prev = await readText(abs);
    const appended = `${prev.trimEnd()}\n\n## Update ${date}\n\n${input.summary.trim()}\n`;
    await writeText(abs, appended);
  } else {
    const body = [
      "---",
      "type: stack",
      "scope: global",
      `tags: [${["tool", ...tags].map((t) => JSON.stringify(t)).join(", ")}]`,
      `updated: ${date}`,
      "---",
      "",
      `# ${input.name}`,
      "",
      input.summary.trim(),
      "",
    ].join("\n");
    await writeText(abs, body);
  }

  await prependRecent(
    vaultPath,
    `- ${date} · ${input.name} · ${input.summary.trim().replace(/\s+/g, " ").slice(0, 120)} · [[catalog/${slug}]]`,
  );

  if (input.project) {
    const { slug: projectSlug } = await ensureProject(vaultPath, input.project);
    const toolsPath = toPosix(join("projects", projectSlug, "tools.md"));
    const toolsAbs = resolve(vaultPath, toolsPath);
    const tip = `- ${date} · [[../../stack/catalog/${slug}|${input.name}]] — ${input.summary.trim().replace(/\s+/g, " ").slice(0, 100)}`;
    if (await pathExists(toolsAbs)) {
      const prev = await readText(toolsAbs);
      if (!prev.toLowerCase().includes(slug.toLowerCase())) {
        await writeText(toolsAbs, `${prev.trimEnd()}\n${tip}\n`);
      }
    }
  }

  const catalog = await readNote(vaultPath, relPath);
  const recent = await listRecent(vaultPath, 10);
  return { catalog, recent };
}

export async function rememberNote(
  vaultPath: string,
  input: RememberInput,
): Promise<VaultNote> {
  const date = new Date().toISOString().slice(0, 10);
  const tags = input.tags ?? [];
  const scope: RememberScope =
    input.scope ?? (input.project ? "project" : "global");

  if (scope === "project" && !input.project) {
    throw new Error(
      "scope=project requires `project` (git repo slug). If unsure global vs project, ask the user.",
    );
  }

  let relPath: string;
  let type: string;
  let scopeField: RememberScope = scope;

  if (scope === "project" && input.project) {
    const { slug } = await ensureProject(vaultPath, input.project);
    const fileStem = slugify(
      input.projectFile ?? input.filename ?? "decisions",
    );
    const known = new Set(["readme", "decisions", "tools", "gotchas"]);
    const fileName = known.has(fileStem)
      ? fileStem === "readme"
        ? "README.md"
        : `${fileStem}.md`
      : `${fileStem}.md`;
    relPath = toPosix(join("projects", slug, fileName));
    type = "project";
    scopeField = "project";

    // Append to pack file rather than overwrite README seed
    const absolutePath = resolve(vaultPath, relPath);
    assertInsideVault(vaultPath, absolutePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    if (await pathExists(absolutePath)) {
      const prev = await readText(absolutePath);
      const block = `\n## ${input.title} (${date})\n\n${input.content.trim()}\n`;
      await writeText(absolutePath, `${prev.trimEnd()}\n${block}`);
      return readNote(vaultPath, relPath);
    }
  } else {
    const folder = input.folder ?? "inbox";
    const fileBase = slugify(input.filename ?? input.title);
    relPath = toPosix(join(folder, `${fileBase}.md`));
    type =
      folder === "inbox"
        ? "inbox"
        : folder === "projects"
          ? "project"
          : folder === "patterns"
            ? "pattern"
            : folder === "stack"
              ? "stack"
              : folder === "media"
                ? "media"
                : "agent";
  }

  const absolutePath = resolve(vaultPath, relPath);
  assertInsideVault(vaultPath, absolutePath);
  await mkdir(dirname(absolutePath), { recursive: true });

  if (await pathExists(absolutePath)) {
    const prev = await readText(absolutePath);
    const appended = `${prev.trimEnd()}\n\n## Update ${date}\n\n${input.content.trim()}\n`;
    await writeText(absolutePath, appended);
    return readNote(vaultPath, relPath);
  }

  const frontmatter = [
    "---",
    `type: ${type}`,
    `scope: ${scopeField}`,
    input.project ? `project: ${slugify(input.project)}` : null,
    `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    `updated: ${date}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.content.trim(),
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  await writeText(absolutePath, frontmatter);
  return readNote(vaultPath, relPath);
}

export async function vaultInfo(vaultPath: string): Promise<{
  vaultPath: string;
  readable: boolean;
  agentsMd: boolean;
  noteCount: number;
  error?: string;
}> {
  try {
    const agentsMd = await pathExists(join(vaultPath, "AGENTS.md"));
    // Directory existence: try listing notes
    const paths = await listNotePaths(vaultPath);
    return {
      vaultPath,
      readable: agentsMd || paths.length > 0,
      agentsMd,
      noteCount: paths.length,
    };
  } catch (err) {
    return {
      vaultPath,
      readable: false,
      agentsMd: false,
      noteCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function noteToSummary(note: VaultNote, maxBody = 2000): string {
  const body =
    note.body.length > maxBody
      ? `${note.body.slice(0, maxBody)}\n\n…(truncated)`
      : note.body;
  return `path: ${note.path}\ntitle: ${note.title}\n\n${body}`;
}

export type GuidanceType = "instruction" | "suggestion" | "workflow";

export type GuidanceHit = {
  path: string;
  scope: "global" | "project";
  type: GuidanceType;
  kindOrId: string;
  note: VaultNote;
};

export type ResolveGuidanceInput = {
  intent?: string;
  kind?: string;
  workflow_id?: string;
  /** When set with kind, only that type; otherwise kind loads instruction + suggestion. */
  type?: GuidanceType;
  project?: string;
};

export type UpsertGuidanceInput = {
  type: GuidanceType;
  content: string;
  title?: string;
  kind?: string;
  workflow_id?: string;
  scope: "global" | "project";
  project?: string;
  tags?: string[];
  /**
   * append (default) — add an ## Update block to an existing note.
   * replace — rewrite the whole note (frontmatter + title + content). Use to fix
   * wrongly placed or incorrect guidance without leaving stale sections.
   */
  mode?: "append" | "replace";
};

function guidancePaths(
  type: GuidanceType,
  kindOrId: string,
  projectSlug?: string,
): { project?: string; global: string } {
  const file = `${slugify(kindOrId)}.md`;
  if (type === "instruction") {
    return {
      project: projectSlug
        ? toPosix(join("projects", slugify(projectSlug), "instructions", file))
        : undefined,
      global: toPosix(join("instructions", "global", file)),
    };
  }
  if (type === "suggestion") {
    return {
      project: projectSlug
        ? toPosix(join("projects", slugify(projectSlug), "suggestions", file))
        : undefined,
      global: toPosix(join("suggestions", "global", file)),
    };
  }
  return {
    project: projectSlug
      ? toPosix(join("projects", slugify(projectSlug), "workflows", file))
      : undefined,
    global: toPosix(join("workflows", "global", file)),
  };
}

async function tryRead(
  vaultPath: string,
  relPath: string,
): Promise<VaultNote | null> {
  const abs = resolve(vaultPath, relPath);
  if (!(await pathExists(abs))) return null;
  return readNote(vaultPath, relPath);
}

function isGuidancePath(path: string): boolean {
  return (
    path.startsWith("instructions/") ||
    path.startsWith("suggestions/") ||
    path.startsWith("workflows/") ||
    /\/instructions\//.test(path) ||
    /\/suggestions\//.test(path) ||
    /\/workflows\//.test(path)
  );
}

function kindFromPath(path: string): string {
  return basename(path).replace(/\.md$/i, "");
}

function guidanceTypeFromPath(path: string): GuidanceType {
  if (path.includes("/suggestions/") || path.startsWith("suggestions/")) {
    return "suggestion";
  }
  if (path.includes("/workflows/") || path.startsWith("workflows/")) {
    return "workflow";
  }
  return "instruction";
}

function scopeFromPath(path: string): "global" | "project" {
  return path.startsWith("projects/") ? "project" : "global";
}

export async function listGuidance(
  vaultPath: string,
  project?: string,
): Promise<{
  instructions: { scope: string; kind: string; path: string }[];
  suggestions: { scope: string; kind: string; path: string }[];
  workflows: { scope: string; id: string; path: string }[];
}> {
  const paths = (await listNotePaths(vaultPath)).filter(isGuidancePath);
  const instructions: { scope: string; kind: string; path: string }[] = [];
  const suggestions: { scope: string; kind: string; path: string }[] = [];
  const workflows: { scope: string; id: string; path: string }[] = [];
  const projectSlug = project ? slugify(project) : undefined;

  for (const path of paths) {
    if (path.endsWith("README.md") || path.endsWith("_index.md")) continue;
    const kindOrId = kindFromPath(path);
    const scope = scopeFromPath(path);
    if (
      projectSlug &&
      scope === "project" &&
      !path.startsWith(`projects/${projectSlug}/`)
    ) {
      continue;
    }
    const type = guidanceTypeFromPath(path);
    if (type === "instruction") {
      instructions.push({ scope, kind: kindOrId, path });
    } else if (type === "suggestion") {
      suggestions.push({ scope, kind: kindOrId, path });
    } else {
      workflows.push({ scope, id: kindOrId, path });
    }
  }

  instructions.sort((a, b) => a.path.localeCompare(b.path));
  suggestions.sort((a, b) => a.path.localeCompare(b.path));
  workflows.sort((a, b) => a.path.localeCompare(b.path));
  return { instructions, suggestions, workflows };
}

export async function resolveGuidance(
  vaultPath: string,
  input: ResolveGuidanceInput,
): Promise<{
  hits: GuidanceHit[];
  mode: "exact" | "search" | "none";
  message: string;
}> {
  const projectSlug = input.project ? slugify(input.project) : undefined;
  const hits: GuidanceHit[] = [];

  const tryExact = async (
    type: GuidanceType,
    kindOrId: string,
  ): Promise<void> => {
    const paths = guidancePaths(type, kindOrId, projectSlug);
    if (paths.project) {
      const note = await tryRead(vaultPath, paths.project);
      if (note) {
        hits.push({
          path: paths.project,
          scope: "project",
          type,
          kindOrId: slugify(kindOrId),
          note,
        });
      }
    }
    const globalNote = await tryRead(vaultPath, paths.global);
    if (globalNote) {
      hits.push({
        path: paths.global,
        scope: "global",
        type,
        kindOrId: slugify(kindOrId),
        note: globalNote,
      });
    }
  };

  if (input.kind) {
    if (input.type === "suggestion") {
      await tryExact("suggestion", input.kind);
    } else if (input.type === "instruction") {
      await tryExact("instruction", input.kind);
    } else if (input.type === "workflow") {
      await tryExact("workflow", input.kind);
    } else {
      await tryExact("instruction", input.kind);
      await tryExact("suggestion", input.kind);
    }
  }
  if (input.workflow_id) {
    await tryExact("workflow", input.workflow_id);
  }

  if (hits.length) {
    return {
      hits,
      mode: "exact",
      message:
        "Apply project over global when both present. Instructions are binding; suggestions are soft (prefer, not must).",
    };
  }

  // Intent / keyword fallback within guidance trees
  const query =
    input.intent?.trim() ||
    [input.kind, input.workflow_id].filter(Boolean).join(" ");
  if (!query) {
    return {
      hits: [],
      mode: "none",
      message:
        "No guidance found. Ask before creating binding instructions; soft prefs may use suggestions.",
    };
  }

  // Synonym → kind shortcuts
  const lower = query.toLowerCase();
  const synonymKind =
    /\b(pr|pull[- ]?request)[- ]?(review)?\b/.test(lower)
      ? "pr-review"
      : /\bcommit(\s+message)?s?\b/.test(lower)
        ? "commit"
        : /\bcod(e|ing)\b|\bimplement/.test(lower)
          ? "coding"
          : /\bgit\b|\bbranch/.test(lower)
            ? "git"
            : null;
  if (synonymKind && !input.kind) {
    await tryExact("instruction", synonymKind);
    await tryExact("suggestion", synonymKind);
    if (hits.length) {
      return {
        hits,
        mode: "exact",
        message:
          "Matched via intent synonym. Instructions binding; suggestions soft. Project over global.",
      };
    }
  }

  // OR-style search within guidance paths only
  const terms = lower
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
  const paths = (await listNotePaths(vaultPath)).filter(isGuidancePath);
  type Scored = { path: string; score: number };
  const scored: Scored[] = [];
  for (const path of paths) {
    if (path.endsWith("README.md") || path.endsWith("_index.md")) continue;
    if (
      projectSlug &&
      path.startsWith("projects/") &&
      !path.startsWith(`projects/${projectSlug}/`)
    ) {
      continue;
    }
    const note = await readNote(vaultPath, path);
    const hay = `${path}\n${note.title}\n${note.body}`.toLowerCase();
    let score = 0;
    for (const term of terms.length ? terms : [lower]) {
      if (hay.includes(term)) score += 2;
      if (note.title.toLowerCase().includes(term)) score += 3;
      if (path.toLowerCase().includes(term)) score += 2;
    }
    if (score > 0) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score);

  for (const h of scored.slice(0, 8)) {
    const note = await readNote(vaultPath, h.path);
    hits.push({
      path: h.path,
      scope: scopeFromPath(h.path),
      type: guidanceTypeFromPath(h.path),
      kindOrId: kindFromPath(h.path),
      note,
    });
  }

  // Prefer project hits first; instructions before suggestions before workflows
  const typeRank = (t: GuidanceType) =>
    t === "instruction" ? 0 : t === "suggestion" ? 1 : 2;
  hits.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    if (a.type !== b.type) return typeRank(a.type) - typeRank(b.type);
    return a.path.localeCompare(b.path);
  });

  if (!hits.length) {
    return {
      hits: [],
      mode: "none",
      message:
        "No matching instruction/suggestion/workflow. Tell the user none exists; ask before creating binding instructions.",
    };
  }

  return {
    hits: hits.slice(0, 8),
    mode: "search",
    message:
      "Search matches — prefer exact kind/id next time. Instructions binding; suggestions soft.",
  };
}

export async function upsertGuidance(
  vaultPath: string,
  input: UpsertGuidanceInput,
): Promise<VaultNote> {
  if (input.scope === "project" && !input.project) {
    throw new Error("scope=project requires project (git repo slug)");
  }
  const kindOrId =
    input.type === "workflow"
      ? input.workflow_id ?? input.kind
      : input.kind ?? input.workflow_id;
  if (!kindOrId) {
    throw new Error(
      input.type === "workflow"
        ? "workflow_id is required"
        : "kind is required for instructions/suggestions",
    );
  }

  if (input.scope === "project" && input.project) {
    await ensureProject(vaultPath, input.project);
  }

  const paths = guidancePaths(
    input.type,
    kindOrId,
    input.scope === "project" ? input.project : undefined,
  );
  const relPath =
    input.scope === "project" ? paths.project! : paths.global;
  const abs = resolve(vaultPath, relPath);
  assertInsideVault(vaultPath, abs);
  await mkdir(dirname(abs), { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const tags = input.tags ?? [];
  const title =
    input.title ??
    (input.type === "workflow"
      ? `Workflow: ${kindOrId}`
      : input.type === "suggestion"
        ? `Suggestions: ${kindOrId}`
        : `Instructions: ${kindOrId}`);
  const writeMode = input.mode ?? "append";

  const renderNote = (): string =>
    [
      "---",
      `type: ${input.type}`,
      input.type === "workflow"
        ? `id: ${slugify(kindOrId)}`
        : `kind: ${slugify(kindOrId)}`,
      input.type === "suggestion" ? "weight: soft" : null,
      `scope: ${input.scope}`,
      input.project ? `project: ${slugify(input.project)}` : null,
      `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`,
      `updated: ${date}`,
      "---",
      "",
      `# ${title}`,
      "",
      input.content.trim(),
      "",
    ]
      .filter((l) => l !== null)
      .join("\n");

  if (await pathExists(abs)) {
    if (writeMode === "replace") {
      await writeText(abs, renderNote());
      return readNote(vaultPath, relPath);
    }
    const prev = await readText(abs);
    await writeText(
      abs,
      `${prev.trimEnd()}\n\n## Update ${date}\n\n${input.content.trim()}\n`,
    );
    return readNote(vaultPath, relPath);
  }

  await writeText(abs, renderNote());
  return readNote(vaultPath, relPath);
}
