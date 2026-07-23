import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  configDir,
  expandHome,
  loadConfig,
  resolveVaultPath,
  type BrainConfig,
} from "./config.ts";

export type InjectTarget = "cursor" | "claude" | "codex" | "all";

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

async function loadPolicy(vaultPath: string): Promise<string> {
  const policyPath = join(configDir(), "templates", "prompts", "memory-policy.md");
  const raw = await Bun.file(policyPath).text();
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
  const raw = await Bun.file(path).text();
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

async function writeFileEnsured(path: string, contents: string): Promise<"wrote" | "updated"> {
  const file = Bun.file(path);
  const existed = await file.exists();
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, contents);
  return existed ? "updated" : "wrote";
}

async function injectCursorRules(
  config: BrainConfig,
  policy: string,
): Promise<InjectAction[]> {
  const actions: InjectAction[] = [];
  const rulesDir = resolve(expandHome(config.inject.cursor_rules_dir));
  const rulePath = join(rulesDir, "second-brain.mdc");
  const body = await renderTemplate("rules/cursor/second-brain.mdc", policy);
  const action = await writeFileEnsured(rulePath, body);
  actions.push({ target: "cursor-rules", path: rulePath, action });

  const mcpPath = resolve(expandHome(config.inject.cursor_mcp_file));
  actions.push(await mergeCursorMcp(mcpPath));
  return actions;
}

async function mergeCursorMcp(mcpPath: string): Promise<InjectAction> {
  await mkdir(dirname(mcpPath), { recursive: true });
  const file = Bun.file(mcpPath);
  let root: { mcpServers?: Record<string, unknown> } = {};
  if (await file.exists()) {
    try {
      root = JSON.parse(await file.text()) as typeof root;
    } catch {
      throw new Error(`Invalid JSON in ${mcpPath}`);
    }
  }
  if (!root.mcpServers || typeof root.mcpServers !== "object") {
    root.mcpServers = {};
  }

  root.mcpServers["ai-mcp-brain"] = {
    command: "bun",
    args: [mcpServerScript()],
  };

  await Bun.write(mcpPath, `${JSON.stringify(root, null, 2)}\n`);
  return {
    target: "cursor-mcp",
    path: mcpPath,
    action: "merged",
    detail: "mcpServers.ai-mcp-brain",
  };
}

async function injectMarkedFile(
  target: string,
  filePath: string,
  templateRel: string,
  policy: string,
): Promise<InjectAction> {
  const block = await renderTemplate(templateRel, policy);
  const file = Bun.file(filePath);
  const existing = (await file.exists()) ? await file.text() : "";
  const { next, updated } = upsertMarkedBlock(existing, block);
  const action = await writeFileEnsured(filePath, next);
  return {
    target,
    path: filePath,
    action: updated ? "updated" : action,
  };
}

async function injectCodexMcp(configPath: string): Promise<InjectAction> {
  await mkdir(dirname(configPath), { recursive: true });
  const file = Bun.file(configPath);
  const existing = (await file.exists()) ? await file.text() : "";
  const block = [
    CODEX_MCP_START,
    "[mcp_servers.ai-mcp-brain]",
    'command = "bun"',
    `args = [${JSON.stringify(mcpServerScript())}]`,
    CODEX_MCP_END,
  ].join("\n");

  const { next, updated } = upsertMarkedBlock(
    existing,
    block,
    CODEX_MCP_START,
    CODEX_MCP_END,
  );
  const action = await writeFileEnsured(configPath, next);
  return {
    target: "codex-mcp",
    path: configPath,
    action: updated ? "updated" : action,
    detail: "mcp_servers.ai-mcp-brain",
  };
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

  if (doCursor) {
    actions.push(...(await injectCursorRules(config, policy)));
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
      await injectCodexMcp(resolve(expandHome(config.inject.codex_config))),
    );
  }

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
    "[inject] restart Cursor / Claude / Codex sessions to pick up MCP + rules.",
  );
  return lines.join("\n");
}
