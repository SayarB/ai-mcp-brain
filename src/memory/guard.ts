/**
 * Write-time secret & credential guard.
 * Blocks accidental persistence of API keys, private keys, JWTs, or credentialed URLs into the vault.
 * Never echoes the matched secret value in error messages.
 */

export type SecretFinding = {
  rule: string;
  label: string;
};

const PLACEHOLDER_RE =
  /^(?:your[-_]|example|placeholder|dummy|fake|test[-_]?key|changeme|replace[-_]?me|redact|xxx+|000+|12345|<[^>]+>|\$\{[^}]+\}|\$[A-Z_]+|process\.env\.|env\.)/i;

function isPlaceholder(value: string): boolean {
  const cleaned = value.trim().replace(/^["'`]|["'`]$/g, "");
  if (!cleaned) return true;
  if (PLACEHOLDER_RE.test(cleaned)) return true;
  if (/(?:example|placeholder|your[_-]?|changeme|dummy|redacted|fake)/i.test(cleaned)) {
    return true;
  }
  // Repeated single char (e.g. aaaaaaaaaaaaaaaa)
  if (/^(.)\1{7,}$/.test(cleaned)) return true;
  return false;
}

function shannonEntropy(str: string): number {
  if (!str.length) return 0;
  const counts = new Map<string, number>();
  for (const ch of str) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

type SecretPattern = {
  rule: string;
  label: string;
  regex: RegExp;
  skipPlaceholderCheck?: boolean;
};

const HIGH_CONFIDENCE_PATTERNS: SecretPattern[] = [
  {
    rule: "private-key",
    label: "PEM private key block",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    skipPlaceholderCheck: true,
  },
  {
    rule: "github-token",
    label: "GitHub personal access token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  },
  {
    rule: "openai-anthropic-key",
    label: "OpenAI / Anthropic API key",
    regex: /\bsk-(?:proj-|ant-api\d*-)?[A-Za-z0-9_-]{24,}\b/,
  },
  {
    rule: "aws-access-key",
    label: "AWS access key ID",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    rule: "slack-token",
    label: "Slack API token",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/,
  },
  {
    rule: "google-api-key",
    label: "Google API key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    rule: "gitlab-token",
    label: "GitLab personal access token",
    regex: /\bglpat-[0-9A-Za-z_-]{20,}\b/,
  },
  {
    rule: "stripe-key",
    label: "Stripe secret key",
    regex: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{20,}\b/,
  },
  {
    rule: "jwt-token",
    label: "JWT bearer token",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

const CREDENTIALED_URL_RE =
  /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/([^/\s:@]{1,64}):([^/\s@]{4,128})@([^\s/]+)/gi;

const ASSIGNMENT_RE =
  /\b(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret[_-]?key)\s*[:=]\s*["'`]?([^\s"'`,;]{12,160})["'`]?/gi;

const BEARER_RE = /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/-]{20,}=*)/gi;

export function scanForSecrets(...texts: (string | undefined | null)[]): SecretFinding[] {
  const combined = texts.filter((t): t is string => Boolean(t)).join("\n");
  if (!combined) return [];

  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const add = (rule: string, label: string) => {
    if (!seen.has(rule)) {
      seen.add(rule);
      findings.push({ rule, label });
    }
  };

  for (const pat of HIGH_CONFIDENCE_PATTERNS) {
    const m = combined.match(pat.regex);
    if (!m) continue;
    if (pat.skipPlaceholderCheck || !isPlaceholder(m[0])) {
      add(pat.rule, pat.label);
    }
  }

  for (const m of combined.matchAll(CREDENTIALED_URL_RE)) {
    const user = m[1] ?? "";
    const pass = m[2] ?? "";
    const host = m[3] ?? "";
    const fakeCred =
      isPlaceholder(pass) ||
      /^(?:user|username|admin|root|dbuser)$/i.test(user) && /^(?:pass|password|secret|pwd)$/i.test(pass) ||
      /(?:^|\.)example\.(?:com|org|net)(?::\d+)?$/i.test(host);
    if (!fakeCred) {
      add("credentialed-url", "URL containing embedded credentials");
    }
  }

  for (const m of combined.matchAll(ASSIGNMENT_RE)) {
    const val = m[1] ?? "";
    if (isPlaceholder(val)) continue;
    if (val.length >= 16 && shannonEntropy(val) >= 3.2) {
      add("secret-assignment", "High-entropy credential assignment");
    }
  }

  for (const m of combined.matchAll(BEARER_RE)) {
    const val = m[1] ?? "";
    if (isPlaceholder(val)) continue;
    if (shannonEntropy(val) >= 3.2) {
      add("bearer-header", "Authorization Bearer token");
    }
  }

  return findings;
}

export class SecretDetectedError extends Error {
  readonly findings: SecretFinding[];
  constructor(findings: SecretFinding[]) {
    const summary = findings.map((f) => `${f.label} (${f.rule})`).join(", ");
    super(
      `Refused to write to vault: detected potential secret(s): ${summary}. Remove credentials before saving.`,
    );
    this.name = "SecretDetectedError";
    this.findings = findings;
  }
}

export function assertNoSecrets(...texts: (string | undefined | null)[]): void {
  const findings = scanForSecrets(...texts);
  if (findings.length > 0) {
    throw new SecretDetectedError(findings);
  }
}
