import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import {
  moduleDir,
  parseToml,
  pathExists,
  readText,
  writeText,
} from "./runtime.ts";

export type InjectConfig = {
  cursor_rules_dir: string;
  cursor_mcp_file: string;
  cursor_hooks_file: string;
  claude_file: string;
  codex_file: string;
  codex_config: string;
  zed_settings_file: string;
  zed_agents_file: string;
};

export type JiraConfig = {
  base_url?: string;
  email_env?: string;
  token_env?: string;
  default_jql?: string;
  default_project?: string;
  default_issue_type?: string;
};

export type DaemonConfig = {
  host?: string;
  port?: number;
  default_mode?: "read-write" | "read-only" | "disabled";
  auth_token_env?: string;
  allow_remote?: boolean;
};

export type AppConfigEntry = {
  enabled?: boolean;
  mode?: "read-write" | "read-only" | "disabled";
  read_scopes?: ("global" | "project")[];
  write_scopes?: ("global" | "project")[];
  allowed_projects?: string[];
  denied_tools?: string[];
};

export type BrainConfig = {
  vault_path: string;
  inject: InjectConfig;
  jira?: JiraConfig;
  daemon?: DaemonConfig;
  apps?: Record<string, AppConfigEntry>;
};

/** Cross-OS defaults using ~ (expanded at resolve time). */
export function platformInjectDefaults(): InjectConfig {
  const isWin = platform() === "win32";
  // Zed: macOS/Linux ~/.config/zed; Windows %APPDATA%\Zed
  const zedRoot = isWin
    ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Zed")
    : join(homedir(), ".config", "zed");

  return {
    cursor_rules_dir: "~/.cursor/rules",
    cursor_mcp_file: "~/.cursor/mcp.json",
    cursor_hooks_file: "~/.cursor/hooks.json",
    claude_file: "~/.claude/CLAUDE.md",
    codex_file: "~/.codex/AGENTS.md",
    codex_config: "~/.codex/config.toml",
    zed_settings_file: join(zedRoot, "settings.json"),
    zed_agents_file: join(zedRoot, "AGENTS.md"),
  };
}

const DEFAULTS: BrainConfig = {
  vault_path: "~/Obsidian/My Brain",
  inject: platformInjectDefaults(),
};

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  // Windows-style %USERPROFILE%
  if (path.includes("%USERPROFILE%")) {
    return path.replaceAll("%USERPROFILE%", homedir());
  }
  return path;
}

export function resolveVaultPath(configured: string, override?: string): string {
  const raw = process.env.BRAIN_VAULT?.trim() || override?.trim() || configured;
  return resolve(expandHome(raw));
}

function repoRoot(): string {
  return resolve(moduleDir(import.meta.url), "..");
}

function extractTomlTables(raw: string, prefixes: string[]): string {
  const lines = raw.split(/\r?\n/);
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i]!.trim();
    const match = trimmed.match(/^\[([^\]]+)\]$/);
    if (
      match &&
      prefixes.some((p) => match[1] === p || match[1]!.startsWith(`${p}.`))
    ) {
      let end = i + 1;
      while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end]!)) {
        end++;
      }
      blocks.push(lines.slice(i, end).join("\n").trimEnd());
      i = end;
      continue;
    }
    i++;
  }
  return blocks.join("\n\n");
}

export async function loadConfig(): Promise<BrainConfig> {
  const defaults: BrainConfig = {
    vault_path: DEFAULTS.vault_path,
    inject: platformInjectDefaults(),
  };
  const configPath = join(repoRoot(), "config.toml");

  if (!(await pathExists(configPath))) {
    return structuredClone(defaults);
  }

  const parsed = parseToml<
    Partial<BrainConfig> & {
      inject?: Partial<InjectConfig>;
      jira?: JiraConfig;
      daemon?: DaemonConfig;
      apps?: Record<string, AppConfigEntry>;
    }
  >(await readText(configPath));
  const inj = platformInjectDefaults();

  const jira = parsed.jira
    ? {
        base_url: parsed.jira.base_url,
        email_env: parsed.jira.email_env,
        token_env: parsed.jira.token_env,
        default_jql: parsed.jira.default_jql,
        default_project: parsed.jira.default_project,
        default_issue_type: parsed.jira.default_issue_type,
      }
    : undefined;

  const daemon = parsed.daemon
    ? {
        host: parsed.daemon.host,
        port: parsed.daemon.port,
        default_mode: parsed.daemon.default_mode,
        auth_token_env: parsed.daemon.auth_token_env,
        allow_remote: parsed.daemon.allow_remote,
      }
    : undefined;

  const apps = parsed.apps && typeof parsed.apps === "object" ? parsed.apps : undefined;

  return {
    vault_path: parsed.vault_path ?? defaults.vault_path,
    inject: {
      cursor_rules_dir: parsed.inject?.cursor_rules_dir ?? inj.cursor_rules_dir,
      cursor_mcp_file: parsed.inject?.cursor_mcp_file ?? inj.cursor_mcp_file,
      cursor_hooks_file:
        parsed.inject?.cursor_hooks_file ?? inj.cursor_hooks_file,
      claude_file: parsed.inject?.claude_file ?? inj.claude_file,
      codex_file: parsed.inject?.codex_file ?? inj.codex_file,
      codex_config: parsed.inject?.codex_config ?? inj.codex_config,
      zed_settings_file:
        parsed.inject?.zed_settings_file ?? inj.zed_settings_file,
      zed_agents_file: parsed.inject?.zed_agents_file ?? inj.zed_agents_file,
    },
    jira,
    daemon,
    apps,
  };
}

/** Write config.toml for a chosen vault path (portable ~ form when under home). Preserves [jira], [daemon], and [apps.*]. */
export async function writeConfig(vaultPathInput: string): Promise<string> {
  const abs = resolveVaultPath(vaultPathInput);
  const home = homedir();
  const vaultForToml = abs.startsWith(home)
    ? `~/${abs.slice(home.length).replace(/^[/\\]/, "").split("\\").join("/")}`
    : abs.split("\\").join("/");

  const configPath = join(repoRoot(), "config.toml");
  let preservedSections = "";
  if (await pathExists(configPath)) {
    const existing = await readText(configPath);
    const tables = extractTomlTables(existing, ["jira", "daemon", "apps"]);
    if (tables) preservedSections = `\n${tables}\n`;
  }

  const body = `# Generated by setup. BRAIN_VAULT env overrides vault_path.
# Optional Jira / Daemon / ACLs: see config.example.toml.

vault_path = ${JSON.stringify(vaultForToml)}

[inject]
# Leave defaults unless you need custom harness paths.
# Zed paths are OS-specific and resolved at runtime if omitted from an older config.
${preservedSections}`;

  await writeText(configPath, body);
  return configPath;
}

export function configDir(): string {
  return repoRoot();
}
