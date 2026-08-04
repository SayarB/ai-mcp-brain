import type { BrainConfig } from "../config.ts";
import { DEFAULT_JIRA_JQL, type JiraIssueRow } from "../work/types.ts";

export type JiraRuntimeConfig = {
  baseUrl: string;
  email: string;
  token: string;
  defaultJql: string;
};

export class JiraNotConfiguredError extends Error {
  constructor(message = "Jira is not configured (optional). Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in .env or MCP env.") {
    super(message);
    this.name = "JiraNotConfiguredError";
  }
}

export function resolveJiraConfig(config: BrainConfig): JiraRuntimeConfig | null {
  const j = config.jira;
  const emailEnv = j?.email_env || "JIRA_EMAIL";
  const tokenEnv = j?.token_env || "JIRA_API_TOKEN";
  const email = process.env[emailEnv]?.trim() || process.env.JIRA_EMAIL?.trim();
  const token = process.env[tokenEnv]?.trim() || process.env.JIRA_API_TOKEN?.trim();
  const baseUrl = (
    process.env.JIRA_BASE_URL?.trim() ||
    j?.base_url?.trim() ||
    ""
  ).replace(/\/$/, "");
  const defaultJql = j?.default_jql?.trim() || DEFAULT_JIRA_JQL;

  if (!baseUrl || !email || !token) return null;
  return { baseUrl, email, token, defaultJql };
}

export function isJiraConfigured(config: BrainConfig): boolean {
  return resolveJiraConfig(config) !== null;
}

type JiraSearchResponse = {
  issues?: Array<{
    key: string;
    fields?: {
      summary?: string;
      status?: { name?: string };
      updated?: string;
    };
  }>;
  errorMessages?: string[];
  errors?: Record<string, string>;
};

export async function fetchJiraAssigned(
  cfg: JiraRuntimeConfig,
  jql?: string,
): Promise<{ filter: string; issues: JiraIssueRow[] }> {
  const filter = (jql?.trim() || cfg.defaultJql).trim();
  const url = new URL(`${cfg.baseUrl}/rest/api/3/search`);
  url.searchParams.set("jql", filter);
  url.searchParams.set("maxResults", "100");
  url.searchParams.set("fields", "summary,status,updated");

  const auth = Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64");
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let data: JiraSearchResponse;
  try {
    data = JSON.parse(text) as JiraSearchResponse;
  } catch {
    throw new Error(`Jira search failed (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const msg =
      data.errorMessages?.join("; ") ||
      (data.errors && Object.values(data.errors).join("; ")) ||
      text.slice(0, 200);
    throw new Error(`Jira search failed (${res.status}): ${msg}`);
  }

  const issues: JiraIssueRow[] = (data.issues ?? []).map((iss) => {
    const key = iss.key;
    return {
      key,
      summary: iss.fields?.summary ?? "",
      status: iss.fields?.status?.name ?? "",
      url: `${cfg.baseUrl}/browse/${key}`,
      updated: iss.fields?.updated ?? "",
    };
  });

  return { filter, issues };
}
