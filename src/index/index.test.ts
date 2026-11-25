import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeText } from "../runtime.ts";
import {
  chunkMarkdown,
  extractNoteMetadata,
  extractWikilinks,
  searchHybrid,
  syncVaultIndex,
  tokenizeForFts,
  type Embedder,
} from "./index.ts";

/**
 * Deterministic concept-space embedder for fast, offline unit tests.
 * Maps synonyms/paraphrases into shared semantic dimensions so tests verify
 * vector recall with zero lexical overlap.
 */
function createSemanticMockEmbedder(): Embedder {
  const concepts: RegExp[] = [
    /\b(auth|jwt|oauth|login|session|token|signin|credential|cookie)\b/i,
    /\b(database|postgres|sqlite|sql|schema|migration|query|index)\b/i,
    /\b(deploy|docker|kubernetes|ci|pipeline|release|rollout|container)\b/i,
    /\b(cache|redis|latency|throughput|performance|fast|speed|memory)\b/i,
    /\b(react|frontend|css|tailwind|layout|component|ui|browser)\b/i,
    /\b(test|jest|vitest|assert|coverage|regression|mock|fixture)\b/i,
    /\b(git|branch|rebase|commit|pr|review|merge|worktree)\b/i,
    /\b(observability|logging|metrics|tracing|alert|telemetry|monitor)\b/i,
  ];

  return {
    model: "mock-concept-v1",
    dims: concepts.length,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        const vec = new Float32Array(concepts.length);
        let norm = 0;
        for (let i = 0; i < concepts.length; i++) {
          const matches = text.match(new RegExp(concepts[i]!.source, "gi"));
          const val = matches ? Math.min(3, matches.length) : 0;
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
  };
}

async function seedTestVault(): Promise<{ vault: string; dbPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "ai-mcp-brain-index-"));
  const vault = join(root, "vault");
  const dbPath = join(root, "index.sqlite");

  await writeText(
    join(vault, "projects/alpha-api/decisions.md"),
    `---
type: project
scope: project
project: alpha-api
tags: [security, backend]
updated: 2026-11-20
---

# Decisions

## Short-lived JWT refresh rotation

Use 15-minute JWT access tokens with rotating refresh cookies stored in HttpOnly flags.
See [[../../stack/catalog/redis]] for revocation storage and [[gotchas]] for clock skew.

## Postgres connection pooling

Use PgBouncer in transaction pooling mode to prevent serverless connection exhaustion.
`,
  );

  await writeText(
    join(vault, "projects/alpha-api/gotchas.md"),
    `---
type: project
scope: project
project: alpha-api
tags: [backend]
updated: 2026-11-18
---

# Gotchas

## Clock skew breaks token verification

Allow a 30-second leeway when validating signed claims across containers.
`,
  );

  await writeText(
    join(vault, "stack/catalog/redis.md"),
    `---
type: stack
scope: global
tags: [tool, cache]
updated: 2026-11-15
---

# Redis

In-memory key-value store used for fast rate limiting and token revocation lists.
`,
  );

  await writeText(
    join(vault, "patterns/deployment-pipeline.md"),
    `---
type: pattern
scope: global
tags: [devops, ci]
updated: 2025-05-01
---

# Zero-downtime container rollout

Build immutable Docker images in CI and roll out with health-checked blue/green swaps.
`,
  );

  await writeText(
    join(vault, "suggestions/global/coding.md"),
    `---
type: suggestion
kind: coding
scope: global
tags: [style]
updated: 2026-11-22
---

# Coding preferences

Prefer small pure functions and explicit error types over deep inheritance hierarchies.
`,
  );

  return { vault, dbPath };
}

describe("chunker & metadata", () => {
  it("parses frontmatter, infers path metadata, and tolerates malformed YAML", () => {
    const good = extractNoteMetadata(
      "projects/demo-app/decisions.md",
      "---\ntags: [api, db]\nupdated: 2026-11-01\n---\n\n# Decisions\n\nBody text",
    );
    assert.equal(good.meta.title, "Decisions");
    assert.equal(good.meta.project, "demo-app");
    assert.equal(good.meta.scope, "project");
    assert.equal(good.meta.type, "project");
    assert.deepEqual(good.meta.tags, ["api", "db"]);

    const broken = extractNoteMetadata(
      "patterns/broken.md",
      "---\n: invalid: [yaml\n---\n\n# Still Parsed\n\nContent",
    );
    assert.equal(broken.meta.title, "Still Parsed");
    assert.equal(broken.meta.type, "pattern");
    assert.equal(broken.meta.scope, "global");
  });

  it("chunks by headings while ignoring hashes inside code fences", () => {
    const md = [
      "# Main",
      "Intro",
      "```bash",
      "# not a heading",
      "echo hi",
      "```",
      "## Section A",
      "Details for A",
      "### Sub A1",
      "Details for A1",
    ].join("\n");

    const chunks = chunkMarkdown("Main", md);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0]!.heading, "Main");
    assert.match(chunks[0]!.content, /# not a heading/);
    assert.equal(chunks[1]!.heading, "Main > Section A");
    assert.equal(chunks[2]!.heading, "Main > Section A > Sub A1");
  });

  it("extracts wikilinks outside code blocks and strips aliases/headings", () => {
    const md = [
      "See [[stack/catalog/redis|Redis]] and [[decisions#Auth]].",
      "Inline `[[ignored-inline]]` and ![[embedded.png]].",
      "```md",
      "[[ignored-fence]]",
      "```",
    ].join("\n");
    assert.deepEqual(extractWikilinks(md), ["stack/catalog/redis", "decisions"]);
  });

  it("sanitizes special FTS5 punctuation safely", () => {
    assert.deepEqual(tokenizeForFts("pr-review: PROJ-123 / src/vault.ts"), [
      "pr",
      "review",
      "proj",
      "123",
      "src",
      "vault",
      "ts",
    ]);
  });
});

describe("incremental sync & hybrid search", () => {
  it("syncs incrementally: initial -> unchanged -> touch -> edit -> delete", async () => {
    const { vault, dbPath } = await seedTestVault();
    const embedder = createSemanticMockEmbedder();
    try {
      // 1. Initial sync
      const s1 = await syncVaultIndex(vault, { dbPath, embedder });
      assert.equal(s1.scanned, 5);
      assert.equal(s1.added, 5);
      assert.equal(s1.updated, 0);
      assert.equal(s1.unchanged, 0);
      assert.ok(s1.embeddedChunks >= 5);
      assert.equal(s1.linksResolved, 2); // redis + gotchas

      // 2. Immediate re-sync is a pure no-op
      const s2 = await syncVaultIndex(vault, { dbPath, embedder });
      assert.equal(s2.added, 0);
      assert.equal(s2.updated, 0);
      assert.equal(s2.unchanged, 5);
      assert.equal(s2.embeddedChunks, 0);

      // 3. Touching mtime without changing content skips re-chunking/re-embedding
      const redisPath = join(vault, "stack/catalog/redis.md");
      const future = new Date(Date.now() + 5000);
      await utimes(redisPath, future, future);
      const s3 = await syncVaultIndex(vault, { dbPath, embedder });
      assert.equal(s3.updated, 0);
      assert.equal(s3.unchanged, 5);
      assert.equal(s3.embeddedChunks, 0);

      // 4. Editing content re-indexes only the modified file
      await writeText(
        redisPath,
        "---\ntype: stack\nscope: global\ntags: [tool, cache]\nupdated: 2026-11-25\n---\n\n# Redis\n\nUpdated note about low-latency caching.\n",
      );
      const s4 = await syncVaultIndex(vault, { dbPath, embedder });
      assert.equal(s4.updated, 1);
      assert.equal(s4.unchanged, 4);
      assert.equal(s4.embeddedChunks, 1);

      // 5. Deleting a note removes it from index cleanly
      await rm(join(vault, "patterns/deployment-pipeline.md"));
      const s5 = await syncVaultIndex(vault, { dbPath, embedder });
      assert.equal(s5.deleted, 1);
      assert.equal(s5.scanned, 4);
    } finally {
      await rm(join(vault, ".."), { recursive: true, force: true });
    }
  });

  it("recalls semantic matches with zero keyword overlap and includes 1-hop wikilinks", async () => {
    const { vault, dbPath } = await seedTestVault();
    const embedder = createSemanticMockEmbedder();
    try {
      // Query uses "signin credential" — neither word appears in alpha-api/decisions.md (which uses JWT/cookie)
      const res = await searchHybrid(vault, "how do user signin credentials work", {
        dbPath,
        embedder,
        minVectorScore: 0.3,
      });

      assert.equal(res.modeUsed, "hybrid");
      const decisionsHit = res.hits.find(
        (h) => h.path === "projects/alpha-api/decisions.md",
      );
      assert.ok(decisionsHit, "expected alpha-api/decisions.md in semantic hits");
      assert.ok(decisionsHit.matchedBy.includes("vector"));
      assert.ok(decisionsHit.relatedLinks.includes("stack/catalog/redis.md"));
      assert.ok(decisionsHit.relatedLinks.includes("projects/alpha-api/gotchas.md"));

      // Pure semantic query with single-concept match ranks #1
      const dbRes = await searchHybrid(vault, "sql schema migration strategy", {
        dbPath,
        embedder,
        minVectorScore: 0.3,
      });
      assert.equal(dbRes.hits[0]?.path, "projects/alpha-api/decisions.md");
      assert.deepEqual(dbRes.hits[0]?.matchedBy, ["vector"]);

      // Incoming backlink check: searching for Redis shows alpha-api/decisions.md as a related link
      const redisRes = await searchHybrid(vault, "Redis rate limiting", {
        dbPath,
        embedder,
        minVectorScore: 0.3,
      });
      assert.equal(redisRes.hits[0]!.path, "stack/catalog/redis.md");
      assert.ok(
        redisRes.hits[0]!.relatedLinks.includes("projects/alpha-api/decisions.md"),
      );
    } finally {
      await rm(join(vault, ".."), { recursive: true, force: true });
    }
  });

  it("supports FTS5 Porter stemming, structured filters, and graceful fallback on embed failure", async () => {
    const { vault, dbPath } = await seedTestVault();
    try {
      // Stemming: "rotating" / "rotated" matches "rotation" via Porter stemmer
      const ftsRes = await searchHybrid(vault, "rotated", {
        dbPath,
        mode: "fts",
      });
      assert.equal(ftsRes.modeUsed, "fts");
      assert.equal(ftsRes.hits[0]?.path, "projects/alpha-api/decisions.md");

      // Structured filters: scope=global excludes project notes
      const filtered = await searchHybrid(vault, "token", {
        dbPath,
        mode: "fts",
        scope: "global",
      });
      assert.ok(filtered.hits.length >= 1);
      assert.ok(filtered.hits.every((h) => h.scope === "global"));

      // updatedAfter filter excludes 2025 note
      const recentOnly = await searchHybrid(vault, "container", {
        dbPath,
        mode: "fts",
        updatedAfter: "2026-01-01",
      });
      assert.ok(
        recentOnly.hits.every((h) => h.path !== "patterns/deployment-pipeline.md"),
      );

      // Exact tag filter: "back" must not substring-match tag "backend"
      const badTag = await searchHybrid(vault, "PgBouncer", {
        dbPath,
        mode: "fts",
        tags: ["back"],
      });
      assert.equal(badTag.hits.length, 0);

      const goodTag = await searchHybrid(vault, "PgBouncer", {
        dbPath,
        mode: "fts",
        tags: ["backend"],
      });
      assert.equal(goodTag.hits[0]?.path, "projects/alpha-api/decisions.md");

      // Project filter accepts non-slugified casing/spaces
      const projHit = await searchHybrid(vault, "PgBouncer", {
        dbPath,
        mode: "fts",
        project: "Alpha API",
      });
      assert.equal(projHit.hits[0]?.path, "projects/alpha-api/decisions.md");

      // Empty query returns empty hits without throwing
      const empty = await searchHybrid(vault, "   ", { dbPath, mode: "fts" });
      assert.equal(empty.hits.length, 0);

      // Broken embedder degrades gracefully to FTS5 instead of throwing
      const brokenEmbedder: Embedder = {
        model: "broken-v1",
        dims: 8,
        async embed() {
          throw new Error("simulated offline error");
        },
      };
      const degraded = await searchHybrid(vault, "PgBouncer pooling", {
        dbPath,
        embedder: brokenEmbedder,
      });
      assert.ok(degraded.embedWarning);
      assert.equal(degraded.hits[0]?.path, "projects/alpha-api/decisions.md");
    } finally {
      await rm(join(vault, ".."), { recursive: true, force: true });
    }
  });
});
