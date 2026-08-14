import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { parseEnvFile } from "../env.ts";
import { mergeHooksJson } from "../hooks-merge.ts";
import { isCacheFresh } from "./cache.ts";
import { deriveBlocks } from "./derive.ts";
import { commitsToEvents, harvestDayCommits } from "./git.ts";
import {
  appendEvent,
  appendReceipts,
  atFrom,
  formatEventLine,
  parseLedger,
  readLedger,
} from "./ledger.ts";
import { comparePlate } from "./plate.ts";
import {
  localDateString,
  normalizeIssueKey,
  parseTodayMarkdown,
  serializeToday,
} from "./today.ts";
import { jqlForScope, toolWorkLog } from "./tools.ts";
import type { JiraCacheFile, LedgerEvent, LedgerEventKind } from "./types.ts";
import { ALL_ASSIGNED_JIRA_JQL, DEFAULT_JIRA_JQL } from "./types.ts";

describe("normalizeIssueKey", () => {
  it("uppercases and strips provider", () => {
    assert.equal(normalizeIssueKey("ad-206"), "AD-206");
    assert.equal(normalizeIssueKey("jira:ad-206"), "AD-206");
    assert.equal(normalizeIssueKey("hello"), undefined);
  });
});

describe("parseTodayMarkdown", () => {
  it("parses frontmatter date and checklist", () => {
    const raw = `---
date: 2026-08-03
---

# Today

- [ ] AD-206 — remixer
- [x] local chore
- [ ] jira:AD-199 — titles
`;
    const { date, items } = parseTodayMarkdown(raw);
    assert.equal(date, "2026-08-03");
    assert.equal(items.length, 3);
    assert.equal(items[0]!.key, "AD-206");
    assert.equal(items[0]!.note, "remixer");
    assert.equal(items[1]!.done, true);
    assert.equal(items[1]!.key, undefined);
    assert.equal(items[2]!.key, "AD-199");
  });
});

describe("serializeToday", () => {
  it("round-trips keys", () => {
    const md = serializeToday({
      date: "2026-08-04",
      items: [
        {
          done: false,
          key: "AD-1",
          keyRaw: "AD-1",
          note: "x",
          rest: "AD-1 — x",
        },
      ],
    });
    const parsed = parseTodayMarkdown(md);
    assert.equal(parsed.date, "2026-08-04");
    assert.equal(parsed.items[0]!.key, "AD-1");
  });
});

describe("isCacheFresh", () => {
  it("respects TTL", () => {
    const cache: JiraCacheFile = {
      version: 1,
      fetched_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      filter: "x",
      issues: [],
    };
    assert.equal(isCacheFresh(cache), true);
    assert.equal(
      isCacheFresh({
        ...cache,
        fetched_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }),
      false,
    );
  });
});

describe("comparePlate", () => {
  it("splits intersection", () => {
    const r = comparePlate(
      [
        {
          key: "AD-1",
          summary: "a",
          status: "Open",
          url: "u",
          updated: "",
        },
        {
          key: "AD-2",
          summary: "b",
          status: "Open",
          url: "u",
          updated: "",
        },
      ],
      [
        { done: false, key: "AD-1", text: "AD-1", note: undefined },
        { done: false, key: undefined, text: "local", note: "local" },
      ],
    );
    assert.equal(r.counts.on_today, 1);
    assert.equal(r.counts.jira_only, 1);
    assert.equal(r.counts.today_only, 1);
  });
});

describe("parseEnvFile", () => {
  it("parses quotes and skips comments", () => {
    const o = parseEnvFile(`# c
JIRA_EMAIL=a@b.com
JIRA_API_TOKEN="tok en"
EMPTY=
`);
    assert.equal(o.JIRA_EMAIL, "a@b.com");
    assert.equal(o.JIRA_API_TOKEN, "tok en");
  });
});

describe("jqlForScope", () => {
  it("defaults to open sprints", () => {
    assert.equal(
      jqlForScope(undefined, undefined, DEFAULT_JIRA_JQL),
      DEFAULT_JIRA_JQL,
    );
    assert.match(DEFAULT_JIRA_JQL, /openSprints/);
  });
  it("scope=all uses all-assigned JQL", () => {
    assert.equal(
      jqlForScope("all", undefined, DEFAULT_JIRA_JQL),
      ALL_ASSIGNED_JIRA_JQL,
    );
  });
  it("explicit jql wins", () => {
    assert.equal(
      jqlForScope("all", "project = X", DEFAULT_JIRA_JQL),
      "project = X",
    );
  });
  it("legacy all-assigned config still sprint-defaults", () => {
    assert.equal(
      jqlForScope("sprint", undefined, ALL_ASSIGNED_JIRA_JQL),
      DEFAULT_JIRA_JQL,
    );
  });
});

const execFileAsync = promisify(execFile);
const DATE = "2026-08-13";

function ev(
  time: string,
  kind: LedgerEventKind,
  extra: Partial<LedgerEvent> = {},
): LedgerEvent {
  const line = formatEventLine({
    time,
    kind,
    session: extra.session,
    key: extra.key,
    text: extra.text,
  });
  return {
    at: atFrom(DATE, time),
    time,
    kind,
    text: extra.text ?? "",
    raw: line,
    ...extra,
  };
}

describe("ledger grammar", () => {
  it("round-trips every kind with session and key", () => {
    const kinds: LedgerEventKind[] = [
      "session-start",
      "session-end",
      "note",
      "commit",
      "done",
      "focus",
    ];
    for (const kind of kinds) {
      const line = formatEventLine({
        time: "09:15",
        kind,
        session: "abc",
        key: "AD-206",
        text: "hello",
      });
      const { events, unparsed } = parseLedger(`${line}\n`, DATE);
      assert.equal(unparsed.length, 0);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.kind, kind);
      assert.equal(events[0]!.key, "AD-206");
      assert.equal(events[0]!.session, "abc");
      assert.equal(events[0]!.text, "hello");
      assert.equal(events[0]!.time, "09:15");
    }
  });

  it("keeps session ids distinct", () => {
    const a = formatEventLine({ time: "09:00", kind: "note", session: "s1", text: "a" });
    const b = formatEventLine({ time: "09:01", kind: "note", session: "s2", text: "b" });
    const { events } = parseLedger(`${a}\n${b}\n`, DATE);
    assert.equal(events[0]!.session, "s1");
    assert.equal(events[1]!.session, "s2");
  });

  it("parses legacy ISO lines as note with no key", () => {
    const body = `# Work log 2026-08-01\n\n- 2026-08-01T09:00:00.000Z — completed: AD-206\n`;
    const { events, unparsed } = parseLedger(body, "2026-08-01");
    assert.equal(unparsed.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "note");
    assert.equal(events[0]!.key, undefined);
    assert.match(events[0]!.text, /completed: AD-206/);
  });

  it("surfaces unparseable lines", () => {
    const { events, unparsed } = parseLedger("- this is not a log line\n", DATE);
    assert.equal(events.length, 0);
    assert.equal(unparsed.length, 1);
  });
});

describe("deriveBlocks (activity buckets)", () => {
  it("empty buckets contribute nothing (not the span)", () => {
    const r = deriveBlocks([
      ev("09:00", "note", { key: "AD-1", session: "s", text: "a" }),
      ev("09:20", "note", { key: "AD-1", session: "s", text: "b" }),
      ev("15:00", "note", { key: "AD-1", session: "s", text: "c" }),
    ]);
    assert.equal(r.total_minutes, 45);
    assert.equal(r.blocks[0]!.minutes, 45);
  });

  it("long-open session with two bursts and no session-end bills only bursts", () => {
    const r = deriveBlocks([
      ev("09:00", "session-start", { session: "s" }),
      ev("09:00", "note", { key: "AD-1", session: "s", text: "a" }),
      ev("09:10", "note", { key: "AD-1", session: "s", text: "b" }),
      ev("18:00", "note", { key: "AD-1", session: "s", text: "c" }),
    ]);
    assert.equal(r.total_minutes, 30);
    assert.equal(r.blocks.find((b) => b.key === "AD-1")!.minutes, 30);
  });

  it("shared buckets split, never double-count", () => {
    const r = deriveBlocks([
      ev("09:00", "note", { key: "AD-1", session: "s1", text: "a" }),
      ev("09:05", "note", { key: "AD-2", session: "s2", text: "b" }),
    ]);
    assert.equal(r.total_minutes, 15);
    const a = r.blocks.find((b) => b.key === "AD-1")!;
    const b = r.blocks.find((b) => b.key === "AD-2")!;
    assert.equal(a.minutes, 7.5);
    assert.equal(b.minutes, 7.5);
  });

  it("day total equals active buckets × 15", () => {
    const r = deriveBlocks([
      ev("09:00", "note", { key: "AD-1", session: "s1" }),
      ev("09:20", "note", { key: "AD-2", session: "s2" }),
      ev("10:00", "note", { key: "AD-1", session: "s1" }),
    ]);
    assert.equal(r.total_minutes, r.active_buckets * 15);
  });

  it("minimum grain is one bucket", () => {
    const r = deriveBlocks([ev("09:00", "note", { key: "AD-1", session: "s" })]);
    assert.equal(r.total_minutes, 15);
  });

  it("ignores missing session-end (identical totals)", () => {
    const base = [
      ev("09:00", "note", { key: "AD-1", session: "s", text: "a" }),
      ev("09:20", "note", { key: "AD-1", session: "s", text: "b" }),
    ];
    const withEnd = deriveBlocks([
      ...base,
      ev("18:00", "session-end", { session: "s" }),
    ]);
    const without = deriveBlocks(base);
    assert.equal(withEnd.total_minutes, without.total_minutes);
    assert.equal(
      withEnd.blocks.find((b) => b.key === "AD-1")!.minutes,
      without.blocks.find((b) => b.key === "AD-1")!.minutes,
    );
  });

  it("elapsed span is never the duration", () => {
    const r = deriveBlocks([
      ev("09:00", "note", { key: "AD-1", session: "s", text: "1" }),
      ev("11:00", "note", { key: "AD-1", session: "s", text: "2" }),
      ev("14:00", "note", { key: "AD-1", session: "s", text: "3" }),
      ev("18:00", "note", { key: "AD-1", session: "s", text: "4" }),
    ]);
    assert.equal(r.total_minutes, 60);
    assert.notEqual(r.total_minutes, 9 * 60);
  });

  it("never invents a key from note text", () => {
    const r = deriveBlocks([
      ev("09:00", "note", { session: "s", text: "working on AD-206" }),
    ]);
    assert.equal(r.blocks[0]!.key, undefined);
  });

  it("branch-like session-start text does not attribute", () => {
    const r = deriveBlocks([
      ev("09:00", "session-start", {
        session: "s",
        text: "branch=AD-206-foo",
      }),
      ev("09:05", "note", { session: "s", text: "coding" }),
    ]);
    assert.ok(r.blocks.every((b) => b.key === undefined));
  });

  it("no upward scaling", () => {
    const events = Array.from({ length: 13 }, (_, i) =>
      ev(
        `${String(9 + Math.floor(i / 4)).padStart(2, "0")}:${String((i * 15) % 60).padStart(2, "0")}`,
        "note",
        { key: "AD-1", session: "s", text: String(i) },
      ),
    );
    const r = deriveBlocks(events);
    assert.equal(r.total_minutes, r.active_buckets * 15);
    assert.ok(r.total_minutes <= 13 * 15);
    assert.ok(r.total_minutes < 6 * 60);
  });

  it("absurdity guard fires above 12h of active buckets", () => {
    const events: LedgerEvent[] = [];
    for (let h = 0; h < 13; h++) {
      for (let m = 0; m < 60; m += 15) {
        events.push(
          ev(
            `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
            "note",
            { key: "AD-1", session: "s", text: `${h}:${m}` },
          ),
        );
      }
    }
    const r = deriveBlocks(events);
    assert.equal(r.absurd, true);
    assert.ok(r.total_minutes > 12 * 60);
  });

  it("a legitimate 9h day is not absurd", () => {
    const events: LedgerEvent[] = [];
    for (let i = 0; i < 36; i++) {
      const mins = 9 * 60 + i * 15;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      events.push(
        ev(
          `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
          "note",
          { key: "AD-1", session: "s", text: String(i) },
        ),
      );
    }
    const r = deriveBlocks(events);
    assert.equal(r.absurd, false);
    assert.equal(r.total_minutes, 9 * 60);
  });

  it("unattributed blocks carry evidence", () => {
    const r = deriveBlocks([
      ev("09:00", "note", { session: "s", text: "reading docs" }),
    ]);
    assert.equal(r.blocks[0]!.key, undefined);
    assert.ok(r.blocks[0]!.evidence.length >= 1);
  });

  it("estimate_note does not change minutes", () => {
    const r = deriveBlocks([
      ev("09:00", "note", { key: "AD-1", session: "s", text: "x" }),
    ]);
    assert.equal(r.blocks[0]!.minutes, 15);
    assert.ok(r.blocks[0]!.estimate_note);
  });
});

describe("hooks merge", () => {
  it("preserves unrelated afterFileEdit entries", () => {
    const merged = mergeHooksJson(
      {
        version: 1,
        hooks: {
          afterFileEdit: [{ command: "./hooks/format.sh" }],
        },
      },
      "./hooks/work-event.sh",
    );
    assert.equal(merged.hooks!.afterFileEdit![0]!.command, "./hooks/format.sh");
    assert.ok(merged.hooks!.sessionStart?.length);
    assert.ok(merged.hooks!.sessionEnd?.length);
  });
});

describe("git harvest", () => {
  it("picks up the day's commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-git-"));
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
    await writeFile(join(dir, "a.txt"), "a\n");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "one"], { cwd: dir });
    await writeFile(join(dir, "b.txt"), "b\n");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "two"], { cwd: dir });
    const today = localDateString();
    const commits = await harvestDayCommits(dir, today);
    assert.ok(commits.length >= 2);
    const events = commitsToEvents(commits);
    assert.ok(events.every((e) => e.kind === "commit" && !e.key));
  });

  it("degrades cleanly outside a repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-nogit-"));
    const commits = await harvestDayCommits(dir, localDateString());
    assert.deepEqual(commits, []);
  });
});

describe("ledger append-only + receipts", () => {
  it("push appends receipts without rewriting the body", async () => {
    const vault = await mkdtemp(join(tmpdir(), "brain-vault-"));
    await mkdir(join(vault, "work", "log"), { recursive: true });
    const { line } = await appendEvent(vault, {
      kind: "note",
      text: "hello",
      date: DATE,
      time: "09:00",
    });
    const before = (await readLedger(vault, DATE)).body;
    await appendReceipts(vault, DATE, [
      { key: "AD-1", minutes: 15, worklog_id: "100", at: "t" },
    ]);
    const after = (await readLedger(vault, DATE)).body;
    assert.ok(after.startsWith(before.trimEnd()));
    assert.match(after, /## Pushed to Jira/);
    assert.match(after, /worklog=100/);
    assert.match(before, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("CLI work-event", () => {
  it("appends without an MCP server", async () => {
    const vault = await mkdtemp(join(tmpdir(), "brain-vault-"));
    const prev = process.env.BRAIN_VAULT;
    process.env.BRAIN_VAULT = vault;
    try {
      await execFileAsync(
        "npx",
        [
          "tsx",
          "src/cli.ts",
          "work-event",
          "--kind",
          "session-start",
          "--session",
          "abc",
        ],
        { cwd: join(import.meta.dirname, "..", "..") },
      );
      await execFileAsync(
        "npx",
        [
          "tsx",
          "src/cli.ts",
          "work-event",
          "--kind",
          "session-end",
          "--session",
          "abc",
        ],
        { cwd: join(import.meta.dirname, "..", "..") },
      );
      const today = localDateString();
      const { events } = await readLedger(vault, today);
      assert.ok(events.some((e) => e.kind === "session-start" && e.session === "abc"));
      assert.ok(events.some((e) => e.kind === "session-end" && e.session === "abc"));
    } finally {
      if (prev === undefined) delete process.env.BRAIN_VAULT;
      else process.env.BRAIN_VAULT = prev;
    }
  });

  it("exits 0 on an unwritable vault (fail-open)", async () => {
    const prev = process.env.BRAIN_VAULT;
    process.env.BRAIN_VAULT = "/this/path/does/not/exist/and/cannot/be/created/x";
    try {
      const { stderr } = await execFileAsync(
        "npx",
        ["tsx", "src/cli.ts", "work-event", "--kind", "note", "--text", "x"],
        { cwd: join(import.meta.dirname, "..", "..") },
      );
      // cmdWorkEvent swallows errors and sets exitCode 0; execFile succeeds.
      assert.ok(typeof stderr === "string");
    } finally {
      if (prev === undefined) delete process.env.BRAIN_VAULT;
      else process.env.BRAIN_VAULT = prev;
    }
  });
});

describe("toolWorkLog capture", () => {
  it("event does not take a key from text", async () => {
    const vault = await mkdtemp(join(tmpdir(), "brain-vault-"));
    process.env.BRAIN_VAULT = vault;
    const r = await toolWorkLog({
      op: "event",
      kind: "note",
      text: "fixed AD-206 today",
      date: DATE,
    });
    assert.match(String((r as { line: string }).line), /note — fixed AD-206/);
    assert.doesNotMatch(String((r as { line: string }).line), / AD-206 —/);
  });

  it("review derives from harvested commits when the ledger is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-git-"));
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
    await writeFile(join(dir, "a.txt"), "a\n");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "one"], { cwd: dir });
    await writeFile(join(dir, "b.txt"), "b\n");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "two"], { cwd: dir });

    const vault = await mkdtemp(join(tmpdir(), "brain-vault-"));
    const prev = process.env.BRAIN_VAULT;
    process.env.BRAIN_VAULT = vault;
    try {
      const review = (await toolWorkLog({
        op: "review",
        date: localDateString(),
        cwd: dir,
      })) as { blocks: Array<{ evidence: string[] }>; total_minutes: number };
      assert.ok(review.total_minutes >= 15);
      assert.ok(review.blocks.some((b) => b.evidence.some((e) => /one|two/.test(e))));
    } finally {
      if (prev === undefined) delete process.env.BRAIN_VAULT;
      else process.env.BRAIN_VAULT = prev;
    }
  });

  it("review works with no session events (hook-free)", async () => {
    const vault = await mkdtemp(join(tmpdir(), "brain-vault-"));
    const prev = process.env.BRAIN_VAULT;
    process.env.BRAIN_VAULT = vault;
    try {
      await toolWorkLog({
        op: "event",
        kind: "note",
        key: "AD-1",
        text: "solo",
        date: DATE,
        time: "09:00",
      });
      const review = (await toolWorkLog({
        op: "review",
        date: DATE,
        cwd: tmpdir(),
      })) as { blocks: Array<{ key?: string; minutes: number }> };
      assert.equal(review.blocks[0]!.key, "AD-1");
      assert.equal(review.blocks[0]!.minutes, 15);
    } finally {
      if (prev === undefined) delete process.env.BRAIN_VAULT;
      else process.env.BRAIN_VAULT = prev;
    }
  });
});
