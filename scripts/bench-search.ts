#!/usr/bin/env node
/**
 * Reproducible retrieval quality & latency benchmark for Milestone 1 (Hybrid Index).
 * Compares: legacy substring search vs. FTS5 BM25 vs. local BGE-small vector vs. Hybrid RRF.
 * Uses only synthetic temporary vaults in os.tmpdir().
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalEmbedder,
  searchHybrid,
  syncVaultIndex,
  type SearchMode,
} from "../src/index/index.ts";
import { writeText } from "../src/runtime.ts";
import { searchNotes as legacySearchNotes } from "../src/vault.ts";

type FixtureNote = {
  path: string;
  body: string;
};

type EvalQuery = {
  id: string;
  category: "exact" | "stemming" | "semantic" | "negative";
  query: string;
  expectedPath: string | null; // null = negative/abstention query
};

const FIXTURE_NOTES: FixtureNote[] = [
  {
    path: "projects/alpha-api/decisions.md",
    body: `---
type: project
scope: project
project: alpha-api
tags: [auth, security, backend]
updated: 2026-11-20
---
# Decisions

## Short-lived JWT refresh rotation
Issue 15-minute JWT access tokens paired with rotating HttpOnly refresh cookies.
Revoked token IDs are stored in [[../../stack/catalog/redis|Redis]] with a matching TTL.

## PgBouncer transaction pooling
Run PgBouncer in transaction pooling mode in front of PostgreSQL so bursty serverless lambdas never exhaust max_connections.
`,
  },
  {
    path: "projects/alpha-api/gotchas.md",
    body: `---
type: project
scope: project
project: alpha-api
tags: [auth, ops]
updated: 2026-11-19
---
# Gotchas

## Clock skew rejects fresh tokens
Containers occasionally drift by a few seconds; set clockTolerance to 30 seconds in jwtVerify to prevent false 401 errors.

## Prepared statements fail under transaction pooling
Disable unnamed prepared statements in the Postgres driver when routing through PgBouncer.
`,
  },
  {
    path: "projects/beta-web/decisions.md",
    body: `---
type: project
scope: project
project: beta-web
tags: [frontend, react, state]
updated: 2026-11-18
---
# Decisions

## Server state with TanStack Query
Keep remote API data in TanStack Query with staleTime 60s instead of mirroring server payloads into Zustand.

## Optimistic mutations with rollback
Every inline toggle captures previous cache snapshots in onMutate and restores them in onError.
`,
  },
  {
    path: "projects/beta-web/gotchas.md",
    body: `---
type: project
scope: project
project: beta-web
tags: [frontend, ssr]
updated: 2026-11-17
---
# Gotchas

## HYDRATION_MISMATCH on locale dates
Never call toLocaleDateString during SSR without pinning timeZone: "UTC" or deferring to a client effect.

## Sticky headers clip dropdown portals
Render popovers inside document.body via a portal so overflow-hidden table wrappers never crop menus.
`,
  },
  {
    path: "projects/gamma-worker/decisions.md",
    body: `---
type: project
scope: project
project: gamma-worker
tags: [queues, reliability]
updated: 2026-11-15
---
# Decisions

## Idempotency keys on outbound webhooks
Hash (eventId + destinationUrl) as an idempotency key and persist delivery receipts before retrying with exponential backoff.

## Dead-letter queue replay CLI
Failed jobs after 5 retries move to the DLQ table and can be re-enqueued individually after root-cause fixes.
`,
  },
  {
    path: "projects/gamma-worker/gotchas.md",
    body: `---
type: project
scope: project
project: gamma-worker
tags: [queues, memory]
updated: 2026-11-12
---
# Gotchas

## Unbounded Promise.all causes OOM kills
Process CSV batches with a concurrency limiter of 8 workers instead of Promise.all over 10,000 rows.
`,
  },
  {
    path: "projects/delta-cli/decisions.md",
    body: `---
type: project
scope: project
project: delta-cli
tags: [cli, packaging]
updated: 2026-11-10
---
# Decisions

## Stdout reserved for machine output
Send all progress bars, warnings, and debug logs to stderr so pipes like \`delta inspect | jq\` never break.
`,
  },
  {
    path: "projects/delta-cli/gotchas.md",
    body: `---
type: project
scope: project
project: delta-cli
tags: [fs, permissions]
updated: 2026-11-08
---
# Gotchas

## EPERM inside synced desktop folders
Avoid storing local SQLite caches inside cloud-synced folders because sandboxed editors throw EPERM on WAL lock files.
`,
  },
  {
    path: "stack/catalog/redis.md",
    body: `---
type: stack
scope: global
tags: [tool, cache, rate-limit]
updated: 2026-11-21
---
# Redis
In-memory datastore used for sliding-window API rate limiting, ephemeral locks, and session revocation lists.
`,
  },
  {
    path: "stack/catalog/bun.md",
    body: `---
type: stack
scope: global
tags: [tool, runtime, typescript]
updated: 2026-11-16
---
# Bun
Fast JavaScript/TypeScript runtime with built-in SQLite, native TypeScript execution, and sub-50ms CLI cold starts.
`,
  },
  {
    path: "stack/catalog/playwright.md",
    body: `---
type: stack
scope: global
tags: [tool, testing, e2e]
updated: 2026-11-14
---
# Playwright
Headless browser automation suite for end-to-end checkout flows, visual diffs, and trace debugging in CI.
`,
  },
  {
    path: "stack/catalog/otel.md",
    body: `---
type: stack
scope: global
tags: [tool, observability, tracing]
updated: 2026-11-11
---
# OpenTelemetry
Distributed tracing and structured span propagation across HTTP gateways and async background workers.
`,
  },
  {
    path: "stack/catalog/docker.md",
    body: `---
type: stack
scope: global
tags: [tool, containers, ci]
updated: 2026-11-09
---
# Docker BuildKit
Use multi-stage Dockerfiles with \`--mount=type=cache\` for package managers and BuildKit registry caches to speed up CI builds.
`,
  },
  {
    path: "patterns/error-handling.md",
    body: `---
type: pattern
scope: global
tags: [typescript, reliability]
updated: 2026-11-22
---
# Discriminated Result Unions
Return typed \`{ ok: true, value } | { ok: false, error }\` discriminated unions for expected domain failures instead of throwing untyped exceptions.
`,
  },
  {
    path: "patterns/zero-downtime-migrations.md",
    body: `---
type: pattern
scope: global
tags: [database, sql, deployments]
updated: 2026-11-19
---
# Expand-and-Contract Schema Migrations
Never rename or drop a live column in one deploy. Add the new nullable column, dual-write, backfill in chunks, switch reads, then drop the old column in a follow-up release.
`,
  },
  {
    path: "patterns/rate-limiting.md",
    body: `---
type: pattern
scope: global
tags: [security, api]
updated: 2026-11-13
---
# Token Bucket Throttling
Enforce per-tenant API quotas at the edge using a Lua-scripted token bucket in [[../stack/catalog/redis|Redis]] returning standard Retry-After headers.
`,
  },
  {
    path: "patterns/feature-flags.md",
    body: `---
type: pattern
scope: global
tags: [release, rollout]
updated: 2026-11-05
---
# Progressive Percentage Rollouts
Decouple code deployment from feature exposure using deterministic user-ID hashing so risky changes can ramp 1% -> 10% -> 100% and kill-switch instantly.
`,
  },
  {
    path: "patterns/prompt-caching.md",
    body: `---
type: pattern
scope: global
tags: [llm, cost, latency]
updated: 2026-11-23
---
# Prefix-Stable Prompt Layouts
Keep static system instructions and tool schemas at the top of the prompt and append dynamic user messages last to maximize provider KV-cache hit rates.
`,
  },
  {
    path: "suggestions/global/coding.md",
    body: `---
type: suggestion
kind: coding
scope: global
tags: [style, preferences]
updated: 2026-11-24
---
# Coding Preferences
Prefer small composable pure functions, explicit return types at module boundaries, and early returns over deeply nested if-else blocks.
`,
  },
  {
    path: "suggestions/global/commit.md",
    body: `---
type: suggestion
kind: commit
scope: global
tags: [git, conventions]
updated: 2026-11-20
---
# Commit Message Preferences
Write concise imperative subjects under 72 characters explaining why the change was made, not just which files were touched.
`,
  },
  {
    path: "instructions/global/pr-review.md",
    body: `---
type: instruction
kind: pr-review
scope: global
tags: [review, security]
updated: 2026-11-18
---
# PR Review Rules
Check auth boundaries, SQL parameterization, unhandled promise rejections, and rollback safety before commenting on style nits.
`,
  },
  {
    path: "agents/context-budget.md",
    body: `---
type: agent
scope: global
tags: [agents, memory]
updated: 2026-11-21
---
# Context Window Hygiene
Prefer targeted search and section reads over dumping entire directories into context; summarize noisy test logs before continuing multi-step debugging.
`,
  },
  {
    path: "media/sqlite-local-first.md",
    body: `---
type: media
scope: global
tags: [sqlite, architecture]
updated: 2026-11-04
---
# Local-First SQLite Talk Notes
WAL mode with synchronous=NORMAL gives near-memory read throughput and safe concurrent readers on a single machine without running a database server.
`,
  },
  {
    path: "inbox/benchmark-ideas.md",
    body: `---
type: inbox
scope: global
tags: [evals]
updated: 2026-11-25
---
# Search Eval Ideas
Measure Recall@1, Recall@3, MRR, and negative rejection rate when tuning Reciprocal Rank Fusion weights.
`,
  },
];

const EVAL_QUERIES: EvalQuery[] = [
  // 1. Exact / Identifier queries (6)
  { id: "ex-1", category: "exact", query: "PgBouncer", expectedPath: "projects/alpha-api/decisions.md" },
  { id: "ex-2", category: "exact", query: "HYDRATION_MISMATCH", expectedPath: "projects/beta-web/gotchas.md" },
  { id: "ex-3", category: "exact", query: "EPERM WAL lock", expectedPath: "projects/delta-cli/gotchas.md" },
  { id: "ex-4", category: "exact", query: "TanStack Query staleTime", expectedPath: "projects/beta-web/decisions.md" },
  { id: "ex-5", category: "exact", query: "clockTolerance jwtVerify", expectedPath: "projects/alpha-api/gotchas.md" },
  { id: "ex-6", category: "exact", query: "BuildKit mount cache", expectedPath: "stack/catalog/docker.md" },

  // 2. Stemming / Morphological queries (6)
  { id: "st-1", category: "stemming", query: "rotating refreshed cookies", expectedPath: "projects/alpha-api/decisions.md" },
  { id: "st-2", category: "stemming", query: "migrating database columns safely", expectedPath: "patterns/zero-downtime-migrations.md" },
  { id: "st-3", category: "stemming", query: "throttled tenant quotas", expectedPath: "patterns/rate-limiting.md" },
  { id: "st-4", category: "stemming", query: "replaying dead letter jobs", expectedPath: "projects/gamma-worker/decisions.md" },
  { id: "st-5", category: "stemming", query: "tracing distributed spans", expectedPath: "stack/catalog/otel.md" },
  { id: "st-6", category: "stemming", query: "committing imperative messages", expectedPath: "suggestions/global/commit.md" },

  // 3. Semantic / Paraphrase queries with zero or near-zero keyword overlap (10)
  { id: "sm-1", category: "semantic", query: "how do we keep users signed in securely", expectedPath: "projects/alpha-api/decisions.md" },
  { id: "sm-2", category: "semantic", query: "why do my cloud functions run out of database sockets", expectedPath: "projects/alpha-api/decisions.md" },
  { id: "sm-3", category: "semantic", query: "how should I avoid throwing exceptions for expected business failures", expectedPath: "patterns/error-handling.md" },
  { id: "sm-4", category: "semantic", query: "why are our CI container builds so slow", expectedPath: "stack/catalog/docker.md" },
  { id: "sm-5", category: "semantic", query: "how to ship risky changes gradually and turn them off fast", expectedPath: "patterns/feature-flags.md" },
  { id: "sm-6", category: "semantic", query: "background job keeps crashing from ram exhaustion on huge spreadsheets", expectedPath: "projects/gamma-worker/gotchas.md" },
  { id: "sm-7", category: "semantic", query: "how to lower AI token costs by structuring messages better", expectedPath: "patterns/prompt-caching.md" },
  { id: "sm-8", category: "semantic", query: "floating select list gets hidden inside a scrollable grid", expectedPath: "projects/beta-web/gotchas.md" },
  { id: "sm-9", category: "semantic", query: "piping CLI output into jq breaks because of noisy logs", expectedPath: "projects/delta-cli/decisions.md" },
  { id: "sm-10", category: "semantic", query: "stop renaming production table fields in a single deploy", expectedPath: "patterns/zero-downtime-migrations.md" },

  // 4. Negative / Abstention queries (4) — completely absent topics
  { id: "ng-1", category: "negative", query: "sourdough bread fermentation temperature schedule", expectedPath: null },
  { id: "ng-2", category: "negative", query: "kubernetes gpu nvidia driver cuda installation", expectedPath: null },
  { id: "ng-3", category: "negative", query: "swiftui coredata icloud sync conflict", expectedPath: null },
  { id: "ng-4", category: "negative", query: "tax filing deadlines for quarterly estimated payments", expectedPath: null },
];

type ModeMetrics = {
  recall1: number;
  recall3: number;
  recall5: number;
  mrr: number;
  byCategory: Record<string, { r1: number; r3: number; mrr: number; total: number }>;
  negativeCleanRate: number;
  avgNegativeTopSim: number;
  p50Ms: number;
  p95Ms: number;
};

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]! * 100) / 100;
}

async function runQualityBenchmark(minVectorScore: number) {
  const root = await mkdtemp(join(tmpdir(), "ai-mcp-brain-bench-q-"));
  const vault = join(root, "vault");
  const dbPath = join(root, "index.sqlite");

  try {
    for (const note of FIXTURE_NOTES) {
      await writeText(join(vault, note.path), note.body);
    }

    const embedder = createLocalEmbedder();
    const syncStats = await syncVaultIndex(vault, { dbPath, embedder });

    const engines: ("legacy" | SearchMode)[] = ["legacy", "fts", "vector", "hybrid"];
    const results: Record<string, ModeMetrics> = {};
    const misses: Record<string, { id: string; query: string; expected: string; got: string[] }[]> = {};

    for (const engine of engines) {
      let r1 = 0;
      let r3 = 0;
      let r5 = 0;
      let rrSum = 0;
      let posTotal = 0;
      let negClean = 0;
      let negTotal = 0;
      const negSims: number[] = [];
      const latencies: number[] = [];
      const byCategory: Record<string, { r1: number; r3: number; mrr: number; total: number }> = {
        exact: { r1: 0, r3: 0, mrr: 0, total: 0 },
        stemming: { r1: 0, r3: 0, mrr: 0, total: 0 },
        semantic: { r1: 0, r3: 0, mrr: 0, total: 0 },
      };
      misses[engine] = [];

      for (const q of EVAL_QUERIES) {
        const t0 = performance.now();
        let paths: string[] = [];
        let topVecSim: number | null = null;

        if (engine === "legacy") {
          const hits = await legacySearchNotes(vault, q.query, 5);
          paths = hits.map((h) => h.path);
        } else {
          const res = await searchHybrid(vault, q.query, {
            dbPath,
            mode: engine,
            limit: 5,
            skipSync: true,
            embedder: engine === "fts" ? null : embedder,
            minVectorScore,
          });
          paths = res.hits.map((h) => h.path);
          topVecSim = res.hits[0]?.vectorScore ?? null;
        }
        latencies.push(performance.now() - t0);

        if (q.expectedPath === null) {
          negTotal++;
          if (paths.length === 0) negClean++;
          if (topVecSim !== null) negSims.push(topVecSim);
          continue;
        }

        posTotal++;
        const cat = byCategory[q.category]!;
        cat.total++;
        const rank = paths.indexOf(q.expectedPath) + 1;
        if (rank === 1) {
          r1++;
          cat.r1++;
        }
        if (rank >= 1 && rank <= 3) {
          r3++;
          cat.r3++;
        }
        if (rank >= 1 && rank <= 5) {
          r5++;
        }
        if (rank >= 1) {
          rrSum += 1 / rank;
          cat.mrr += 1 / rank;
        } else {
          misses[engine]!.push({
            id: q.id,
            query: q.query,
            expected: q.expectedPath,
            got: paths.slice(0, 3),
          });
        }
      }

      for (const c of Object.values(byCategory)) {
        c.r1 = Math.round((c.r1 / c.total) * 1000) / 10;
        c.r3 = Math.round((c.r3 / c.total) * 1000) / 10;
        c.mrr = Math.round((c.mrr / c.total) * 1000) / 1000;
      }

      results[engine] = {
        recall1: Math.round((r1 / posTotal) * 1000) / 10,
        recall3: Math.round((r3 / posTotal) * 1000) / 10,
        recall5: Math.round((r5 / posTotal) * 1000) / 10,
        mrr: Math.round((rrSum / posTotal) * 1000) / 1000,
        byCategory,
        negativeCleanRate: Math.round((negClean / negTotal) * 1000) / 10,
        avgNegativeTopSim: negSims.length
          ? Math.round((negSims.reduce((a, b) => a + b, 0) / negSims.length) * 1000) / 1000
          : 0,
        p50Ms: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95),
      };
    }

    return { syncStats, results, misses };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runScaleBenchmark(noteCount: number) {
  const root = await mkdtemp(join(tmpdir(), `ai-mcp-brain-scale-${noteCount}-`));
  const vault = join(root, "vault");
  const dbPath = join(root, "index.sqlite");
  const embedder = createLocalEmbedder();

  try {
    // Seed N realistic notes by cycling topics with unique project slugs and variations
    for (let i = 0; i < noteCount; i++) {
      const base = FIXTURE_NOTES[i % FIXTURE_NOTES.length]!;
      const rel = i < FIXTURE_NOTES.length
        ? base.path
        : `projects/service-${String(i).padStart(3, "0")}/note-${i}.md`;
      const body = i < FIXTURE_NOTES.length
        ? base.body
        : `---\ntype: project\nscope: project\nproject: service-${String(i).padStart(3, "0")}\ntags: [bench, svc-${i % 10}]\nupdated: 2026-11-${String((i % 25) + 1).padStart(2, "0")}\n---\n\n# Service ${i} Notes\n\n${base.body.split("---").slice(2).join("---")}\n\n## Variation ${i}\nOperational details for service-${i} handling throughput tier ${i % 7}.\n`;
      await writeText(join(vault, rel), body);
    }

    // 1. Cold full build (with embeddings)
    const cold = await syncVaultIndex(vault, { dbPath, embedder });
    // 2. No-op incremental sync
    const noop = await syncVaultIndex(vault, { dbPath, embedder });
    // 3. Single-file edit incremental sync
    await writeText(
      join(vault, FIXTURE_NOTES[0]!.path),
      `${FIXTURE_NOTES[0]!.body}\n## Updated Benchmark Entry\nAdded rate limit audit note.\n`,
    );
    const singleEdit = await syncVaultIndex(vault, { dbPath, embedder });

    // 4. Warm query latencies (10 queries each)
    const sampleQueries = EVAL_QUERIES.slice(0, 10).map((q) => q.query);
    const legacyTimes: number[] = [];
    const ftsTimes: number[] = [];
    const hybridTimes: number[] = [];

    for (const q of sampleQueries) {
      let t = performance.now();
      await legacySearchNotes(vault, q, 10);
      legacyTimes.push(performance.now() - t);

      t = performance.now();
      await searchHybrid(vault, q, { dbPath, mode: "fts", skipSync: true });
      ftsTimes.push(performance.now() - t);

      t = performance.now();
      await searchHybrid(vault, q, { dbPath, mode: "hybrid", skipSync: true, embedder });
      hybridTimes.push(performance.now() - t);
    }

    const dbStat = await stat(dbPath);
    return {
      noteCount,
      chunks: cold.chunksIndexed,
      dbSizeKb: Math.round(dbStat.size / 1024),
      coldBuildMs: cold.durationMs,
      noopSyncMs: noop.durationMs,
      singleEditSyncMs: singleEdit.durationMs,
      legacyP50Ms: percentile(legacyTimes, 50),
      ftsP50Ms: percentile(ftsTimes, 50),
      hybridP50Ms: percentile(hybridTimes, 50),
      hybridP95Ms: percentile(hybridTimes, 95),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  // Warm up embedder model load once so benchmark measures steady-state runtime separately from first download
  const tLoad0 = performance.now();
  const embedder = createLocalEmbedder();
  await embedder.embed(["warmup"], "query");
  const modelLoadMs = Math.round(performance.now() - tLoad0);

  const minVec = process.env.BENCH_MIN_VEC ? Number(process.env.BENCH_MIN_VEC) : 0.6;
  const quality = await runQualityBenchmark(minVec);

  const scale = [];
  for (const n of [50, 200, 500]) {
    scale.push(await runScaleBenchmark(n));
  }

  console.log(
    JSON.stringify(
      {
        runtime: typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : `node ${process.version}`,
        embedModel: embedder.model,
        modelLoadMs,
        minVectorScore: minVec,
        quality: quality.results,
        misses: quality.misses,
        scale,
      },
      null,
      2,
    ),
  );
}

await main();
