import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { configDir } from "./config.ts";

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
    const glob = new Bun.Glob(pattern);
    for await (const rel of glob.scan({
      cwd: root,
      onlyFiles: true,
      dot: false,
    })) {
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

  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
    throw new Error(`Note not found: ${cleaned}`);
  }

  const body = await file.text();
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
    const destFile = Bun.file(dest);
    if (await destFile.exists()) continue;

    const src = join(templateDir, name);
    const srcFile = Bun.file(src);
    let body: string;
    if (await srcFile.exists()) {
      body = (await srcFile.text()).replaceAll("{{PROJECT_SLUG}}", slug);
    } else {
      body = `# ${slug}\n`;
    }
    await Bun.write(dest, body);
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
  if (!(await Bun.file(abs).exists())) {
    await mkdir(dirname(abs), { recursive: true });
    const template = resolve(
      configDir(),
      "templates",
      "vault",
      "stack",
      "recent.md",
    );
    if (await Bun.file(template).exists()) {
      await Bun.write(abs, Bun.file(template));
    } else {
      await Bun.write(
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
  const body = await Bun.file(abs).text();
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

  await Bun.write(abs, `${header.trimEnd()}\n\n${entries.join("\n")}\n`);
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
  const existing = Bun.file(abs);
  if (await existing.exists()) {
    const prev = await existing.text();
    const appended = `${prev.trimEnd()}\n\n## Update ${date}\n\n${input.summary.trim()}\n`;
    await Bun.write(abs, appended);
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
    await Bun.write(abs, body);
  }

  await prependRecent(
    vaultPath,
    `- ${date} · ${input.name} · ${input.summary.trim().replace(/\s+/g, " ").slice(0, 120)} · [[catalog/${slug}]]`,
  );

  if (input.project) {
    const { slug: projectSlug } = await ensureProject(vaultPath, input.project);
    const toolsPath = toPosix(join("projects", projectSlug, "tools.md"));
    const toolsAbs = resolve(vaultPath, toolsPath);
    const toolsFile = Bun.file(toolsAbs);
    const tip = `- ${date} · [[../../stack/catalog/${slug}|${input.name}]] — ${input.summary.trim().replace(/\s+/g, " ").slice(0, 100)}`;
    if (await toolsFile.exists()) {
      const prev = await toolsFile.text();
      if (!prev.toLowerCase().includes(slug.toLowerCase())) {
        await Bun.write(toolsAbs, `${prev.trimEnd()}\n${tip}\n`);
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
    const existing = Bun.file(absolutePath);
    if (await existing.exists()) {
      const prev = await existing.text();
      const block = `\n## ${input.title} (${date})\n\n${input.content.trim()}\n`;
      await Bun.write(absolutePath, `${prev.trimEnd()}\n${block}`);
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

  const existing = Bun.file(absolutePath);
  if (await existing.exists()) {
    const prev = await existing.text();
    const appended = `${prev.trimEnd()}\n\n## Update ${date}\n\n${input.content.trim()}\n`;
    await Bun.write(absolutePath, appended);
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

  await Bun.write(absolutePath, frontmatter);
  return readNote(vaultPath, relPath);
}

export function noteToSummary(note: VaultNote, maxBody = 2000): string {
  const body =
    note.body.length > maxBody
      ? `${note.body.slice(0, maxBody)}\n\n…(truncated)`
      : note.body;
  return `path: ${note.path}\ntitle: ${note.title}\n\n${body}`;
}
