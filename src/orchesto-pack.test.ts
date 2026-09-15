import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathExists, moduleDir } from "./runtime.ts";
import { ORCHESTO_PERSONA_IDS } from "./orchesto-sync.ts";

const repoRoot = resolve(moduleDir(import.meta.url), "..");

describe("orchesto pack", () => {
  it("has name: orchesto matching the folder", async () => {
    const skill = await readFile(
      join(repoRoot, "skills", "orchesto", "SKILL.md"),
      "utf8",
    );
    assert.match(skill, /^---\nname: orchesto\n/m);
  });

  it("ships five seat files byte-equal to vault templates", async () => {
    for (const id of ORCHESTO_PERSONA_IDS) {
      const pack = join(
        repoRoot,
        "skills",
        "orchesto",
        "references",
        `persona-${id}.md`,
      );
      const vault = join(
        repoRoot,
        "templates",
        "vault",
        "workflows",
        "global",
        `persona-${id}.md`,
      );
      const [a, b] = await Promise.all([
        readFile(pack, "utf8"),
        readFile(vault, "utf8"),
      ]);
      assert.equal(a, b, `persona-${id} pack !== vault template`);
    }
  });

  it("does not ship auditor in the pack", async () => {
    assert.equal(
      await pathExists(
        join(
          repoRoot,
          "skills",
          "orchesto",
          "references",
          "persona-auditor.md",
        ),
      ),
      false,
    );
  });
});
