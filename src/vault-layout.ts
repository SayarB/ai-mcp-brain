/**
 * Canonical vault folders created on install/init.
 * Keep INSTALL.md “Ensure dirs exist” in sync with this list.
 */
export const REQUIRED_VAULT_DIRS = [
  "inbox",
  "external",
  "projects",
  "patterns",
  "stack",
  "stack/catalog",
  "media",
  "agents",
  "instructions",
  "instructions/global",
  "suggestions",
  "suggestions/global",
  "workflows",
  "workflows/global",
  "actions",
  "_meta",
] as const;

/** Seeded guidance kinds (empty shells under instructions/ and suggestions/). */
export const SEEDED_GUIDANCE_KINDS = [
  "coding",
  "planning",
  "pr-review",
  "commit",
  "git",
] as const;
