import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Embedder } from "../index/index.ts";
import { readText, writeText } from "../runtime.ts";
import {
  bumpFrontmatterUpdated,
  getProjectContext,
  noteToTailSummary,
  rememberNote,
  resolveProjectSlug,
  trackTool,
  upsertGuidance,
} from "../vault.ts";
import {
  addMemorySmart,
  assertNoSecrets,
  deleteMemory,
  listMemories,
  parseMemoryFile,
  scanForSecrets,
  searchMemories,
  SecretDetectedError,
  supersedeMemory,
  updateMemory,
} from "./index.ts";

function createCountingMockEmbedder(): { embedder: Embedder; calls: number; docsEmbedded: number } {
  const concepts: RegExp[] = [
    /\b(auth|jwt|oauth|login|cookie|session|token)\b/i,
    /\b(bun|node|runtime|tsx|typescript|javascript)\b/i,
    /\b(postgres|sqlite|sql|database|pgbouncer|pool)\b/i,
    /\b(redis|cache|rate|limit|throttle)\b/i,
    /\b(docker|deploy|container|ci|rollout)\b/i,
    /\b(react|frontend|css|ui|component|hydration)\b/i,
  ];
  const state = {
    calls: 0,
    docsEmbedded: 0,
    embedder: {
      model: "mock-mem-v1",
      dims: concepts.length,
      async embed(texts: string[], mode: "document" | "query"): Promise<Float32Array[]> {
        state.calls++;
        if (mode === "document") state.docsEmbedded += texts.length;
        return texts.map((text) => {
          const vec = new Float32Array(concepts.length);
          let norm = 0;
          for (let i = 0; i < concepts.length; i++) {
            const m = text.match(new RegExp(concepts[i]!.source, "gi"));
            const val = m ? Math.min(3, m.length) : 0;
            vec[i] = val;
            norm += val * val;
          }
          const mag = Math.sqrt(norm);
          if (mag > 0) {
            for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / mag;
          }
          return vec;
        });
      },
    } satisfies Embedder,
  };
  return state;
}

describe("write-time secret guard", () => {
  it("blocks real-looking keys, tokens, private keys, and credentialed URLs without echoing secrets", () => {
    // Construct synthetic secret shapes dynamically so static scanners never mistake fixtures for real keys
    const fakeGh = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
    const fakePem = ["-----BEGIN ", "RSA PRIVATE KEY-----\nMIIE..."].join("");
    const fakeAws = ["AKIA", "9K7M2P4Q8R1T3V5W"].join("");
    const fakeJwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiJ1c2VyLTEyMyJ9",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(".");
    const fakeDbUrl = ["postgres://", "svc_prod", ":", "Tr9!xQ2mLp8vWz4n", "@db.internal.local/app"].join("");

    for (const sample of [fakeGh, fakePem, fakeAws, fakeJwt, fakeDbUrl]) {
      const findings = scanForSecrets(sample);
      assert.ok(findings.length >= 1, `expected secret detection for rule sample`);
      assert.throws(
        () => assertNoSecrets(sample),
        (err: unknown) => {
          assert.ok(err instanceof SecretDetectedError);
          // Error message must NEVER echo the secret value back
          assert.ok(!err.message.includes(sample));
          return true;
        },
      );
    }
  });

  it("allows normal engineering prose and obvious placeholders", () => {
    const safeNotes = [
      "Use 15-minute JWT access tokens with rotating HttpOnly refresh cookies.",
      "Set JIRA_API_TOKEN in .env (gitignored) and never commit credentials.",
      "Example header: Authorization: Bearer <your-token-here>",
      "Fake fixture URL: https://user:pass@example.com/api",
      "Config example: api_key = 'your-example-placeholder-key'",
    ];
    for (const note of safeNotes) {
      assert.deepEqual(scanForSecrets(note), [], `unexpected false positive on: ${note}`);
    }
  });
});

describe("vault fixes: frontmatter updated, tail truncation, projects-index, write guard", () => {
  it("bumps frontmatter updated date on append/edit and blocks secrets in remember/guidance/trackTool", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-mcp-brain-m2-vault-"));
    try {
      const today = new Date().toISOString().slice(0, 10);
      const decPath = join(root, "projects/demo-app/decisions.md");
      await writeText(
        decPath,
        "---\ntype: project\nscope: project\nproject: demo-app\nupdated: 2024-01-01\n---\n\n# Decisions\n\n## Old\nOld entry.\n",
      );

      await rememberNote(root, {
        title: "Use SQLite WAL",
        content: "Enable WAL mode for safe concurrent reads.",
        scope: "project",
        project: "demo-app",
        projectFile: "decisions",
      });
      const updatedBody = await readText(decPath);
      assert.match(updatedBody, new RegExp(`updated: ${today}`));

      const guidePath = join(root, "suggestions/global/coding.md");
      await writeText(
        guidePath,
        "---\ntype: suggestion\nkind: coding\nscope: global\nupdated: 2024-01-01\n---\n\n# Coding\n\n## Style\nKeep functions small.\n",
      );
      await upsertGuidance(root, {
        type: "suggestion",
        kind: "coding",
        scope: "global",
        mode: "replace_section",
        section: "Style",
        content: "Keep functions small and pure.",
      });
      assert.match(await readText(guidePath), new RegExp(`updated: ${today}`));

      const fakeToken = ["ghp", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"].join("_");
      await assert.rejects(
        () =>
          rememberNote(root, {
            title: "Leaked",
            content: `token is ${fakeToken}`,
            scope: "global",
          }),
        SecretDetectedError,
      );
      await assert.rejects(
        () =>
          trackTool(root, {
            name: "DemoTool",
            summary: `Use ${fakeToken}`,
          }),
        SecretDetectedError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves newest tail in noteToTailSummary instead of clipping bottom entries", () => {
    const oldFiller = "Older historical decision details. ".repeat(120);
    const body = `---\ntype: project\n---\n\n# Decisions\n\n${oldFiller}\n\n## Latest Decision (2026-11-25)\nAlways use BEGIN IMMEDIATE for SQLite writes.\n`;
    const summary = noteToTailSummary(
      {
        path: "projects/demo/decisions.md",
        absolutePath: "/tmp/decisions.md",
        title: "Decisions",
        excerpt: "",
        body,
      },
      1200,
    );
    assert.ok(summary.includes("Always use BEGIN IMMEDIATE for SQLite writes."));
    assert.ok(summary.includes("older chars omitted"));
  });

  it("auto-resolves _meta/projects-index.md for paths and remote URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-mcp-brain-m2-idx-"));
    try {
      await writeText(
        join(root, "_meta/projects-index.md"),
        [
          "# Projects index",
          "",
          "```",
          "/ignored/inside/fence → wrong-slug",
          "```",
          "",
          "/home/user/worktrees/my-repo-wt → canonical-app",
          "https://github.com/org/my-service.git -> canonical-service",
        ].join("\n"),
      );

      assert.equal(
        await resolveProjectSlug(root, "/home/user/worktrees/my-repo-wt"),
        "canonical-app",
      );
      assert.equal(
        await resolveProjectSlug(root, "https://github.com/org/my-service"),
        "canonical-service",
      );
      assert.equal(
        await resolveProjectSlug(root, "/ignored/inside/fence"),
        "ignored-inside-fence",
      );

      const ctx = await getProjectContext(root, "https://github.com/org/my-service.git");
      assert.ok(
        ctx.notes.some((n) => n.path.startsWith("projects/canonical-service/")),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inserts updated frontmatter field when missing", () => {
    const out = bumpFrontmatterUpdated("---\ntype: note\n---\n\n# Hi\n", "2026-11-25");
    assert.match(out, /updated: 2026-11-25/);
  });
});

describe("atomic memory store, dedup, supersede, and hybrid search", () => {
  it("supports full lifecycle: add -> dedupe noop -> update -> supersede -> active-only recall -> delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-mcp-brain-m2-mem-"));
    const vault = join(root, "vault");
    const dbPath = join(root, "index.sqlite");
    const mock = createCountingMockEmbedder();

    try {
      // 1. Add atomic global preference
      const a1 = await addMemorySmart(vault, {
        title: "Prefer Bun for local MCP",
        content: "Use Bun runtime for fast local MCP server startup when available.",
        scope: "global",
        category: "preferences",
        app: "claude",
        tags: ["runtime", "mcp"],
        embedder: mock.embedder,
        dbPath,
      });
      assert.equal(a1.action, "added");
      assert.equal(a1.memory.path, "memories/preferences.md");
      assert.equal(a1.memory.app, "claude");
      assert.match(a1.memory.id, /^m_[0-9a-f]{8}$/);

      // 2. Re-adding near-identical memory dedupes cleanly (action=noop)
      const dup = await addMemorySmart(vault, {
        title: "Prefer Bun for local MCP",
        content: "Use Bun runtime for fast local MCP server startup when available.",
        scope: "global",
        category: "preferences",
        app: "cursor",
        embedder: mock.embedder,
        dbPath,
      });
      assert.equal(dup.action, "noop");
      assert.equal(dup.memory.id, a1.memory.id);
      assert.equal((await listMemories(vault)).length, 1);

      // 3. Add a distinct memory in another domain + a project memory
      const a2 = await addMemorySmart(vault, {
        title: "Use PgBouncer pooling",
        content: "Route serverless Postgres traffic through PgBouncer transaction pooling.",
        scope: "project",
        project: "alpha-api",
        category: "decisions",
        app: "cursor",
        tags: ["postgres"],
        embedder: mock.embedder,
        dbPath,
      });
      assert.equal(a2.action, "added");
      assert.equal(a2.memory.path, "projects/alpha-api/memories.md");

      // 4. Update memory surgically by ID
      const upd = await updateMemory(vault, {
        id: a1.memory.id,
        content: "Prefer Bun runtime for local MCP scripts; fall back to Node + tsx.",
        tags: ["runtime", "mcp", "cli"],
      });
      assert.equal(upd.id, a1.memory.id);
      assert.ok(upd.tags.includes("cli"));

      // 5. Supersede memory: old stays in Markdown marked superseded, new is active
      const sup = await supersedeMemory(vault, a2.memory.id, {
        title: "Use Neon pooled endpoints",
        content: "Switched Postgres pooling from self-hosted PgBouncer to Neon built-in pooler.",
        app: "codex",
      });
      assert.equal(sup.superseded.status, "superseded");
      assert.equal(sup.superseded.supersededBy, sup.created.id);
      assert.equal(sup.created.supersedes, a2.memory.id);
      assert.equal(sup.created.status, "active");

      // Verify Obsidian Markdown preserves both blocks cleanly
      const projMd = await readText(join(vault, "projects/alpha-api/memories.md"));
      const parsed = parseMemoryFile("projects/alpha-api/memories.md", projMd);
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0]!.memory.id, sup.created.id); // newest first!
      assert.equal(parsed[1]!.memory.status, "superseded");

      // 6. Active-only search excludes superseded memory, while status=all includes both
      const activeSearch = await searchMemories(vault, "postgres pooling", {
        embedder: mock.embedder,
        dbPath,
        minVectorScore: 0.3,
      });
      assert.ok(activeSearch.hits.every((h) => h.memory.status === "active"));
      assert.equal(activeSearch.hits[0]?.memory.id, sup.created.id);

      // Re-searching reuses cached SQLite embeddings (zero new document embeddings!)
      const docsBefore = mock.docsEmbedded;
      await searchMemories(vault, "postgres pooling", {
        embedder: mock.embedder,
        dbPath,
        skipSync: true,
        minVectorScore: 0.3,
      });
      assert.equal(mock.docsEmbedded, docsBefore);

      const historySearch = await searchMemories(vault, "PgBouncer", {
        status: "all",
        mode: "fts",
        dbPath,
      });
      assert.ok(historySearch.hits.some((h) => h.memory.id === a2.memory.id));

      // 7. Delete memory permanently removes only that block
      await deleteMemory(vault, a1.memory.id);
      const remaining = await listMemories(vault, { status: "all" });
      assert.ok(remaining.every((m) => m.id !== a1.memory.id));
      assert.equal(remaining.length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
