import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LedgerEvent } from "./types.ts";
import { atFrom } from "./ledger.ts";

const execFileAsync = promisify(execFile);

export type HarvestedCommit = {
  hash: string;
  at: number;
  time: string;
  subject: string;
};

/**
 * Day's commits for `cwd`. Never throws: a missing git / non-repo cwd
 * returns []. Author timestamps, not committer — that's when the work happened.
 */
export async function harvestDayCommits(
  cwd: string,
  date: string,
): Promise<HarvestedCommit[]> {
  const since = `${date} 00:00:00`;
  const until = `${date} 23:59:59`;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "log",
        "--all",
        `--since=${since}`,
        `--until=${until}`,
        "--pretty=format:%H%x09%aI%x09%s",
        "--no-show-signature",
      ],
      { cwd, timeout: 8_000 },
    );
    const out: HarvestedCommit[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [hash, iso, ...rest] = line.split("\t");
      if (!hash || !iso) continue;
      const parsed = Date.parse(iso);
      const at = Number.isNaN(parsed) ? atFrom(date, "00:00") : parsed;
      const d = new Date(at);
      const p = (n: number) => String(n).padStart(2, "0");
      out.push({
        hash,
        at,
        time: `${p(d.getHours())}:${p(d.getMinutes())}`,
        subject: rest.join("\t").trim(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function commitsToEvents(commits: HarvestedCommit[]): LedgerEvent[] {
  return commits.map((c) => ({
    at: c.at,
    time: c.time,
    kind: "commit" as const,
    text: `${c.hash.slice(0, 7)} ${c.subject}`,
    raw: `- ${c.time} commit — ${c.hash.slice(0, 7)} ${c.subject}`,
    // Intentionally no key: never infer from the commit message.
  }));
}

/** Merge harvested commits that aren't already present in the ledger. */
export function mergeCommitEvents(
  existing: LedgerEvent[],
  harvested: LedgerEvent[],
): LedgerEvent[] {
  const seen = new Set(
    existing
      .filter((e) => e.kind === "commit")
      .map((e) => e.text.replace(/\s+/g, " ")),
  );
  const extra = harvested.filter((e) => !seen.has(e.text.replace(/\s+/g, " ")));
  return [...existing, ...extra].sort((a, b) => a.at - b.at);
}

export { atFrom };
