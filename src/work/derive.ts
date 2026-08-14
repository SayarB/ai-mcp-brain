import {
  WORK_ABSURD_MS,
  WORK_BUCKET_MS,
  type DerivedBlock,
  type LedgerEvent,
} from "./types.ts";

export type DeriveResult = {
  blocks: DerivedBlock[];
  total_minutes: number;
  active_buckets: number;
  absurd: boolean;
};

function bucketStart(at: number, size: number): number {
  return Math.floor(at / size) * size;
}

function hhmm(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * A session's "key in effect" is the most recent user-supplied key on that
 * session id. Events with no session never inherit a key (avoids misattributing
 * parallel threads when session identity is unknown).
 */
function keyInEffect(
  events: LedgerEvent[],
  upto: number,
  session: string | undefined,
): string | undefined {
  if (!session) return events[upto]?.key;
  let key: string | undefined;
  for (let i = 0; i <= upto; i++) {
    const e = events[i]!;
    if (e.session === session && e.key) key = e.key;
  }
  return events[upto]?.key ?? key;
}

function estimateNote(minutes: number, evidenceCount: number): string {
  if (evidenceCount <= 1 && minutes >= 15) {
    return "sparse — one event earned a full bucket; top up or trim at review";
  }
  if (evidenceCount >= 6 && minutes <= 30) {
    return "dense — lots of events in few buckets; may be under-counted";
  }
  return "looks consistent with recorded activity";
}

/**
 * Activity-bucket derivation. Empty buckets contribute nothing; a bucket with
 * several tasks splits evenly. `session-end` is ignored as a duration source
 * (it still occupies a bucket if present, like any other event).
 */
export function deriveBlocks(
  events: LedgerEvent[],
  opts?: { bucketMs?: number; absurdMs?: number },
): DeriveResult {
  const bucketMs = opts?.bucketMs ?? WORK_BUCKET_MS;
  const absurdMs = opts?.absurdMs ?? WORK_ABSURD_MS;
  const bucketMinutes = bucketMs / 60_000;

  type Occupant = { task: string; evidence: string; at: number };
  const buckets = new Map<number, Occupant[]>();

  const sorted = [...events].sort((a, b) => a.at - b.at);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    // Session boundaries are evidence, not activity. Counting them as work
    // would split the first/last bucket with an unattributed occupant.
    if (e.kind === "session-start" || e.kind === "session-end") continue;
    const key = keyInEffect(sorted, i, e.session);
    const task = key ?? `unattributed:${e.session ?? e.raw}`;
    const start = bucketStart(e.at, bucketMs);
    const list = buckets.get(start) ?? [];
    list.push({ task, evidence: e.raw || e.text, at: e.at });
    buckets.set(start, list);
  }

  type Acc = {
    key?: string;
    minutes: number;
    buckets: number;
    shared: boolean;
    first: number;
    last: number;
    evidence: string[];
  };
  const acc = new Map<string, Acc>();

  for (const [start, occupants] of buckets) {
    const uniqueTasks = [...new Set(occupants.map((o) => o.task))];
    const share = bucketMinutes / uniqueTasks.length;
    const shared = uniqueTasks.length > 1;
    for (const task of uniqueTasks) {
      const mine = occupants.filter((o) => o.task === task);
      const cur = acc.get(task) ?? {
        key: task.startsWith("unattributed:") ? undefined : task,
        minutes: 0,
        buckets: 0,
        shared: false,
        first: mine[0]!.at,
        last: mine[0]!.at,
        evidence: [],
      };
      cur.minutes += share;
      cur.buckets += 1;
      cur.shared = cur.shared || shared;
      cur.first = Math.min(cur.first, start);
      cur.last = Math.max(cur.last, start + bucketMs);
      for (const o of mine) {
        if (o.evidence && !cur.evidence.includes(o.evidence)) {
          cur.evidence.push(o.evidence);
        }
      }
      acc.set(task, cur);
    }
  }

  const blocks: DerivedBlock[] = [...acc.values()]
    .map((a) => ({
      key: a.key,
      minutes: a.minutes,
      buckets: a.buckets,
      shared: a.shared,
      first: hhmm(a.first),
      last: hhmm(a.last),
      evidence: a.evidence,
      estimate_note: estimateNote(a.minutes, a.evidence.length),
    }))
    .sort((a, b) => (a.first < b.first ? -1 : 1));

  const total_minutes = [...buckets.keys()].length * bucketMinutes;
  return {
    blocks,
    total_minutes,
    active_buckets: buckets.size,
    absurd: total_minutes * 60_000 > absurdMs,
  };
}
