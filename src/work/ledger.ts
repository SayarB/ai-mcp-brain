import { join } from "node:path";
import { pathExists, readText, writeText } from "../runtime.ts";
import { ensureWorkDirs, localDateString } from "./today.ts";
import {
  WORK_LOG_DIR_REL,
  WORK_RECEIPTS_HEADING,
  type LedgerEvent,
  type LedgerEventKind,
  type PushReceipt,
} from "./types.ts";

const KINDS: readonly LedgerEventKind[] = [
  "session-start",
  "session-end",
  "note",
  "commit",
  "done",
  "focus",
];

/** `- HH:MM <kind> [s=<session>] [KEY] — <text>` */
const EVENT_RE =
  /^\s*-\s+(\d{2}:\d{2})\s+([a-z-]+)((?:\s+[^\s—]+)*?)\s*(?:—\s*(.*))?$/;

/** Legacy writer format: `- <iso> — <text>`. */
const LEGACY_RE = /^\s*-\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z?)\s*—\s*(.*)$/;

const KEY_RE = /^((?:jira|linear|asana):)?([A-Za-z][A-Za-z0-9]+-\d+)$/;

export function ledgerPath(vault: string, date: string): string {
  return join(vault, WORK_LOG_DIR_REL, `${date}.md`);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function localTimeString(d = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Epoch ms for a `YYYY-MM-DD` + `HH:MM` pair in the local zone. */
export function atFrom(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0).getTime();
}

export function formatEventLine(ev: {
  time: string;
  kind: LedgerEventKind;
  session?: string;
  key?: string;
  text?: string;
}): string {
  const parts = [`- ${ev.time}`, ev.kind];
  if (ev.session?.trim()) parts.push(`s=${ev.session.trim()}`);
  if (ev.key?.trim()) parts.push(ev.key.trim());
  const head = parts.join(" ");
  const text = ev.text?.trim();
  return text ? `${head} — ${text}` : head;
}

/**
 * Strict on write, forgiving on read: unknown or malformed lines are returned
 * as `unparsed` so review can surface them instead of losing them.
 */
export function parseLedger(
  body: string,
  date: string,
): { events: LedgerEvent[]; unparsed: string[]; receipts: PushReceipt[] } {
  const events: LedgerEvent[] = [];
  const unparsed: string[] = [];
  const receipts: PushReceipt[] = [];
  let inReceipts = false;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    if (line.trim().startsWith("#")) {
      inReceipts = line.trim() === WORK_RECEIPTS_HEADING;
      continue;
    }

    if (inReceipts) {
      const r = line.match(
        /^\s*-\s+([A-Z][A-Z0-9]+-\d+)\s+—\s+([\d.]+)m\s+—\s+worklog=(\S+)\s+—\s+(\S+)/,
      );
      if (r) {
        receipts.push({
          key: r[1]!,
          minutes: Number(r[2]),
          worklog_id: r[3]!,
          at: r[4]!,
        });
        continue;
      }
      // Events can still be appended after a push; fall through rather than lose them.
    }

    const legacy = line.match(LEGACY_RE);
    if (legacy) {
      const parsed = Date.parse(legacy[1]!);
      const at = Number.isNaN(parsed) ? atFrom(date, "00:00") : parsed;
      const d = new Date(at);
      events.push({
        at,
        time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
        kind: "note",
        text: legacy[2]!.trim(),
        raw: line,
      });
      continue;
    }

    const m = line.match(EVENT_RE);
    const kind = m?.[2] as LedgerEventKind | undefined;
    if (!m || !kind || !KINDS.includes(kind)) {
      unparsed.push(line);
      continue;
    }

    let session: string | undefined;
    let key: string | undefined;
    for (const token of (m[3] ?? "").trim().split(/\s+/).filter(Boolean)) {
      if (token.startsWith("s=")) {
        session = token.slice(2);
        continue;
      }
      const km = token.match(KEY_RE);
      if (km) key = km[2]!.toUpperCase();
    }

    events.push({
      at: atFrom(date, m[1]!),
      time: m[1]!,
      kind,
      key,
      session,
      text: (m[4] ?? "").trim(),
      raw: line,
    });
  }

  events.sort((a, b) => a.at - b.at);
  return { events, unparsed, receipts };
}

export async function readLedger(
  vault: string,
  date = localDateString(),
): Promise<{
  path: string;
  date: string;
  body: string;
  events: LedgerEvent[];
  unparsed: string[];
  receipts: PushReceipt[];
}> {
  await ensureWorkDirs(vault);
  const path = ledgerPath(vault, date);
  const body = (await pathExists(path)) ? await readText(path) : "";
  return { path, date, body, ...parseLedger(body, date) };
}

/** Append-only: never rewrites existing content. */
export async function appendEvent(
  vault: string,
  ev: {
    kind: LedgerEventKind;
    session?: string;
    key?: string;
    text?: string;
    date?: string;
    time?: string;
  },
): Promise<{ path: string; date: string; line: string }> {
  await ensureWorkDirs(vault);
  const date = ev.date ?? localDateString();
  const time = ev.time ?? localTimeString();
  const path = ledgerPath(vault, date);

  let body = "";
  if (await pathExists(path)) {
    body = await readText(path);
    if (body && !body.endsWith("\n")) body += "\n";
  } else {
    body = `# Work log ${date}\n\n`;
  }

  const line = formatEventLine({ ...ev, time });
  await writeText(path, `${body}${line}\n`);
  return { path, date, line };
}

function formatReceiptLine(r: PushReceipt): string {
  return `- ${r.key} — ${r.minutes}m — worklog=${r.worklog_id} — ${r.at}`;
}

/**
 * Receipts are appended incrementally so a partial push cannot lose the
 * worklogs that already succeeded, and a re-push can skip them.
 */
export async function appendReceipts(
  vault: string,
  date: string,
  receipts: PushReceipt[],
): Promise<string> {
  if (!receipts.length) return ledgerPath(vault, date);
  await ensureWorkDirs(vault);
  const path = ledgerPath(vault, date);

  let body = (await pathExists(path)) ? await readText(path) : `# Work log ${date}\n\n`;
  if (body && !body.endsWith("\n")) body += "\n";
  if (!body.includes(WORK_RECEIPTS_HEADING)) {
    body += `\n${WORK_RECEIPTS_HEADING}\n\n`;
  }

  await writeText(path, body + receipts.map(formatReceiptLine).join("\n") + "\n");
  return path;
}
