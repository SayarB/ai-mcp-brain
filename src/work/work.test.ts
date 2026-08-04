import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  localDateString,
  normalizeIssueKey,
  parseTodayMarkdown,
  serializeToday,
} from "./today.ts";
import { isCacheFresh } from "./cache.ts";
import { comparePlate } from "./plate.ts";
import { parseEnvFile } from "../env.ts";
import type { JiraCacheFile } from "./types.ts";
import { jqlForScope } from "./tools.ts";
import {
  ALL_ASSIGNED_JIRA_JQL,
  DEFAULT_JIRA_JQL,
} from "./types.ts";

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

import { jqlForScope } from "./tools.ts";
import {
  ALL_ASSIGNED_JIRA_JQL,
  DEFAULT_JIRA_JQL,
} from "./types.ts";

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
