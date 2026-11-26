import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DaemonStateStore, startBrainDaemon } from "../daemon/index.ts";
import { syncVaultIndex, type Embedder } from "../index/index.ts";
import { readText, writeText } from "../runtime.ts";
import {
  addMemoryRaw,
  approvePendingMemory,
  bootstrapContext,
  extractSessionCandidates,
  ingestSessionToPending,
  listMemories,
  runDreamConsolidation,
} from "./index.ts";

function createMockEmbedder(): Embedder {
  const concepts: RegExp[] = [
    /\b(postgres|sqlite|sql|database|pgbouncer|pool|wal)\b/i,
    /\b(auth|jwt|oauth|cookie|session|token)\b/i,
    /\b(redis|cache|rate|limit|throttle)\b/i,
    /\b(bun|node|runtime|tsx|typescript)\b/i,
  ];
  return {
    model: "mock-m4-v1",
    dims: concepts.length,
    async embed(texts: string[]): Promise<Float32Array[]> {
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
  };
}

function makeSynth(len: number, offset: number): string {
  const alphabet = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789!@#$";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[(i * 7 + offset) % alphabet.length]!;
  }
  return out;
}

function textOf(result: unknown): string {
  const obj = result && typeof result === "object" ? (result as { content?: unknown }) : {};
  const arr = Array.isArray(obj.content) ? obj.content : [];
  return arr
    .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
    .join("\n");
}

describe("Milestone 4: bootstrap_context, passive capture queue & brain dream consolidation", () => {
  it("extracts high-signal candidates offline, drops secrets & noise, dedupes, and atomically promotes pending approvals", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-mcp-brain-m4-cap-"));
    const vault = join(root, "vault");
    const stateDb = join(root, "daemon.sqlite");
    const indexDb = join(root, "index.sqlite");
    const embedder = createMockEmbedder();
    const synthSecret = makeSynth(22, 9);

    const store = await DaemonStateStore.open(vault, { dbPath: stateDb });
    try {
      const summary = [
        "ok thanks!",
        "Should we check the logs?",
        "Decided to use SQLite WAL mode with a 5s busy timeout for local index writes.",
        "Gotcha: always check closing markers before code fence state in Markdown parsers.",
        "Prefer Bun runtime for local MCP scripts when available.",
        `Gotcha: never commit PGPASSWORD=${synthSecret} to the vault.`,
      ].join("\n");

      const preview = extractSessionCandidates({
        summary,
        commits: [
          "wip",
          "fix: prevent symlink escape in project ACL filters",
        ],
        project: "alpha",
      });
      assert.equal(preview.skippedSecrets, 1);
      assert.ok(preview.candidates.length >= 4);
      for (const c of preview.candidates) {
        assert.ok(!c.content.includes(synthSecret));
      }

      const first = await ingestSessionToPending(vault, store, {
        summary,
        commits: ["fix: prevent symlink escape in project ACL filters"],
        project: "alpha",
        app: "cursor",
        session: "sess-1",
      });
      assert.equal(first.skippedSecrets, 1);
      assert.equal(first.staged.length, 4);
      assert.equal(store.countPendingMemories(), 4);

      // Re-ingesting the same session dedupes completely against pending queue
      const second = await ingestSessionToPending(vault, store, {
        summary,
        commits: ["fix: prevent symlink escape in project ACL filters"],
        project: "alpha",
        app: "cursor",
        session: "sess-2",
      });
      assert.equal(second.staged.length, 0);
      assert.equal(second.skippedDuplicates, 4);

      // Concurrent approve of the same pending ID: exactly one succeeds, one rejects
      const targetId = first.staged[0]!.id;
      const results = await Promise.allSettled([
        approvePendingMemory(vault, store, targetId, { indexDbPath: indexDb, embedder }),
        approvePendingMemory(vault, store, targetId, { indexDbPath: indexDb, embedder }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(store.countPendingMemories(), 3);

      // Promoted memory now exists in canonical Markdown vault
      const active = await listMemories(vault, { status: "active" });
      assert.equal(active.length, 1);

      // Dismiss one remaining candidate
      const dismissed = store.dismissPendingMemory(first.staged[1]!.id);
      assert.equal(dismissed.status, "dismissed");
      assert.equal(store.countPendingMemories(), 2);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runDreamConsolidation previews safely in dry-run, then consolidates duplicates & losslessly archives stale superseded blocks on apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-mcp-brain-m4-dream-"));
    const vault = join(root, "vault");
    const indexDb = join(root, "index.sqlite");
    const embedder = createMockEmbedder();

    try {
      // Create two near-duplicate active memories (bypassing smart dedup via addMemoryRaw)
      const d1 = await addMemoryRaw(vault, {
        title: "Use PgBouncer pooling",
        content: "Route serverless Postgres connections through PgBouncer transaction pooling.",
        scope: "project",
        project: "alpha",
        category: "decisions",
        tags: ["postgres"],
      });
      const d2 = await addMemoryRaw(vault, {
        title: "Use PgBouncer pooling",
        content: "Route serverless Postgres connections through PgBouncer transaction pooling.",
        scope: "project",
        project: "alpha",
        category: "decisions",
        tags: ["serverless", "pooling"],
      });

      // Create a conflict pair (same title, differing content)
      await addMemoryRaw(vault, {
        title: "Cache backend",
        content: "Use in-memory LRU cache for session lookups.",
        scope: "project",
        project: "alpha",
        category: "decisions",
      });
      await addMemoryRaw(vault, {
        title: "Cache backend",
        content: "Use Redis cluster for distributed rate limiting.",
        scope: "project",
        project: "alpha",
        category: "decisions",
      });

      // Seed an old (>90d) superseded memory block + a broken [[wikilink]]
      const factsPath = join(vault, "memories/facts.md");
      await writeText(
        factsPath,
        [
          "---",
          "type: memory",
          "scope: global",
          "category: facts",
          "updated: 2025-01-01",
          "---",
          "",
          "# Facts",
          "",
          "### Legacy API port",
          "<!-- mem:id=m_old00001 status=superseded superseded_by=m_missing9 app=cli category=facts created=2024-01-01 updated=2024-06-01 -->",
          "Old service ran on port 8080.",
          "<!-- /mem:m_old00001 -->",
          "",
        ].join("\n"),
      );
      await writeText(
        join(vault, "patterns/linked.md"),
        "---\ntype: pattern\nscope: global\n---\n\n# Links\nSee [[nonexistent-target-note]] for details.\n",
      );
      await syncVaultIndex(vault, { dbPath: indexDb, embedder });

      // 1. Dry-run preview must NOT mutate files
      const preview = await runDreamConsolidation(vault, {
        apply: false,
        pruneDays: 90,
        dbPath: indexDb,
        embedder,
      });
      assert.equal(preview.dryRun, true);
      assert.equal(preview.duplicateClusters.length, 1);
      assert.ok(preview.conflicts.length >= 1);
      assert.equal(preview.staleSuperseded.length, 1);
      assert.equal(preview.danglingSupersedeRefs.length, 1);
      assert.ok(preview.brokenWikilinks.some((l) => l.rawTarget === "nonexistent-target-note"));
      assert.equal(preview.actionsApplied.duplicatesConsolidated, 0);
      assert.equal((await listMemories(vault, { status: "active" })).length, 4);

      // 2. Apply consolidates duplicate (merges tags, marks older superseded without creating a 3rd block) & archives stale superseded
      const applied = await runDreamConsolidation(vault, {
        apply: true,
        pruneDays: 90,
        dbPath: indexDb,
        embedder,
      });
      assert.equal(applied.dryRun, false);
      assert.equal(applied.actionsApplied.duplicatesConsolidated, 1);
      assert.equal(applied.actionsApplied.supersededArchivedAndPruned, 1);
      assert.ok(applied.actionsApplied.archivePath?.startsWith("_meta/archive/memories-"));

      // Verify keeper kept merged tags and duplicate is now status=superseded
      const projAll = await listMemories(vault, { scope: "project", project: "alpha", status: "all" });
      const activeDupePair = projAll.filter((m) => m.id === d1.id || m.id === d2.id);
      assert.equal(activeDupePair.filter((m) => m.status === "active").length, 1);
      assert.equal(activeDupePair.filter((m) => m.status === "superseded").length, 1);
      const keeper = activeDupePair.find((m) => m.status === "active")!;
      assert.ok(keeper.tags.includes("postgres"));
      assert.ok(keeper.tags.includes("serverless"));

      // Verify stale superseded memory was losslessly archived before pruning
      const archiveContent = await readText(join(vault, applied.actionsApplied.archivePath!));
      assert.ok(archiveContent.includes("m_old00001"));
      assert.ok(archiveContent.includes("Old service ran on port 8080."));
      const remainingFacts = await listMemories(vault, { category: "facts", status: "all" });
      assert.equal(remainingFacts.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces ACLs & symlink isolation across bootstrap_context, pending MCP tools, consolidate_memories, and daemon REST API", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-mcp-brain-m4-e2e-"));
    const vault = join(root, "vault");
    const indexDb = join(root, "index.sqlite");
    const stateDb = join(root, "daemon.sqlite");
    const embedder = createMockEmbedder();
    const adminToken = makeSynth(24, 5);
    const roToken = makeSynth(24, 15);
    const rwAlphaToken = makeSynth(24, 21);

    await addMemoryRaw(vault, {
      title: "Global editor pref",
      content: "Prefer strict TypeScript across every repo.",
      scope: "global",
      category: "preferences",
    });
    await addMemoryRaw(vault, {
      title: "Alpha DB pool",
      content: "Alpha uses PgBouncer transaction pooling.",
      scope: "project",
      project: "alpha",
      category: "decisions",
    });
    await addMemoryRaw(vault, {
      title: "Secret beta key",
      content: "Beta top secret architecture note.",
      scope: "project",
      project: "beta",
      category: "decisions",
    });
    await writeText(join(vault, "projects/alpha/README.md"), "# alpha\nAlpha service overview documentation.\n");
    await writeText(join(vault, "projects/beta/README.md"), "# beta\nBeta secret readme documentation.\n");
    await symlink(
      join(vault, "projects/beta/README.md"),
      join(vault, "projects/alpha/sneaky-beta.md"),
    );

    const daemon = await startBrainDaemon({
      vaultPath: vault,
      port: 0,
      authToken: adminToken,
      appTokens: {
        "ro-alpha": roToken,
        "rw-alpha": rwAlphaToken,
      },
      stateDbPath: stateDb,
      indexDbPath: indexDb,
      embedder,
      warmup: false,
      watchVault: false,
      quiet: true,
      configApps: {
        "ro-alpha": {
          mode: "read-only",
          read_scopes: ["project"],
          allowed_projects: ["alpha"],
        },
        "rw-alpha": {
          mode: "read-write",
          read_scopes: ["project"],
          write_scopes: ["project"],
          allowed_projects: ["alpha"],
        },
      },
    });

    const roClient = new Client({ name: "ro-alpha", version: "1.0.0" });
    const rwClient = new Client({ name: "rw-alpha", version: "1.0.0" });

    try {
      await roClient.connect(
        new StreamableHTTPClientTransport(new URL(daemon.mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${roToken}` } },
        }),
      );
      await rwClient.connect(
        new StreamableHTTPClientTransport(new URL(daemon.mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${rwAlphaToken}` } },
        }),
      );

      // 1. Per-app write token can POST /api/ingest-session; read-only token is denied 403
      const roIngest = await fetch(`${daemon.url}/api/ingest-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${roToken}`,
        },
        body: JSON.stringify({
          summary: "Decided to use WAL mode for alpha SQLite cache.",
          project: "alpha",
        }),
      });
      assert.equal(roIngest.status, 403);

      const rwIngest = await fetch(`${daemon.url}/api/ingest-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${rwAlphaToken}`,
        },
        body: JSON.stringify({
          summary: [
            "Decided to use WAL mode for alpha SQLite cache.",
            "Prefer tabs over spaces globally from now on.",
          ].join("\n"),
          project: "alpha",
        }),
      });
      assert.equal(rwIngest.status, 200);
      const rwIngestJson = (await rwIngest.json()) as {
        staged: { id: string; scope: string; project: string | null }[];
        skippedByPolicy: number;
      };
      // Alpha-only app staged the alpha decision, while the global preference was skipped by policy!
      assert.equal(rwIngestJson.staged.length, 1);
      assert.equal(rwIngestJson.staged[0]?.project, "alpha");
      assert.equal(rwIngestJson.skippedByPolicy, 1);

      // 2. bootstrap_context on ro-alpha returns alpha memories + README, NEVER beta/global/symlink/vault path
      const bootRes = await roClient.callTool({
        name: "bootstrap_context",
        arguments: { project: "alpha", task: "database pooling", max_chars: 4000 },
      });
      assert.ok(!bootRes.isError);
      const bootText = textOf(bootRes);
      assert.ok(bootText.includes("Alpha DB pool"));
      assert.ok(bootText.includes("Alpha service overview"));
      assert.ok(bootText.includes("1 candidate memory awaiting approval"));
      assert.ok(!bootText.includes("Global editor pref"));
      assert.ok(!bootText.includes("Beta top secret"));
      assert.ok(!bootText.includes("Beta secret readme"));
      assert.ok(!bootText.includes(vault));

      // 3. consolidate_memories dry-run is allowed for read-only, apply=true is denied
      const dryDream = await roClient.callTool({
        name: "consolidate_memories",
        arguments: { project: "alpha", apply: false },
      });
      assert.ok(!dryDream.isError);

      const applyDreamRo = await roClient.callTool({
        name: "consolidate_memories",
        arguments: { project: "alpha", apply: true },
      });
      assert.equal(applyDreamRo.isError, true);
      assert.match(textOf(applyDreamRo), /ACL denied.*read-only/i);

      // 4. Approve pending memory via rw-alpha MCP tool succeeds; ro-alpha is denied
      const pendingId = rwIngestJson.staged[0]!.id;
      const roApprove = await roClient.callTool({
        name: "approve_pending_memory",
        arguments: { id: pendingId },
      });
      assert.equal(roApprove.isError, true);

      const rwApprove = await rwClient.callTool({
        name: "approve_pending_memory",
        arguments: { id: pendingId },
      });
      assert.ok(!rwApprove.isError, `expected approve success, got: ${textOf(rwApprove)}`);

      // 5. Direct library bootstrapContext enforces maxChars budget
      const smallBriefing = await bootstrapContext(vault, {
        project: "alpha",
        maxChars: 800,
        embedder: null,
      });
      assert.ok(smallBriefing.markdown.length <= 900);

      // 6. Dashboard HTML includes Pending Inbox & Dream controls
      const uiRes = await fetch(`${daemon.url}/`);
      const html = await uiRes.text();
      assert.ok(html.includes("Pending Inbox"));
      assert.ok(html.includes("Dream Preview"));

      await Promise.all([roClient.close(), rwClient.close()]);
    } finally {
      await daemon.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
