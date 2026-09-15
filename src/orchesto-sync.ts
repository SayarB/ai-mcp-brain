import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathExists, readText, writeText } from "./runtime.ts";

export const ORCHESTO_PERSONA_IDS = [
  "brainstormer",
  "cpo",
  "architect",
  "implementor",
  "reviewer",
] as const;

export type OrchestoPersonaId = (typeof ORCHESTO_PERSONA_IDS)[number];

export const ORCHESTO_SYNC_META = "_meta/orchesto-sync.json";

export type OrchestoSyncAction = {
  target: "orchesto-persona";
  path: string;
  action: "wrote" | "updated" | "skipped";
  detail?: string;
};

type SyncMeta = {
  personas: Record<string, string>;
};

export function orchestoPersonaVaultRel(id: OrchestoPersonaId): string {
  return `workflows/global/persona-${id}.md`;
}

export function orchestoPersonaPackRel(id: OrchestoPersonaId): string {
  return `references/persona-${id}.md`;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function loadMeta(vaultPath: string): Promise<SyncMeta | null> {
  const abs = join(vaultPath, ORCHESTO_SYNC_META);
  if (!(await pathExists(abs))) return null;
  try {
    const parsed = JSON.parse(await readText(abs)) as SyncMeta;
    if (!parsed || typeof parsed !== "object" || !parsed.personas) {
      return { personas: {} };
    }
    return { personas: parsed.personas };
  } catch {
    return { personas: {} };
  }
}

async function saveMeta(vaultPath: string, meta: SyncMeta): Promise<void> {
  const abs = join(vaultPath, ORCHESTO_SYNC_META);
  await mkdir(join(vaultPath, "_meta"), { recursive: true });
  await writeText(abs, `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * Safe-sync the five Orchesto global vault personas from the skill pack.
 * Never writes under project overlay folders.
 */
export async function syncOrchestoVaultPersonas(
  vaultPath: string,
  packDir: string,
): Promise<OrchestoSyncAction[]> {
  const existingMeta = await loadMeta(vaultPath);
  const bootstrap = existingMeta === null;
  const meta: SyncMeta = existingMeta ?? { personas: {} };
  const actions: OrchestoSyncAction[] = [];

  for (const id of ORCHESTO_PERSONA_IDS) {
    const rel = orchestoPersonaVaultRel(id);
    const dest = join(vaultPath, rel);
    const packFile = join(packDir, orchestoPersonaPackRel(id));
    const packBody = await readText(packFile);
    const packHash = sha256Text(packBody);
    const destExists = await pathExists(dest);
    const destBody = destExists ? await readText(dest) : null;
    const lastHash = meta.personas[rel];

    if (!destExists) {
      await writeText(dest, packBody);
      meta.personas[rel] = packHash;
      actions.push({
        target: "orchesto-persona",
        path: dest,
        action: "wrote",
        detail: "missing vault persona",
      });
      continue;
    }

    if (destBody === packBody) {
      meta.personas[rel] = packHash;
      actions.push({
        target: "orchesto-persona",
        path: dest,
        action: "skipped",
        detail: "unchanged",
      });
      continue;
    }

    // Overwrite only on first install (no meta file) or when dest still
    // matches the last installed hash. A present meta file with a missing
    // hash is treated as a local edit — never as bootstrap.
    const unmodified = Boolean(lastHash) && sha256Text(destBody!) === lastHash;
    if (bootstrap || unmodified) {
      await writeText(dest, packBody);
      meta.personas[rel] = packHash;
      actions.push({
        target: "orchesto-persona",
        path: dest,
        action: "updated",
        detail: bootstrap ? "bootstrap overwrite" : "unmodified seed",
      });
      continue;
    }

    actions.push({
      target: "orchesto-persona",
      path: dest,
      action: "skipped",
      detail: "local-edits",
    });
  }

  await saveMeta(vaultPath, meta);
  return actions;
}
