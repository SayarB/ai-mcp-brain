import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { configDir } from "./config.ts";
import { installOrchestoSkills } from "./inject.ts";
import {
  injectOrchestoOnly,
  removeOrchestoSkills,
  updateOrchesto,
} from "./orchesto-skills.ts";
import { pathExists, readText } from "./runtime.ts";

const execFileAsync = promisify(execFile);

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orchesto-skills-"));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "--template="]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "README.md"), "repo\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "init"]);
}

describe("installOrchestoSkills packs", () => {
  it("writes delivery + lifecycle packs", async () => {
    const home = await tmpDir();
    await installOrchestoSkills("all", { skillHome: home });
    const delivery = await readText(join(home, "orchesto", "SKILL.md"));
    assert.match(delivery, /^---\nname: orchesto\n/m);
    assert.equal(
      await pathExists(join(home, "orchesto", "references", "persona-architect.md")),
      true,
    );
    const updateSkill = await readText(join(home, "orchesto-update", "SKILL.md"));
    assert.match(updateSkill, /^---\nname: orchesto-update\n/m);
    assert.match(updateSkill, /update orchesto/i);
    assert.match(updateSkill, /sync orchesto/i);
    const removeSkill = await readText(join(home, "orchesto-remove", "SKILL.md"));
    assert.match(removeSkill, /^---\nname: orchesto-remove\n/m);
    assert.match(removeSkill, /remove orchesto/i);
    assert.match(removeSkill, /uninstall orchesto skill/i);
  });
});

describe("injectOrchestoOnly", () => {
  it("does not rewrite mcp.json", async () => {
    const home = await tmpDir();
    const vault = await tmpDir();
    const mcp = join(home, "mcp.json");
    const before = '{"mcpServers":{"keep":true}}\n';
    await writeFile(mcp, before);
    await injectOrchestoOnly("all", { skillHome: home, vaultPath: vault });
    assert.equal(await readText(mcp), before);
    const src = await readFile(join(configDir(), "src", "orchesto-skills.ts"), "utf8");
    assert.equal(src.includes("injectHarnesses"), false);
    assert.equal(src.includes("mcp.json"), false);
  });
});

describe("removeOrchestoSkills", () => {
  it("deletes only the three Orchesto dirs", async () => {
    const home = await tmpDir();
    const vaultPersona = join(home, "vault-persona.md");
    await writeFile(vaultPersona, "keep me\n");
    await mkdir(join(home, "other-skill"), { recursive: true });
    await writeFile(join(home, "other-skill", "SKILL.md"), "other\n");
    await mkdir(join(home, "orchesto"), { recursive: true });
    await mkdir(join(home, "orchesto-update"), { recursive: true });
    await mkdir(join(home, "orchesto-remove"), { recursive: true });
    await writeFile(join(home, "orchesto", "SKILL.md"), "x\n");
    await writeFile(join(home, "orchesto-update", "SKILL.md"), "x\n");
    await writeFile(join(home, "orchesto-remove", "SKILL.md"), "x\n");

    const actions = await removeOrchestoSkills("all", { skillHome: home });
    assert.ok(actions.some((a) => a.action === "removed"));
    assert.equal(await pathExists(join(home, "orchesto")), false);
    assert.equal(await pathExists(join(home, "orchesto-update")), false);
    assert.equal(await pathExists(join(home, "orchesto-remove")), false);
    assert.equal(await pathExists(join(home, "other-skill", "SKILL.md")), true);
    assert.equal(await readText(vaultPersona), "keep me\n");
  });
});

describe("updateOrchesto git safety", () => {
  it("aborts on a dirty clone without stash", async () => {
    const repo = await tmpDir();
    await initRepo(repo);
    await writeFile(join(repo, "dirty.txt"), "uncommitted\n");
    const home = await tmpDir();
    const vault = await tmpDir();
    await assert.rejects(
      () =>
        updateOrchesto("all", {
          repoRoot: repo,
          skillHome: home,
          vaultPath: vault,
        }),
      /Dirty clone/,
    );
    const porcelain = await git(repo, ["status", "--porcelain"]);
    assert.match(porcelain, /dirty\.txt/);
  });

  it("aborts when git pull --ff-only fails", async () => {
    const repo = await tmpDir();
    await initRepo(repo);
    const home = await tmpDir();
    const vault = await tmpDir();
    await assert.rejects(
      () =>
        updateOrchesto("all", {
          repoRoot: repo,
          skillHome: home,
          vaultPath: vault,
        }),
      /git pull --ff-only failed/,
    );
  });

  it("source does not stash, rebase, or force-pull", async () => {
    const src = await readFile(
      join(configDir(), "src", "orchesto-skills.ts"),
      "utf8",
    );
    assert.equal(/\bgit stash\b|\["stash"/.test(src), false);
    assert.equal(src.includes("--rebase"), false);
    assert.equal(src.includes("--force"), false);
    assert.match(src, /pull", "--ff-only"/);
  });
});
