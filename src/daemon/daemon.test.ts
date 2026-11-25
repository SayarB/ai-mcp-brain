import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Embedder } from "../index/index.ts";
import { pathExists, writeText } from "../runtime.ts";
import {
  DaemonStateStore,
  startBrainDaemon,
  validateAppName,
} from "./index.ts";

function createMockEmbedder(): Embedder {
  const concepts: RegExp[] = [
    /\b(auth|jwt|oauth|login|cookie|session)\b/i,
    /\b(postgres|sqlite|sql|database|pgbouncer|pool)\b/i,
    /\b(redis|cache|rate|limit|throttle)\b/i,
    /\b(bun|node|runtime|tsx|typescript)\b/i,
  ];
  return {
    model: "mock-daemon-v1",
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

function textOf(result: unknown): string {
  const obj = result && typeof result === "object" ? (result as { content?: unknown }) : {};
  const arr = Array.isArray(obj.content) ? obj.content : [];
  return arr
    .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
    .join("\n");
}

function makeSynthSecret(len: number, offset: number): string {
  const alphabet = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789!@#$";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[(i * 7 + offset) % alphabet.length]!;
  }
  return out;
}

async function rawHttpRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          resolveReq({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", rejectReq);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("local HTTP daemon, Streamable HTTP MCP, ACLs, access log & dashboard", () => {
  it("serves Streamable HTTP MCP per harness, locks provenance, enforces live pause/read-only/scope/project ACLs, and redacts secrets in access_log", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-mcp-brain-daemon-"));
    const vault = join(root, "vault");
    const indexDb = join(root, "index.sqlite");
    const stateDb = join(root, "daemon.sqlite");
    const embedder = createMockEmbedder();

    await writeText(
      join(vault, "patterns/global-auth.md"),
      "---\ntype: pattern\nscope: global\nupdated: 2026-11-25\n---\n\n# Global Auth Pattern\nUse rotating HttpOnly refresh cookies for auth.\n",
    );
    await writeText(
      join(vault, "projects/alpha/decisions.md"),
      "---\ntype: project\nscope: project\nproject: alpha\nupdated: 2026-11-25\n---\n\n# Alpha Decisions\nRoute alpha database traffic through PgBouncer pooling.\n",
    );
    await writeText(
      join(vault, "projects/beta/decisions.md"),
      "---\ntype: project\nscope: project\nproject: beta\nupdated: 2026-11-25\n---\n\n# Beta Decisions\nBeta uses Redis rate limiting and PgBouncer pooling.\n",
    );

    const daemon = await startBrainDaemon({
      vaultPath: vault,
      port: 0,
      indexDbPath: indexDb,
      stateDbPath: stateDb,
      embedder,
      warmup: false,
      watchVault: false,
      quiet: true,
      configApps: {
        cursor: { mode: "read-write" },
        "readonly-bot": { mode: "read-only" },
        "alpha-only": {
          mode: "read-write",
          read_scopes: ["project"],
          write_scopes: ["project"],
          allowed_projects: ["alpha"],
          denied_tools: ["delete_memory"],
        },
      },
    });

    const cursorClient = new Client({ name: "cursor-test", version: "1.0.0" });
    const readonlyClient = new Client({ name: "readonly-test", version: "1.0.0" });
    const alphaClient = new Client({ name: "alpha-test", version: "1.0.0" });

    try {
      const cursorTransport = new StreamableHTTPClientTransport(
        new URL(`${daemon.mcpUrl}?app=cursor`),
      );
      const readonlyTransport = new StreamableHTTPClientTransport(
        new URL(`${daemon.mcpUrl}?app=readonly-bot`),
      );
      const alphaTransport = new StreamableHTTPClientTransport(
        new URL(`${daemon.mcpUrl}?app=alpha-only`),
      );

      await Promise.all([
        cursorClient.connect(cursorTransport),
        readonlyClient.connect(readonlyTransport),
        alphaClient.connect(alphaTransport),
      ]);

      assert.equal(daemon.activeSessionCount(), 3);

      // 1. Cursor adds a global memory and tries to spoof app="claude" — daemon locks provenance to "cursor"
      const addRes = await cursorClient.callTool({
        name: "add_memory",
        arguments: {
          title: "Prefer Bun runtime",
          content: "Use Bun for local MCP scripts when available.",
          scope: "global",
          category: "preferences",
          app: "claude",
        },
      });
      assert.ok(!addRes.isError, `expected success, got: ${textOf(addRes)}`);
      const addedJson = JSON.parse(textOf(addRes)) as { memory: { id: string; app: string } };
      assert.equal(addedJson.memory.app, "cursor");

      // 2. Read-only app can search, CANNOT write, and get_project_context does NOT create missing project files
      const roSearch = await readonlyClient.callTool({
        name: "search_notes",
        arguments: { query: "PgBouncer pooling", mode: "fts" },
      });
      assert.ok(!roSearch.isError);
      assert.ok(textOf(roSearch).includes("projects/alpha/decisions.md"));

      const roWrite = await readonlyClient.callTool({
        name: "add_memory",
        arguments: {
          title: "Should fail",
          content: "Read-only harness must not write.",
        },
      });
      assert.equal(roWrite.isError, true);
      assert.match(textOf(roWrite), /ACL denied.*read-only/i);

      const roCtx = await readonlyClient.callTool({
        name: "get_project_context",
        arguments: { project: "brand-new-uncreated-repo" },
      });
      assert.ok(!roCtx.isError);
      assert.equal(
        await pathExists(join(vault, "projects/brand-new-uncreated-repo/README.md")),
        false,
        "read-only app must never create project scaffold files",
      );

      // 3. Project-scoped app ("alpha-only") can only read/write alpha; global & beta never leak!
      const alphaSearch = await alphaClient.callTool({
        name: "search_notes",
        arguments: { query: "PgBouncer pooling", mode: "fts" },
      });
      assert.ok(!alphaSearch.isError);
      const alphaSearchText = textOf(alphaSearch);
      assert.ok(alphaSearchText.includes("projects/alpha/decisions.md"));
      assert.ok(!alphaSearchText.includes("projects/beta/decisions.md"));

      const alphaReadBeta = await alphaClient.callTool({
        name: "read_note",
        arguments: { path: "projects/beta/decisions.md" },
      });
      assert.equal(alphaReadBeta.isError, true);
      assert.match(textOf(alphaReadBeta), /ACL denied/i);

      // Path traversal inside projects/alpha/../beta must NOT bypass project ACL
      const alphaTraversal = await alphaClient.callTool({
        name: "read_note",
        arguments: { path: "projects/alpha/../beta/decisions.md" },
      });
      assert.equal(alphaTraversal.isError, true);
      assert.match(textOf(alphaTraversal), /ACL denied/i);

      const alphaReadGlobal = await alphaClient.callTool({
        name: "read_note",
        arguments: { path: "patterns/global-auth.md" },
      });
      assert.equal(alphaReadGlobal.isError, true);
      assert.match(textOf(alphaReadGlobal), /ACL denied/i);

      const alphaAddOwn = await alphaClient.callTool({
        name: "add_memory",
        arguments: {
          title: "Alpha pool size",
          content: "Keep alpha PgBouncer pool size at 25.",
          scope: "project",
          project: "alpha",
          category: "decisions",
        },
      });
      assert.ok(!alphaAddOwn.isError);
      const alphaMem = JSON.parse(textOf(alphaAddOwn)) as { memory: { id: string } };

      // denied_tools blocks delete_memory even on alpha's own memory
      const alphaDel = await alphaClient.callTool({
        name: "delete_memory",
        arguments: { id: alphaMem.memory.id },
      });
      assert.equal(alphaDel.isError, true);
      assert.match(textOf(alphaDel), /explicitly denied/i);

      // alpha-only list_memories never leaks cursor's global memory
      const alphaList = await alphaClient.callTool({
        name: "list_memories",
        arguments: {},
      });
      assert.ok(!alphaList.isError);
      const alphaListJson = JSON.parse(textOf(alphaList)) as {
        memories: { id: string; scope: string; project: string | null }[];
      };
      assert.ok(alphaListJson.memories.every((m) => m.scope === "project" && m.project === "alpha"));
      assert.ok(!alphaListJson.memories.some((m) => m.id === addedJson.memory.id));

      // 4. Live Pause via REST API takes effect immediately on an already-connected MCP session!
      const pauseRes = await fetch(`${daemon.url}/api/apps/cursor`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(pauseRes.status, 200);

      const pausedCall = await cursorClient.callTool({
        name: "vault_info",
        arguments: {},
      });
      assert.equal(pausedCall.isError, true);
      assert.match(textOf(pausedCall), /paused/i);

      // Resume restores access immediately
      const resumeRes = await fetch(`${daemon.url}/api/apps/cursor`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(resumeRes.status, 200);
      const resumedCall = await cursorClient.callTool({
        name: "vault_info",
        arguments: {},
      });
      assert.ok(!resumedCall.isError);

      // 5. Blocked secret write NEVER leaks the secret string into access_log!
      const synthPass = makeSynthSecret(20, 5);
      const leakedCall = await cursorClient.callTool({
        name: "add_memory",
        arguments: {
          title: "DB config",
          content: `PGPASSWORD=${synthPass}`,
          scope: "global",
        },
      });
      assert.equal(leakedCall.isError, true);

      const logsRes = await fetch(`${daemon.url}/api/logs?limit=50`);
      assert.equal(logsRes.status, 200);
      const logsJson = (await logsRes.json()) as {
        logs: { app: string; tool: string; status: string; summary: string }[];
      };
      assert.ok(logsJson.logs.length >= 8);
      assert.ok(logsJson.logs.some((l) => l.app === "readonly-bot" && l.status === "denied"));
      assert.ok(logsJson.logs.some((l) => l.app === "cursor" && l.tool === "add_memory" && l.status === "error"));
      for (const l of logsJson.logs) {
        assert.ok(!l.summary.includes(synthPass), "access_log must never contain raw secrets");
      }

      // 6. Dashboard UI & REST API endpoints (health, apps, search score debugger, memories, reset)
      const uiRes = await fetch(`${daemon.url}/`);
      assert.equal(uiRes.status, 200);
      assert.match(uiRes.headers.get("content-type") ?? "", /text\/html/);
      const html = await uiRes.text();
      assert.ok(html.includes("Hem Vault Daemon"));

      const healthRes = await fetch(`${daemon.url}/api/health`);
      const health = (await healthRes.json()) as { ok: boolean; activeSessions: number; memoryCount: number };
      assert.equal(health.ok, true);
      assert.equal(health.activeSessions, 3);
      assert.equal(health.memoryCount, 2);

      const searchApiRes = await fetch(`${daemon.url}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "PgBouncer pooling", target: "notes", mode: "hybrid" }),
      });
      assert.equal(searchApiRes.status, 200);
      const searchData = (await searchApiRes.json()) as {
        modeUsed: string;
        hits: { path: string; score: number }[];
      };
      assert.equal(searchData.modeUsed, "hybrid");
      assert.ok(searchData.hits.length >= 1);

      // Reset cursor override back to config default
      const resetRes = await fetch(`${daemon.url}/api/apps/cursor/override`, { method: "DELETE" });
      assert.equal(resetRes.status, 200);
      const resetJson = (await resetRes.json()) as { app: { source: string } };
      assert.equal(resetJson.app.source, "config");

      // Strict REST input validation (non-array readScopes -> 400; NaN limit -> safe fallback)
      const badPatch = await fetch(`${daemon.url}/api/apps/cursor`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readScopes: "global" }),
      });
      assert.equal(badPatch.status, 400);

      const nanLimitLogs = await fetch(`${daemon.url}/api/logs?limit=notanumber`);
      assert.equal(nanLimitLogs.status, 200);

      await Promise.all([
        cursorClient.close(),
        readonlyClient.close(),
        alphaClient.close(),
      ]);
    } finally {
      await daemon.close();
      // Verify ACL overrides & access_log persisted cleanly across restart
      const reopened = await DaemonStateStore.open(vault, { dbPath: stateDb });
      try {
        assert.ok(reopened.queryLogs({ limit: 10 }).length >= 5);
        assert.equal(reopened.getEffectivePolicy("readonly-bot").mode, "read-only");
      } finally {
        reopened.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces security guards: invalid app name, DNS rebinding Host, CSRF Origin, cross-app session hijacking, and Bearer token auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-mcp-brain-sec-"));
    const vault = join(root, "vault");
    const token = makeSynthSecret(24, 13);

    await writeText(join(vault, "inbox/hello.md"), "# Hello\nWorld\n");

    const daemon = await startBrainDaemon({
      vaultPath: vault,
      port: 0,
      stateDbPath: ":memory:",
      indexDbPath: join(root, "idx.sqlite"),
      embedder: null,
      authToken: token,
      warmup: false,
      watchVault: false,
      quiet: true,
    });

    try {
      // 1. Missing token -> 401 on /api/* and /mcp
      const noAuth = await fetch(`${daemon.url}/api/health`);
      assert.equal(noAuth.status, 401);

      const badAuth = await fetch(`${daemon.url}/api/health`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      assert.equal(badAuth.status, 401);

      const goodAuth = await fetch(`${daemon.url}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(goodAuth.status, 200);

      // 2. Invalid app name -> 400
      assert.throws(() => validateAppName("../evil"));
      const badApp = await fetch(`${daemon.url}/mcp?app=../evil`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      assert.equal(badApp.status, 400);

      // 3. Cross-origin CSRF attempt -> 403
      const csrf = await rawHttpRequest({
        port: daemon.port,
        path: "/api/apps/cursor",
        method: "PUT",
        headers: {
          Host: `127.0.0.1:${daemon.port}`,
          Origin: "https://evil.example",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "read-write" }),
      });
      assert.equal(csrf.status, 403);

      // 4. DNS rebinding Host header -> 403
      const rebind = await rawHttpRequest({
        port: daemon.port,
        path: "/api/health",
        method: "GET",
        headers: {
          Host: `attacker.example:${daemon.port}`,
          Authorization: `Bearer ${token}`,
        },
      });
      assert.equal(rebind.status, 403);

      // 5. Cross-app session reuse -> 403
      const initRes = await fetch(`${daemon.url}/mcp?app=cursor`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
      });
      assert.equal(initRes.status, 200);
      const sid = initRes.headers.get("mcp-session-id");
      assert.ok(sid, "expected mcp-session-id header from initialize");

      const hijack = await fetch(`${daemon.url}/mcp?app=codex`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          "mcp-session-id": sid,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      assert.equal(hijack.status, 403);

      // 6. Non-loopback host refused without allowRemote
      await assert.rejects(
        () =>
          startBrainDaemon({
            vaultPath: vault,
            host: "0.0.0.0",
            port: 0,
            stateDbPath: ":memory:",
            warmup: false,
            quiet: true,
          }),
        /non-loopback/i,
      );
    } finally {
      await daemon.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
