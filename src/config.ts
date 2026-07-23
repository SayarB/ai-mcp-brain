import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type InjectConfig = {
  cursor_rules_dir: string;
  cursor_mcp_file: string;
  claude_file: string;
  codex_file: string;
  codex_config: string;
};

export type BrainConfig = {
  vault_path: string;
  inject: InjectConfig;
};

const DEFAULTS: BrainConfig = {
  vault_path:
    "/Users/sayarbhattacharyya/Library/Mobile Documents/iCloud~md~obsidian/Documents/My Brain",
  inject: {
    cursor_rules_dir: "~/.cursor/rules",
    cursor_mcp_file: "~/.cursor/mcp.json",
    claude_file: "~/.claude/CLAUDE.md",
    codex_file: "~/.codex/AGENTS.md",
    codex_config: "~/.codex/config.toml",
  },
};

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveVaultPath(configured: string, override?: string): string {
  const raw = process.env.BRAIN_VAULT?.trim() || override?.trim() || configured;
  return resolve(expandHome(raw));
}

function repoRoot(): string {
  // cli runs from repo via bun src/cli.ts; config lives at repo root
  return resolve(import.meta.dir, "..");
}

export async function loadConfig(): Promise<BrainConfig> {
  const configPath = join(repoRoot(), "config.toml");
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    return structuredClone(DEFAULTS);
  }

  const parsed = Bun.TOML.parse(await file.text()) as Partial<BrainConfig> & {
    inject?: Partial<InjectConfig>;
  };

  return {
    vault_path: parsed.vault_path ?? DEFAULTS.vault_path,
    inject: {
      cursor_rules_dir:
        parsed.inject?.cursor_rules_dir ?? DEFAULTS.inject.cursor_rules_dir,
      cursor_mcp_file:
        parsed.inject?.cursor_mcp_file ?? DEFAULTS.inject.cursor_mcp_file,
      claude_file: parsed.inject?.claude_file ?? DEFAULTS.inject.claude_file,
      codex_file: parsed.inject?.codex_file ?? DEFAULTS.inject.codex_file,
      codex_config:
        parsed.inject?.codex_config ?? DEFAULTS.inject.codex_config,
    },
  };
}

export function configDir(): string {
  return repoRoot();
}
