import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathExists, readText, writeText } from "../runtime.ts";
import {
  WORK_CACHE_REL,
  WORK_LOG_DIR_REL,
  WORK_TODAY_REL,
  type TodayItem,
} from "./types.ts";

const CHECK_RE = /^(\s*)-\s*\[([ xX])\]\s+(.*)$/;

/** Local calendar date YYYY-MM-DD in process TZ. */
export function localDateString(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function ensureWorkDirs(vault: string): Promise<void> {
  await mkdir(join(vault, "work", "cache"), { recursive: true });
  await mkdir(join(vault, "work", "log"), { recursive: true });
}

/** Strip optional provider prefix; return KEY or undefined. */
export function normalizeIssueKey(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  let s = raw.trim();
  const pref = s.match(/^(jira|linear|asana):(.+)$/i);
  if (pref) s = pref[2]!.trim();
  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(s)) return s.toUpperCase();
  return undefined;
}

function parseRest(rest: string): Pick<TodayItem, "key" | "keyRaw" | "note" | "rest"> {
  const trimmed = rest.trim();
  // KEY — note | KEY - note | KEY: note | KEY alone
  const m = trimmed.match(
    /^((?:jira|linear|asana):)?([A-Za-z][A-Za-z0-9]+-\d+)\s*(?:[—–\-:]\s*(.*))?$/i,
  );
  if (m) {
    const keyRaw = `${m[1] ?? ""}${m[2]}`;
    const key = normalizeIssueKey(keyRaw);
    return {
      key,
      keyRaw,
      note: (m[3] ?? "").trim(),
      rest: trimmed,
    };
  }
  return { note: trimmed, rest: trimmed };
}

export function parseTodayMarkdown(body: string): {
  date?: string;
  items: TodayItem[];
  preamble: string[];
} {
  const lines = body.split(/\r?\n/);
  let date: string | undefined;
  const preamble: string[] = [];
  const items: TodayItem[] = [];
  let inFront = false;
  let frontDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === 0 && line.trim() === "---") {
      inFront = true;
      preamble.push(line);
      continue;
    }
    if (inFront) {
      preamble.push(line);
      if (line.trim() === "---") {
        inFront = false;
        frontDone = true;
        continue;
      }
      const dm = line.match(/^date:\s*["']?([0-9]{4}-[0-9]{2}-[0-9]{2})["']?\s*$/);
      if (dm) date = dm[1];
      continue;
    }
    const cm = line.match(CHECK_RE);
    if (cm) {
      const done = cm[2]!.toLowerCase() === "x";
      const parsed = parseRest(cm[3] ?? "");
      items.push({ done, ...parsed });
      continue;
    }
    if (!frontDone && !items.length) {
      preamble.push(line);
    } else if (!cm && line.trim() === "" && !items.length) {
      preamble.push(line);
    }
    // trailing non-checklist after items: ignore on rewrite (kept only via serialize)
  }

  return { date, items, preamble };
}

export function serializeToday(opts: {
  date: string;
  items: TodayItem[];
}): string {
  const lines: string[] = [
    "---",
    `date: ${opts.date}`,
    "---",
    "",
    "# Today",
    "",
  ];
  for (const it of opts.items) {
    const mark = it.done ? "x" : " ";
    const label = it.keyRaw || it.key;
    const body = label
      ? it.note
        ? `${label} — ${it.note}`
        : label
      : it.note || it.rest;
    lines.push(`- [${mark}] ${body}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function readTodayFile(vault: string): Promise<{
  path: string;
  date?: string;
  items: TodayItem[];
  raw: string;
}> {
  await ensureWorkDirs(vault);
  const path = join(vault, WORK_TODAY_REL);
  if (!(await pathExists(path))) {
    const date = localDateString();
    const raw = serializeToday({ date, items: [] });
    await writeText(path, raw);
    return { path, date, items: [], raw };
  }
  const raw = await readText(path);
  const { date, items } = parseTodayMarkdown(raw);
  return { path, date, items, raw };
}

export async function writeTodayFile(
  vault: string,
  date: string,
  items: TodayItem[],
): Promise<void> {
  await ensureWorkDirs(vault);
  await writeText(join(vault, WORK_TODAY_REL), serializeToday({ date, items }));
}

export async function appendDayLog(
  vault: string,
  date: string,
  line: string,
): Promise<string> {
  await ensureWorkDirs(vault);
  const path = join(vault, WORK_LOG_DIR_REL, `${date}.md`);
  let body = "";
  if (await pathExists(path)) {
    body = await readText(path);
    if (!body.endsWith("\n")) body += "\n";
  } else {
    body = `# Work log ${date}\n\n`;
  }
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  body += `- ${hh}:${mm} done — ${line.trim()}\n`;
  await writeText(path, body);
  return path;
}

/**
 * If today.md date ≠ local today: move completed into prior day's log,
 * keep open items, stamp new date.
 */
export async function maybeRollover(vault: string): Promise<{
  rolled: boolean;
  from?: string;
  to: string;
  items: TodayItem[];
}> {
  const today = localDateString();
  const file = await readTodayFile(vault);
  if (!file.date || file.date === today) {
    if (!file.date) {
      await writeTodayFile(vault, today, file.items);
      return { rolled: false, to: today, items: file.items };
    }
    return { rolled: false, to: today, items: file.items };
  }

  const prior = file.date;
  const completed = file.items.filter((i) => i.done);
  const open = file.items.filter((i) => !i.done);

  for (const it of completed) {
    const label = it.keyRaw || it.key || it.note || it.rest;
    await appendDayLog(vault, prior, `completed: ${label}`);
  }

  await writeTodayFile(vault, today, open);
  return { rolled: true, from: prior, to: today, items: open };
}

export function compactTodayItems(items: TodayItem[]) {
  return items.map((i) => ({
    done: i.done,
    key: i.key,
    note: i.note || undefined,
    text: i.keyRaw
      ? i.note
        ? `${i.keyRaw} — ${i.note}`
        : i.keyRaw
      : i.note || i.rest,
  }));
}

export async function todayList(vault: string) {
  const { rolled, from, to, items } = await maybeRollover(vault);
  return {
    date: to,
    rolled,
    rolled_from: from,
    open: compactTodayItems(items.filter((i) => !i.done)),
    done: compactTodayItems(items.filter((i) => i.done)),
  };
}

export async function todayAdd(
  vault: string,
  opts: { key?: string; text?: string; note?: string },
) {
  const { to, items } = await maybeRollover(vault);
  const keyRaw = opts.key?.trim();
  const key = normalizeIssueKey(keyRaw) ?? normalizeIssueKey(opts.text);
  const note = (opts.note ?? "").trim();
  let rest: string;
  if (keyRaw || key) {
    const label = keyRaw || key!;
    rest = note ? `${label} — ${note}` : label;
  } else if (opts.text?.trim()) {
    rest = opts.text.trim();
  } else {
    throw new Error("work_today add requires key and/or text");
  }

  const parsed = parseRest(rest);
  if (parsed.key) {
    const dup = items.find(
      (i) => !i.done && i.key && i.key === parsed.key,
    );
    if (dup) {
      return {
        date: to,
        added: false,
        reason: "already_on_today",
        item: compactTodayItems([dup])[0],
        open: compactTodayItems(items.filter((i) => !i.done)),
      };
    }
  }

  const item: TodayItem = {
    done: false,
    key: parsed.key,
    keyRaw: parsed.keyRaw,
    note: parsed.note || note,
    rest: parsed.rest,
  };
  items.push(item);
  await writeTodayFile(vault, to, items);
  return {
    date: to,
    added: true,
    item: compactTodayItems([item])[0],
    open: compactTodayItems(items.filter((i) => !i.done)),
  };
}

export async function todayComplete(
  vault: string,
  opts: { key?: string; text?: string; log?: string },
) {
  const { to, items } = await maybeRollover(vault);
  const wantKey = normalizeIssueKey(opts.key) ?? normalizeIssueKey(opts.text);
  const wantText = (opts.text ?? "").trim().toLowerCase();

  let idx = -1;
  if (wantKey) {
    idx = items.findIndex((i) => !i.done && i.key === wantKey);
  }
  if (idx < 0 && wantText) {
    idx = items.findIndex(
      (i) =>
        !i.done &&
        (i.rest.toLowerCase().includes(wantText) ||
          i.note.toLowerCase().includes(wantText)),
    );
  }
  if (idx < 0) {
    throw new Error(
      `No open today item matched key=${opts.key ?? ""} text=${opts.text ?? ""}`,
    );
  }

  const item = items[idx]!;
  item.done = true;
  await writeTodayFile(vault, to, items);

  const label = item.keyRaw || item.key || item.note || item.rest;
  const logLine = opts.log?.trim() || `completed: ${label}`;
  const logPath = await appendDayLog(vault, to, logLine);

  return {
    date: to,
    completed: compactTodayItems([item])[0],
    log_path: logPath,
    open: compactTodayItems(items.filter((i) => !i.done)),
  };
}
