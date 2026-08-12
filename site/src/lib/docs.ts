import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { marked } from "marked";
import GithubSlugger from "github-slugger";

/** Repo docs/ — cwd is site/ for astro dev/build. */
const docsRoot = resolve(process.cwd(), "../docs");
const repoRoot = resolve(process.cwd(), "..");

/** WIP / not ready for the public docs UI (files may still exist under docs/). */
const HIDDEN_DOC_SLUGS = new Set(["features/work-desk", "guides/work-desk"]);

export type DocNavItem = {
  title: string;
  href: string;
  group: "overview" | "features" | "guides" | "reference" | "install";
};

export type DocPage = {
  slug: string;
  title: string;
  description: string;
  href: string;
  group: DocNavItem["group"];
  html: string;
  sourcePath: string;
};

marked.setOptions({ gfm: true });

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(abs)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(abs);
    }
  }
  return out;
}

function titleFromMarkdown(md: string, fallback: string): string {
  const h1 = md.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].replace(/\s*—.*$/, "").trim();
  return fallback;
}

function descriptionFromMarkdown(md: string): string {
  const lines = md.split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("|") || t.startsWith("-") || t.startsWith("```")) {
      continue;
    }
    return t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").slice(0, 160);
  }
  return "Hem Vault documentation";
}

function pathToSlug(abs: string): string {
  const rel = relative(docsRoot, abs).split(sep).join("/");
  if (rel === "README.md") return "index";
  return rel.replace(/\.md$/, "");
}

function groupForSlug(slug: string): DocNavItem["group"] {
  if (slug.startsWith("features/")) return "features";
  if (slug.startsWith("guides/")) return "guides";
  if (slug.startsWith("reference/")) return "reference";
  if (slug === "install" || slug === "uninstall") return "install";
  return "overview";
}

function hrefForSlug(slug: string): string {
  return slug === "index" ? "/docs" : `/docs/${slug}`;
}

function rewriteMarkdownLinks(md: string, fromSlug: string): string {
  return md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, text, url: string) => {
    if (/^(https?:|mailto:|#)/i.test(url)) return full;

    let target = url;
    // INSTALL / UNINSTALL from docs
    if (target === "../INSTALL.md" || target.endsWith("/INSTALL.md")) {
      return `[${text}](/docs/install)`;
    }
    if (target === "../UNINSTALL.md" || target.endsWith("/UNINSTALL.md")) {
      return `[${text}](/docs/uninstall)`;
    }

    if (target.endsWith(".md") || target.includes(".md#")) {
      const [pathPart, hash] = target.split("#");
      const fromDir = fromSlug === "index" ? "" : fromSlug.includes("/")
        ? fromSlug.split("/").slice(0, -1).join("/")
        : "";
      let resolved = pathPart;
      if (resolved.startsWith("./")) resolved = resolved.slice(2);
      if (resolved.startsWith("../")) {
        // relative to docs/README → repo; already handled INSTALL
        const up = resolved.replace(/^\.\.\//, "");
        if (up === "how-it-works.md" || !up.includes("/")) {
          resolved = up;
        } else {
          resolved = up;
        }
      } else if (fromDir) {
        resolved = `${fromDir}/${resolved}`.replace(/\/+/g, "/");
      }
      resolved = resolved.replace(/\.md$/, "");
      if (resolved === "README" || resolved.endsWith("/README")) {
        resolved = "index";
      }
      // normalize ../ from nested pages pointing at sibling folders
      const parts = resolved.split("/");
      const stack: string[] = [];
      for (const p of parts) {
        if (p === "..") stack.pop();
        else if (p && p !== ".") stack.push(p);
      }
      const slug = stack.join("/") || "index";
      const href = hrefForSlug(slug) + (hash ? `#${hash}` : "");
      return `[${text}](${href})`;
    }

    // in-site anchors already ok
    if (target.startsWith("/")) return full;
    return full;
  });
}

function addHeadingIds(html: string): string {
  const slugger = new GithubSlugger();
  return html.replace(/<h([2-3])>(.*?)<\/h\1>/g, (_m, level, inner) => {
    const text = String(inner).replace(/<[^>]+>/g, "");
    const id = slugger.slug(text);
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
}

async function loadRepoMarkdown(filename: string, slug: string, titleFallback: string): Promise<DocPage> {
  const sourcePath = join(repoRoot, filename);
  const raw = await readFile(sourcePath, "utf8");
  const rewritten = rewriteMarkdownLinks(raw, slug);
  const title = titleFromMarkdown(raw, titleFallback);
  const html = addHeadingIds(await marked.parse(rewritten));
  return {
    slug,
    title,
    description: descriptionFromMarkdown(raw),
    href: hrefForSlug(slug),
    group: "install",
    html,
    sourcePath,
  };
}

export async function getAllDocs(): Promise<DocPage[]> {
  const files = await walkMarkdown(docsRoot);
  const pages: DocPage[] = [];

  for (const abs of files) {
    const slug = pathToSlug(abs);
    if (HIDDEN_DOC_SLUGS.has(slug)) continue;
    const raw = await readFile(abs, "utf8");
    const rewritten = rewriteMarkdownLinks(raw, slug);
    const title = titleFromMarkdown(raw, slug);
    const html = addHeadingIds(await marked.parse(rewritten));
    pages.push({
      slug,
      title,
      description: descriptionFromMarkdown(raw),
      href: hrefForSlug(slug),
      group: groupForSlug(slug),
      html,
      sourcePath: abs,
    });
  }

  pages.push(await loadRepoMarkdown("INSTALL.md", "install", "Install"));
  pages.push(await loadRepoMarkdown("UNINSTALL.md", "uninstall", "Uninstall"));

  return pages.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function getDocBySlug(slug: string): Promise<DocPage | undefined> {
  const all = await getAllDocs();
  const key = !slug || slug === "" ? "index" : slug;
  return all.find((p) => p.slug === key);
}

export function navGroups(pages: DocPage[]): { label: string; items: DocNavItem[] }[] {
  const order: { key: DocNavItem["group"]; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "features", label: "Features" },
    { key: "guides", label: "Guides" },
    { key: "reference", label: "Reference" },
    { key: "install", label: "Install" },
  ];

  const overviewOrder = ["index", "how-it-works"];
  return order.map(({ key, label }) => {
    let items = pages
      .filter((p) => p.group === key)
      .map((p) => ({ title: navTitle(p), href: p.href, group: p.group }));
    if (key === "overview") {
      items.sort(
        (a, b) =>
          overviewOrder.indexOf(slugFromHref(a.href)) -
          overviewOrder.indexOf(slugFromHref(b.href)),
      );
    } else {
      items.sort((a, b) => a.title.localeCompare(b.title));
    }
    return { label, items };
  });
}

function slugFromHref(href: string): string {
  if (href === "/docs") return "index";
  return href.replace(/^\/docs\//, "");
}

function navTitle(page: DocPage): string {
  if (page.slug === "index") return "Docs home";
  if (page.slug === "how-it-works") return "How it works";
  const short = page.title
    .replace(/^Feature:\s*/i, "")
    .replace(/^Guide:\s*/i, "")
    .replace(/^Reference:\s*/i, "")
    .replace(/^Agent install prompt[—–-].*$/i, "Install")
    .replace(/^Install Hem Vault.*$/i, "Install")
    .replace(/^Uninstall Hem Vault.*$/i, "Uninstall")
    .replace(/^ai-mcp-brain[—–-].*$/i, "Docs home");
  return short;
}
