import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ORCHESTO_PERSONA_IDS,
  ORCHESTO_SYNC_META,
  orchestoPersonaPackRel,
  orchestoPersonaVaultRel,
  sha256Text,
  syncOrchestoVaultPersonas,
} from "./orchesto-sync.ts";
import { moduleDir, pathExists, readText, writeText } from "./runtime.ts";

async function makePack(root: string): Promise<string> {
  const pack = join(root, "pack");
  await mkdir(join(pack, "references"), { recursive: true });
  for (const id of ORCHESTO_PERSONA_IDS) {
    await writeText(
      join(pack, orchestoPersonaPackRel(id)),
      `# pack ${id}\n`,
    );
  }
  return pack;
}

describe("syncOrchestoVaultPersonas", () => {
  it("writes missing personas and records hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchesto-sync-"));
    try {
      const pack = await makePack(root);
      const vault = join(root, "vault");
      await mkdir(vault, { recursive: true });
      const actions = await syncOrchestoVaultPersonas(vault, pack);
      assert.ok(actions.every((a) => a.action === "wrote"));
      for (const id of ORCHESTO_PERSONA_IDS) {
        const rel = orchestoPersonaVaultRel(id);
        assert.equal(await readText(join(vault, rel)), `# pack ${id}\n`);
      }
      const meta = JSON.parse(await readText(join(vault, ORCHESTO_SYNC_META))) as {
        personas: Record<string, string>;
      };
      assert.equal(
        meta.personas[orchestoPersonaVaultRel("architect")],
        sha256Text("# pack architect\n"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("overwrites unmodified seeds when the pack changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchesto-sync-"));
    try {
      const pack = await makePack(root);
      const vault = join(root, "vault");
      await mkdir(join(vault, "workflows", "global"), { recursive: true });
      await mkdir(join(vault, "_meta"), { recursive: true });
      const hashes: Record<string, string> = {};
      for (const id of ORCHESTO_PERSONA_IDS) {
        const rel = orchestoPersonaVaultRel(id);
        const old = `# old ${id}\n`;
        await writeText(join(vault, rel), old);
        hashes[rel] = sha256Text(old);
      }
      await writeText(
        join(vault, ORCHESTO_SYNC_META),
        `${JSON.stringify({ personas: hashes }, null, 2)}\n`,
      );
      const actions = await syncOrchestoVaultPersonas(vault, pack);
      assert.ok(actions.every((a) => a.action === "updated"));
      assert.equal(
        await readText(join(vault, orchestoPersonaVaultRel("architect"))),
        "# pack architect\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips local edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchesto-sync-"));
    try {
      const pack = await makePack(root);
      const vault = join(root, "vault");
      await mkdir(join(vault, "workflows", "global"), { recursive: true });
      const hashes: Record<string, string> = {};
      for (const id of ORCHESTO_PERSONA_IDS) {
        const rel = orchestoPersonaVaultRel(id);
        const old = `# old ${id}\n`;
        await writeText(join(vault, rel), old);
        hashes[rel] = sha256Text(old);
      }
      await writeText(
        join(vault, orchestoPersonaVaultRel("architect")),
        "# my overlay\n",
      );
      await writeText(
        join(vault, ORCHESTO_SYNC_META),
        `${JSON.stringify({ personas: hashes }, null, 2)}\n`,
      );
      const actions = await syncOrchestoVaultPersonas(vault, pack);
      const architect = actions.find((a) =>
        a.path.endsWith(orchestoPersonaVaultRel("architect")),
      );
      assert.equal(architect?.action, "skipped");
      assert.equal(architect?.detail, "local-edits");
      assert.equal(
        await readText(join(vault, orchestoPersonaVaultRel("architect"))),
        "# my overlay\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips when meta exists but a persona hash is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchesto-sync-"));
    try {
      const pack = await makePack(root);
      const vault = join(root, "vault");
      await mkdir(join(vault, "workflows", "global"), { recursive: true });
      await mkdir(join(vault, "_meta"), { recursive: true });
      for (const id of ORCHESTO_PERSONA_IDS) {
        await writeText(
          join(vault, orchestoPersonaVaultRel(id)),
          `# mine ${id}\n`,
        );
      }
      const cpoRel = orchestoPersonaVaultRel("cpo");
      await writeText(
        join(vault, ORCHESTO_SYNC_META),
        `${JSON.stringify({ personas: { [cpoRel]: sha256Text("# mine cpo\n") } }, null, 2)}\n`,
      );
      const actions = await syncOrchestoVaultPersonas(vault, pack);
      const architect = actions.find((a) =>
        a.path.endsWith(orchestoPersonaVaultRel("architect")),
      );
      assert.equal(architect?.action, "skipped");
      assert.equal(architect?.detail, "local-edits");
      assert.equal(
        await readText(join(vault, orchestoPersonaVaultRel("architect"))),
        "# mine architect\n",
      );
      const cpo = actions.find((a) => a.path.endsWith(cpoRel));
      assert.equal(cpo?.action, "updated");
      assert.equal(cpo?.detail, "unmodified seed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips differing personas when meta json is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchesto-sync-"));
    try {
      const pack = await makePack(root);
      const vault = join(root, "vault");
      await mkdir(join(vault, "workflows", "global"), { recursive: true });
      await mkdir(join(vault, "_meta"), { recursive: true });
      for (const id of ORCHESTO_PERSONA_IDS) {
        await writeText(
          join(vault, orchestoPersonaVaultRel(id)),
          `# mine ${id}\n`,
        );
      }
      await writeText(join(vault, ORCHESTO_SYNC_META), "{not-json\n");
      const actions = await syncOrchestoVaultPersonas(vault, pack);
      assert.ok(actions.every((a) => a.action === "skipped"));
      assert.ok(actions.every((a) => a.detail === "local-edits"));
      assert.equal(
        await readText(join(vault, orchestoPersonaVaultRel("architect"))),
        "# mine architect\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bootstraps by overwriting when no json exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchesto-sync-"));
    try {
      const pack = await makePack(root);
      const vault = join(root, "vault");
      await mkdir(join(vault, "workflows", "global"), { recursive: true });
      for (const id of ORCHESTO_PERSONA_IDS) {
        await writeText(
          join(vault, orchestoPersonaVaultRel(id)),
          `# stale ${id}\n`,
        );
      }
      const actions = await syncOrchestoVaultPersonas(vault, pack);
      assert.ok(actions.every((a) => a.action === "updated"));
      assert.ok(actions.every((a) => a.detail === "bootstrap overwrite"));
      assert.equal(
        await readText(join(vault, orchestoPersonaVaultRel("cpo"))),
        "# pack cpo\n",
      );
      assert.equal(await pathExists(join(vault, ORCHESTO_SYNC_META)), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("only lists workflows/global persona paths", async () => {
    const src = await readText(join(moduleDir(import.meta.url), "orchesto-sync.ts"));
    assert.doesNotMatch(src, /projects\//);
    assert.doesNotMatch(src, /persona-auditor/);
  });
});
