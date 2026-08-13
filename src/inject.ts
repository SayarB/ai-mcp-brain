import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import {
  configDir,
  expandHome,
  loadConfig,
  resolveVaultPath,
  type BrainConfig,
} from "./config.ts";
import {
  pathExists,
  readText,
  resolveMcpLaunch,
  writeText,
  type McpLaunch,
} from "./runtime.ts";

export type InjectTarget = "cursor" | "claude" | "codex" | "zed" | "all";

export type InjectAction = {
  target: string;
  path: string;
  action: "wrote" | "updated" | "skipped" | "merged";
  detail?: string;
};

const START = "<!-- second-brain:start -->";
const END = "<!-- second-brain:end -->";
const CODEX_MCP_START = "# --- ai-mcp-brain MCP server ---";
const CODEX_MCP_END = "# --- end ai-mcp-brain MCP server ---";

function mcpServerScript(): string {
  return resolve(configDir(), "src", "mcp", "server.ts");
}

function mcpLaunchConfig(vaultPath: string): McpLaunch {
  return resolveMcpLaunch(configDir(), mcpServerScript(), vaultPath);
}

function zedContextServerConfig(vaultPath: string): Record<string, unknown> {
  const launch = mcpLaunchConfig(vaultPath);
  // Zed docs: command + args + env (cwd not documented; BRAIN_VAULT is enough)
  return {
    enabled: true,
    command: launch.command,
    args: launch.args,
    env: launch.env,
  };
}

async function loadPolicy(vaultPath: string): Promise<string> {
  const policyPath = join(configDir(), "templates", "prompts", "memory-policy.md");
  const raw = await readText(policyPath);
  return raw
    .replaceAll("{{VAULT_PATH}}", vaultPath)
    .replaceAll("{{MCP_SERVER_PATH}}", mcpServerScript())
    .replaceAll("{{REPO_ROOT}}", configDir())
    .trim();
}

async function renderTemplate(
  relativeTemplate: string,
  policy: string,
): Promise<string> {
  const path = join(configDir(), "templates", relativeTemplate);
  const raw = await readText(path);
  return raw.replaceAll("{{POLICY}}", policy).trimEnd() + "\n";
}

function upsertMarkedBlock(
  existing: string,
  block: string,
  start = START,
  end = END,
): { next: string; updated: boolean } {
  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx).trimEnd();
    const after = existing.slice(endIdx + end.length).trimStart();
    const parts = [before, block.trim(), after].filter(Boolean);
    return { next: parts.join("\n\n") + "\n", updated: true };
  }

  const base = existing.trimEnd();
  if (!base) return { next: block.trim() + "\n", updated: false };
  return { next: `${base}\n\n${block.trim()}\n`, updated: false };
}

async function writeFileEnsured(
  path: string,
  contents: string,
): Promise<"wrote" | "updated"> {
  const existed = await pathExists(path);
  await writeText(path, contents);
  return existed ? "updated" : "wrote";
}

async function injectCursorRules(
  config: BrainConfig,
  policy: string,
  vaultPath: string,
): Promise<InjectAction[]> {
  const actions: InjectAction[] = [];
  const rulesDir = resolve(expandHome(config.inject.cursor_rules_dir));
  const rulePath = join(rulesDir, "second-brain.mdc");
  const body = await renderTemplate("rules/cursor/second-brain.mdc", policy);
  const action = await writeFileEnsured(rulePath, body);
  actions.push({ target: "cursor-rules", path: rulePath, action });

  const mcpPath = resolve(expandHome(config.inject.cursor_mcp_file));
  actions.push(await mergeCursorMcp(mcpPath, vaultPath));

  // Also write project-local MCP config (Cursor often prefers this in-repo)
  const projectMcp = resolve(configDir(), ".cursor", "mcp.json");
  actions.push(await mergeCursorMcp(projectMcp, vaultPath));
  return actions;
}

async function mergeCursorMcp(
  mcpPath: string,
  vaultPath: string,
): Promise<InjectAction> {
  await mkdir(dirname(mcpPath), { recursive: true });
  let root: { mcpServers?: Record<string, unknown> } = {};
  if (await pathExists(mcpPath)) {
    try {
      root = JSON.parse(await readText(mcpPath)) as typeof root;
    } catch {
      throw new Error(`Invalid JSON in ${mcpPath}`);
    }
  }
  if (!root.mcpServers || typeof root.mcpServers !== "object") {
    root.mcpServers = {};
  }

  const launch = mcpLaunchConfig(vaultPath);
  root.mcpServers["ai-mcp-brain"] = {
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env,
  };

  await writeText(mcpPath, `${JSON.stringify(root, null, 2)}\n`);
  return {
    target: "cursor-mcp",
    path: mcpPath,
    action: "merged",
    detail: `mcpServers.ai-mcp-brain (+ cwd, BRAIN_VAULT, ${launch.runtime})`,
  };
}

async function injectMarkedFile(
  target: string,
  filePath: string,
  templateRel: string,
  policy: string,
): Promise<InjectAction> {
  const block = await renderTemplate(templateRel, policy);
  const existing = (await pathExists(filePath)) ? await readText(filePath) : "";
  const { next, updated } = upsertMarkedBlock(existing, block);
  const action = await writeFileEnsured(filePath, next);
  return {
    target,
    path: filePath,
    action: updated ? "updated" : action,
  };
}

async function injectCodexMcp(
  configPath: string,
  vaultPath: string,
): Promise<InjectAction> {
  await mkdir(dirname(configPath), { recursive: true });
  const existing = (await pathExists(configPath))
    ? await readText(configPath)
    : "";
  const launch = mcpLaunchConfig(vaultPath);
  const block = [
    CODEX_MCP_START,
    "[mcp_servers.ai-mcp-brain]",
    `command = ${JSON.stringify(launch.command)}`,
    `args = [${launch.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    `cwd = ${JSON.stringify(launch.cwd)}`,
    "[mcp_servers.ai-mcp-brain.env]",
    ...Object.entries(launch.env).map(
      ([k, v]) => `${k} = ${JSON.stringify(v)}`,
    ),
    CODEX_MCP_END,
  ].join("\n");

  const { next, updated } = upsertMarkedBlock(
    existing,
    block,
    CODEX_MCP_START,
    CODEX_MCP_END,
  );
  const action = await writeFileEnsured(configPath, next);
  const envKeys = Object.keys(launch.env).join(", ");
  return {
    target: "codex-mcp",
    path: configPath,
    action: updated ? "updated" : action,
    detail: `mcp_servers.ai-mcp-brain (+ cwd, env: ${envKeys}, ${launch.runtime})`,
  };
}

async function injectZed(
  config: BrainConfig,
  policy: string,
  vaultPath: string,
): Promise<InjectAction[]> {
  const actions: InjectAction[] = [];
  actions.push(
    await injectMarkedFile(
      "zed-agents",
      resolve(expandHome(config.inject.zed_agents_file)),
      "rules/zed/second-brain.block.md",
      policy,
    ),
  );
  actions.push(
    await mergeZedSettings(
      resolve(expandHome(config.inject.zed_settings_file)),
      vaultPath,
    ),
  );
  return actions;
}

async function mergeZedSettings(
  settingsPath: string,
  vaultPath: string,
): Promise<InjectAction> {
  await mkdir(dirname(settingsPath), { recursive: true });
  const existing = (await pathExists(settingsPath))
    ? await readText(settingsPath)
    : "{\n}\n";

  const server = zedContextServerConfig(vaultPath);
  const formatting = { insertSpaces: true, tabSize: 4, eol: "\n" as const };

  // Ensure context_servers object exists, then set ai-mcp-brain (preserves JSONC comments)
  let next = existing;
  const editsServer = modify(
    next,
    ["context_servers", "ai-mcp-brain"],
    server,
    { formattingOptions: formatting },
  );
  if (!editsServer.length) {
    // Root may be empty / missing context_servers — seed then set
    const seedEdits = modify(next, ["context_servers"], {}, {
      formattingOptions: formatting,
    });
    next = applyEdits(next, seedEdits);
    const retry = modify(
      next,
      ["context_servers", "ai-mcp-brain"],
      server,
      { formattingOptions: formatting },
    );
    next = applyEdits(next, retry);
  } else {
    next = applyEdits(next, editsServer);
  }

  if (!next.endsWith("\n")) next += "\n";
  const action = await writeFileEnsured(settingsPath, next);
  return {
    target: "zed-mcp",
    path: settingsPath,
    action,
    detail: "context_servers.ai-mcp-brain",
  };
}

/** Global Orchesto skill paths (user-level harness adapters). */
export function orchestoGlobalSkillPaths(target: InjectTarget = "all"): string[] {
  const paths: string[] = [];
  const doCursor = target === "all" || target === "cursor";
  const doClaude = target === "all" || target === "claude";
  // Zed / Codex / OpenCode-style agents path
  const doAgents =
    target === "all" || target === "zed" || target === "codex";

  if (doCursor) paths.push(expandHome("~/.cursor/skills/orchesto/SKILL.md"));
  if (doAgents) paths.push(expandHome("~/.agents/skills/orchesto/SKILL.md"));
  if (doClaude) paths.push(expandHome("~/.claude/skills/orchesto/SKILL.md"));
  return paths;
}

async function loadOrchestoSkillBody(): Promise<string> {
  const skillPath = join(configDir(), "templates", "skills", "orchesto", "SKILL.md");
  const body = await readText(skillPath);
  return body.endsWith("\n") ? body : `${body}\n`;
}

async function installOrchestoSkillFile(
  destPath: string,
  skillBody: string,
): Promise<InjectAction> {
  await mkdir(dirname(destPath), { recursive: true });
  const existed = await pathExists(destPath);
  if (existed) {
    const existing = await readText(destPath);
    if (existing === skillBody) {
      return {
        target: "orchesto-skill",
        path: destPath,
        action: "skipped",
        detail: "unchanged",
      };
    }
  }
  await writeText(destPath, skillBody);
  return {
    target: "orchesto-skill",
    path: destPath,
    action: existed ? "updated" : "wrote",
    detail: "global Orchesto skill",
  };
}

/** Install Orchesto SKILL.md into global harness skill dirs (idempotent). */
export async function installOrchestoSkills(
  target: InjectTarget = "all",
): Promise<InjectAction[]> {
  const skillBody = await loadOrchestoSkillBody();
  const actions: InjectAction[] = [];
  for (const dest of orchestoGlobalSkillPaths(target)) {
    actions.push(await installOrchestoSkillFile(dest, skillBody));
  }
  return actions;
}

export async function injectHarnesses(
  target: InjectTarget = "all",
): Promise<{ vaultPath: string; actions: InjectAction[] }> {
  const config = await loadConfig();
  const vaultPath = resolveVaultPath(config.vault_path);
  const policy = await loadPolicy(vaultPath);
  const actions: InjectAction[] = [];

  const doCursor = target === "all" || target === "cursor";
  const doClaude = target === "all" || target === "claude";
  const doCodex = target === "all" || target === "codex";
  const doZed = target === "all" || target === "zed";

  if (doCursor) {
    actions.push(...(await injectCursorRules(config, policy, vaultPath)));
  }
  if (doClaude) {
    actions.push(
      await injectMarkedFile(
        "claude",
        resolve(expandHome(config.inject.claude_file)),
        "rules/claude/second-brain.block.md",
        policy,
      ),
    );
  }
  if (doCodex) {
    actions.push(
      await injectMarkedFile(
        "codex",
        resolve(expandHome(config.inject.codex_file)),
        "rules/codex/second-brain.block.md",
        policy,
      ),
    );
    actions.push(
      await injectCodexMcp(
        resolve(expandHome(config.inject.codex_config)),
        vaultPath,
      ),
    );
  }
  if (doZed) {
    actions.push(...(await injectZed(config, policy, vaultPath)));
  }

  // Orchesto ships with the brain — global harness skill adapters
  actions.push(...(await installOrchestoSkills(target)));

  return { vaultPath, actions };
}

export function formatInjectReport(
  vaultPath: string,
  actions: InjectAction[],
): string {
  const lines = [
    `[inject] vault: ${vaultPath}`,
    `[inject] actions: ${actions.length}`,
  ];
  for (const a of actions) {
    const detail = a.detail ? ` (${a.detail})` : "";
    lines.push(`[inject] ${a.action}: ${a.target} → ${a.path}${detail}`);
  }
  lines.push(
    "[inject] restart Cursor / Claude / Codex / Zed to pick up MCP + rules.",
  );
  return lines.join("\n");
}
