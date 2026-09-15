import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { copyOrchestoPack } from "./inject.ts";
import { copyDirEnsured, moduleDir, readText, writeText } from "./runtime.ts";

const repoRoot = resolve(moduleDir(import.meta.url), "..");
const packDir = join(repoRoot, "skills", "orchesto");

describe("copyOrchestoPack", () => {
  it("copies SKILL.md and five persona references into a dest dir", async () => {
    const dest = await mkdtemp(join(tmpdir(), "orchesto-pack-"));
    try {
      const actions = await copyOrchestoPack(packDir, dest);
      assert.ok(actions.length >= 6);
      const skill = await readText(join(dest, "SKILL.md"));
      assert.match(skill, /^---\nname: orchesto\n/m);
      for (const id of [
        "brainstormer",
        "cpo",
        "architect",
        "implementor",
        "reviewer",
      ]) {
        const rel = `references/persona-${id}.md`;
        const body = await readText(join(dest, rel));
        assert.ok(body.includes(`id: persona-${id}`));
      }
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });
});

describe("copyDirEnsured", () => {
  it("copies a nested directory tree", async () => {
    const src = await mkdtemp(join(tmpdir(), "orchesto-src-"));
    const dest = await mkdtemp(join(tmpdir(), "orchesto-dest-"));
    try {
      await mkdir(join(src, "references"), { recursive: true });
      await writeText(join(src, "SKILL.md"), "name: orchesto\n");
      await writeText(join(src, "references", "persona-cpo.md"), "# cpo\n");
      await copyDirEnsured(src, dest);
      assert.equal(await readText(join(dest, "SKILL.md")), "name: orchesto\n");
      assert.equal(
        await readText(join(dest, "references", "persona-cpo.md")),
        "# cpo\n",
      );
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });
});
