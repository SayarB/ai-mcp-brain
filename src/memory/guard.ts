/**
 * Write-time secret & credential guard.
 * Blocks accidental persistence of API keys, private keys, JWTs, or credentialed URLs into the vault.
 * Never echoes the matched secret value in error messages.
 */

export type SecretFinding = {
  rule: string;
  label: string;
};

const STRICT_PLACEHOLDER_RE =
  /^(?:your[-_]|example|placeholder|dummy|fake|test[-_]?key|changeme|replace[-_]?me|redact|xxx+|000+|12345|<[^>]+>|\$\{[^}]+\}|\$[A-Z_]+|process\.env\.|env\.)/i;

function isStrictPlaceholder(value: string): boolean {
  const cleaned = value.trim().replace(/^["'`]|["'`]$/g, "");
  if (!cleaned) return true;
  if (STRICT_PLACEHOLDER_RE.test(cleaned)) return true;
  // Strip known token prefix (e.g. ghp_, sk-, glpat-, npm_) and check if remainder is obvious placeholder
  const afterPrefix = cleaned.replace(
    /^(?:gh[pousr]_|github_pat_|sk-(?:proj-|ant-api\d*-)?|glpat-|npm_|xox[baprs]-|[rs]k_(?:live|test)_|AIza)/i,
    "",
  );
  if (STRICT_PLACEHOLDER_RE.test(afterPrefix)) return true;
  if (/^(.)\1{7,}$/.test(afterPrefix) || /^(.)\1{7,}$/.test(cleaned)) return true;
  return false;
}

function isAssignmentPlaceholder(value: string): boolean {
  if (isStrictPlaceholder(value)) return true;
  const cleaned = value.trim().replace(/^["'`]|["'`]$/g, "");
  return /(?:example|placeholder|your[_-]?|changeme|dummy|redacted|fake)/i.test(
    cleaned,
  );
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

/** Distinguish real OpenAI/Anthropic `sk-...` keys from ordinary kebab-case identifiers like `sk-feature-implement-cache`. */
function looksLikeRealSkKey(match: string): boolean {
  if (isStrictPlaceholder(match)) return false;
  if (/^sk-ant-api\d*-/i.test(match)) {
    const tail = match.replace(/^sk-ant-api\d*-/i, "");
    return tail.length >= 24 && shannonEntropy(tail) >= 3.4;
  }
  const tail = match.replace(/^sk-(?:proj-|svcacct-)?/i, "");
  if (tail.length < 24) return false;
  // Pure lowercase words separated by hyphens (e.g. feature-implement-retrieval-cache) are slugs, not API keys
  if (/^[a-z]+(?:-[a-z0-9]+){2,}$/.test(tail)) return false;
  const hasUpper = /[A-Z]/.test(tail);
  const hasLower = /[a-z]/.test(tail);
  const hasDigit = /[0-9]/.test(tail);
  const classCount = Number(hasUpper) + Number(hasLower) + Number(hasDigit);
  return classCount >= 2 && shannonEntropy(tail) >= 3.5;
}

type SecretPattern = {
  rule: string;
  label: string;
  regex: RegExp;
  validate?: (match: string) => boolean;
};

const HIGH_CONFIDENCE_PATTERNS: SecretPattern[] = [
  {
    rule: "private-key",
    label: "PEM private key block",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    validate: () => true,
  },
  {
    rule: "github-token",
    label: "GitHub personal access token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
    validate: (m) => !isStrictPlaceholder(m),
  },
  {
    rule: "openai-anthropic-key",
    label: "OpenAI / Anthropic API key",
    regex: /\bsk-(?:proj-|svcacct-|ant-api\d*-)?[A-Za-z0-9_-]{24,}\b/g,
    validate: looksLikeRealSkKey,
  },
  {
    rule: "aws-access-key",
    label: "AWS access key ID",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    validate: (m) => m !== "AKIAIOSFODNN7EXAMPLE" && !isStrictPlaceholder(m),
  },
  {
    rule: "slack-token",
    label: "Slack API token",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g,
    validate: (m) => !isStrictPlaceholder(m),
  },
  {
    rule: "google-api-key",
    label: "Google API key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    validate: (m) => !isStrictPlaceholder(m),
  },
  {
    rule: "gitlab-token",
    label: "GitLab personal access token",
    regex: /\bglpat-[0-9A-Za-z_-]{20,}\b/g,
    validate: (m) => !isStrictPlaceholder(m),
  },
  {
    rule: "npm-token",
    label: "npm access token",
    regex: /\bnpm_[A-Za-z0-9]{30,}\b/g,
    validate: (m) => !isStrictPlaceholder(m),
  },
  {
    rule: "stripe-key",
    label: "Stripe secret key",
    regex: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{20,}\b/g,
    validate: (m) => !isStrictPlaceholder(m),
  },
  {
    rule: "jwt-token",
    label: "JWT bearer token",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    validate: (m) => !isStrictPlaceholder(m),
  },
];

// Supports empty username (e.g. redis://:password@host) and common DB/transport schemes
const CREDENTIALED_URL_RE =
  /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?|s?ftps?|ssh):\/\/([^/\s:@]{0,64}):([^/\s@]{4,128})@([^\s/]+)/gi;

// Matches bare or prefixed env keys like OPENAI_API_KEY=..., DB_PASSWORD=..., AWS_SECRET_ACCESS_KEY=..., _authToken=...
const ASSIGNMENT_RE =
  /(?:^|[^A-Za-z0-9_])(?:[A-Za-z0-9_]{1,40}_)?(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|password|passwd|secret[_-]?key|secret)\s*[:=]\s*["'`]?([^\s"'`,;]{12,160})["'`]?/gi;

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
    for (const m of combined.matchAll(pat.regex)) {
      const matched = m[0];
      if (!matched) continue;
      if (!pat.validate || pat.validate(matched)) {
        add(pat.rule, pat.label);
        break;
      }
    }
  }

  for (const m of combined.matchAll(CREDENTIALED_URL_RE)) {
    const user = m[1] ?? "";
    const pass = m[2] ?? "";
    const host = m[3] ?? "";
    const fakeCred =
      isAssignmentPlaceholder(pass) ||
      (/^(?:|user|username|admin|root|dbuser)$/i.test(user) &&
        /^(?:pass|password|secret|pwd)$/i.test(pass)) ||
      /(?:^|\.)example\.(?:com|org|net)(?::\d+)?$/i.test(host);
    if (!fakeCred) {
      add("credentialed-url", "URL containing embedded credentials");
    }
  }

  for (const m of combined.matchAll(ASSIGNMENT_RE)) {
    const val = m[1] ?? "";
    if (isAssignmentPlaceholder(val)) continue;
    if (val.length >= 16 && shannonEntropy(val) >= 3.2) {
      add("secret-assignment", "High-entropy credential assignment");
    }
  }

  for (const m of combined.matchAll(BEARER_RE)) {
    const val = m[1] ?? "";
    if (isAssignmentPlaceholder(val)) continue;
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
