import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { localDateString } from "../work/today.ts";
import { toolJiraRelease, toolWorkLog } from "../work/tools.ts";
import type { JiraRuntimeConfig } from "./client.ts";
import {
  adfDoc,
  createVersion,
  fetchMyWorklogsOnDate,
  minutesByKey,
  postWorklog,
  resetJiraFetch,
  setJiraFetch,
  type JiraFetch,
} from "./write.ts";

const cfg: JiraRuntimeConfig = {
  baseUrl: "https://ex.atlassian.net",
  email: "me@ex.com",
  token: "tok",
  defaultJql: "x",
  defaultProject: "AD",
  defaultIssueType: "Task",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): JiraFetch {
  return async (input, init) => handler(String(input), init);
}

afterEach(() => resetJiraFetch());

describe("adfDoc", () => {
  it("is an ADF document, not a string", () => {
    const doc = adfDoc("hello");
    assert.equal(doc.type, "doc");
    assert.equal(doc.version, 1);
    assert.notEqual(typeof doc, "string");
  });
});

describe("postWorklog", () => {
  it("sends ADF comment and timeSpentSeconds", async () => {
    let body: Record<string, unknown> = {};
    setJiraFetch(
      stub(async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return json({ id: "w1" });
      }),
    );
    const r = await postWorklog(cfg, { key: "AD-1", seconds: 900, comment: "hi" });
    assert.equal(r.id, "w1");
    assert.equal(body.timeSpentSeconds, 900);
    const comment = body.comment as { type: string; version: number };
    assert.equal(comment.type, "doc");
    assert.equal(comment.version, 1);
  });
});

describe("createVersion", () => {
  it("uses numeric projectId and released:false", async () => {
    let body: Record<string, unknown> = {};
    setJiraFetch(
      stub(async (url, init) => {
        if (url.includes("/project/AD")) return json({ id: "10042", key: "AD" });
        body = JSON.parse(String(init?.body));
        return json({ id: "v1", name: "R1", released: false, projectId: 10042 });
      }),
    );
    const v = await createVersion(cfg, { name: "R1", projectId: 10042 });
    assert.equal(body.projectId, 10042);
    assert.equal(body.released, false);
    assert.equal(body.releaseDate, undefined);
    assert.equal(v.id, "v1");
  });

  it("explains permission failures", async () => {
    setJiraFetch(
      stub(async () =>
        json(
          {
            errorMessages: [
              "Project with key 'null' either does not exist or you do not have permission to create versions in it.",
            ],
          },
          404,
        ),
      ),
    );
    await assert.rejects(
      () => createVersion(cfg, { name: "R1", projectId: 1 }),
      /Manage Versions|Administer Projects/,
    );
  });
});

function localIso(date: string, hours: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, hours, 0, 0, 0).toISOString();
}

describe("fetchMyWorklogsOnDate", () => {
  const today = localDateString();

  it("keeps only my worklogs started today", async () => {
    setJiraFetch(
      stub(async (url) => {
        if (url.includes("/search/jql")) {
          return json({ issues: [{ key: "AD-206" }] });
        }
        return json({
          worklogs: [
            {
              id: "1",
              timeSpentSeconds: 45 * 60,
              started: localIso(today, 9),
              author: { emailAddress: "me@ex.com" },
              comment: "mine",
            },
            {
              id: "2",
              timeSpentSeconds: 120 * 60,
              started: localIso(today, 10),
              author: { emailAddress: "other@ex.com" },
            },
            {
              id: "3",
              timeSpentSeconds: 60 * 60,
              started: "2020-01-01T10:00:00.000Z",
              author: { emailAddress: "me@ex.com" },
            },
          ],
        });
      }),
    );
    const logs = await fetchMyWorklogsOnDate(cfg, today);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.minutes, 45);
    assert.equal(minutesByKey(logs).get("AD-206"), 45);
  });
});

describe("toolWorkLog review/push vs existing worklogs", () => {
  const today = localDateString();

  async function withJiraEnv<T>(fn: () => Promise<T>): Promise<T> {
    const vault = await mkdtemp(join(tmpdir(), "brain-vault-"));
    const prev = {
      BRAIN_VAULT: process.env.BRAIN_VAULT,
      JIRA_BASE_URL: process.env.JIRA_BASE_URL,
      JIRA_EMAIL: process.env.JIRA_EMAIL,
      JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
    };
    process.env.BRAIN_VAULT = vault;
    process.env.JIRA_BASE_URL = cfg.baseUrl;
    process.env.JIRA_EMAIL = cfg.email;
    process.env.JIRA_API_TOKEN = cfg.token;
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("review flags overlap and push posts only the delta", async () => {
    await withJiraEnv(async () => {
      await toolWorkLog({
        op: "event",
        kind: "note",
        key: "AD-206",
        session: "s",
        text: "work",
        date: today,
        time: "09:00",
      });
      await toolWorkLog({
        op: "event",
        kind: "note",
        key: "AD-206",
        session: "s",
        text: "more",
        date: today,
        time: "10:00",
      });
      await toolWorkLog({
        op: "event",
        kind: "note",
        key: "AD-206",
        session: "s",
        text: "later",
        date: today,
        time: "11:00",
      });
      await toolWorkLog({
        op: "event",
        kind: "note",
        key: "AD-206",
        session: "s",
        text: "end",
        date: today,
        time: "12:00",
      });

      let posts = 0;
      let postedSeconds = 0;
      setJiraFetch(
        stub(async (url, init) => {
          if (url.includes("/search/jql")) return json({ issues: [{ key: "AD-206" }] });
          if (url.includes("/worklog") && (init?.method ?? "GET") === "GET") {
            return json({
              worklogs: [
                {
                  id: "old",
                  timeSpentSeconds: 45 * 60,
                  started: localIso(today, 8),
                  author: { emailAddress: "me@ex.com" },
                },
              ],
            });
          }
          if (url.includes("/worklog") && init?.method === "POST") {
            posts += 1;
            postedSeconds = JSON.parse(String(init.body)).timeSpentSeconds;
            return json({ id: "new" });
          }
          return json({});
        }),
      );

      const review = (await toolWorkLog({ op: "review", date: today, cwd: tmpdir() })) as {
        blocks: Array<{
          key?: string;
          already_logged_minutes: number;
          overlap: boolean;
          minutes: number;
        }>;
      };
      const row = review.blocks.find((b) => b.key === "AD-206");
      assert.ok(row);
      assert.equal(row!.already_logged_minutes, 45);
      assert.equal(row!.overlap, true);

      const requested = Math.max(row!.minutes, 60);
      await toolWorkLog({
        op: "push",
        date: today,
        entries: [{ key: "AD-206", minutes: requested, comment: "eod" }],
      });
      assert.equal(posts, 1);
      assert.equal(postedSeconds, Math.round((requested - 45) * 60));
    });
  });

  it("skips a fully-covered key", async () => {
    await withJiraEnv(async () => {
      let posts = 0;
      setJiraFetch(
        stub(async (url, init) => {
          if (url.includes("/search/jql")) return json({ issues: [{ key: "AD-1" }] });
          if (url.includes("/worklog") && (init?.method ?? "GET") === "GET") {
            return json({
              worklogs: [
                {
                  id: "old",
                  timeSpentSeconds: 45 * 60,
                  started: localIso(today, 8),
                  author: { emailAddress: "me@ex.com" },
                },
              ],
            });
          }
          if (init?.method === "POST") {
            posts += 1;
            return json({ id: "x" });
          }
          return json({});
        }),
      );
      const r = (await toolWorkLog({
        op: "push",
        date: today,
        entries: [{ key: "AD-1", minutes: 30 }],
      })) as { results: Array<{ skipped?: string }> };
      assert.equal(posts, 0);
      assert.equal(r.results[0]!.skipped, "already_logged");
    });
  });

  it("refuses to push when worklog fetch fails", async () => {
    await withJiraEnv(async () => {
      let posts = 0;
      setJiraFetch(
        stub(async (url, init) => {
          if (url.includes("/search/jql")) {
            return json({ errorMessages: ["boom"] }, 500);
          }
          if (init?.method === "POST") {
            posts += 1;
            return json({ id: "x" });
          }
          return json({});
        }),
      );
      await assert.rejects(
        () =>
          toolWorkLog({
            op: "push",
            date: today,
            entries: [{ key: "AD-1", minutes: 15 }],
          }),
        /Refusing to push/,
      );
      assert.equal(posts, 0);
    });
  });

  it("event and review do not write worklogs", async () => {
    await withJiraEnv(async () => {
      let writes = 0;
      setJiraFetch(
        stub(async (url, init) => {
          if (init?.method === "POST" && url.includes("/issue/") && url.includes("/worklog")) {
            writes += 1;
          }
          if (url.includes("/search/jql")) return json({ issues: [] });
          return json({ worklogs: [] });
        }),
      );
      await toolWorkLog({ op: "event", text: "x", date: today });
      await toolWorkLog({ op: "review", date: today, cwd: tmpdir() });
      assert.equal(writes, 0);
    });
  });

  it("push is idempotent via receipts", async () => {
    await withJiraEnv(async () => {
      let posts = 0;
      setJiraFetch(
        stub(async (url, init) => {
          if (url.includes("/search/jql")) return json({ issues: [] });
          if (url.includes("/worklog") && (init?.method ?? "GET") === "GET") {
            return json({ worklogs: [] });
          }
          if (url.includes("/worklog") && init?.method === "POST") {
            posts += 1;
            return json({ id: `w${posts}` });
          }
          return json({});
        }),
      );
      await toolWorkLog({
        op: "push",
        date: today,
        entries: [
          { key: "AD-1", minutes: 15, comment: "a" },
          { key: "AD-2", minutes: 15, comment: "b" },
        ],
      });
      assert.equal(posts, 2);
      await toolWorkLog({
        op: "push",
        date: today,
        entries: [
          { key: "AD-1", minutes: 15, comment: "a" },
          { key: "AD-2", minutes: 15, comment: "b" },
        ],
      });
      assert.equal(posts, 2);
    });
  });

  it("partial push keeps the first receipt", async () => {
    await withJiraEnv(async () => {
      let posts = 0;
      setJiraFetch(
        stub(async (url, init) => {
          if (url.includes("/search/jql")) return json({ issues: [] });
          if (url.includes("/worklog") && (init?.method ?? "GET") === "GET") {
            return json({ worklogs: [] });
          }
          if (url.includes("/worklog") && init?.method === "POST") {
            posts += 1;
            if (posts === 2) return json({ errorMessages: ["nope"] }, 400);
            return json({ id: "w1" });
          }
          return json({});
        }),
      );
      const r = (await toolWorkLog({
        op: "push",
        date: today,
        entries: [
          { key: "AD-1", minutes: 15 },
          { key: "AD-2", minutes: 15 },
        ],
      })) as { results: Array<{ posted?: boolean; worklog_id?: string; error?: string }> };
      assert.equal(r.results[0]!.posted, true);
      assert.equal(r.results[0]!.worklog_id, "w1");
      assert.ok(r.results[1]!.error);
    });
  });

});

describe("toolJiraRelease", () => {
  async function withJiraEnv<T>(fn: () => Promise<T>): Promise<T> {
    const prev = {
      JIRA_BASE_URL: process.env.JIRA_BASE_URL,
      JIRA_EMAIL: process.env.JIRA_EMAIL,
      JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
    };
    process.env.JIRA_BASE_URL = cfg.baseUrl;
    process.env.JIRA_EMAIL = cfg.email;
    process.env.JIRA_API_TOKEN = cfg.token;
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("create requires name and keys before any network", async () => {
    await withJiraEnv(async () => {
      let calls = 0;
      setJiraFetch(
        stub(async () => {
          calls += 1;
          return json({});
        }),
      );
      await assert.rejects(
        () => toolJiraRelease({ op: "create", project: "AD", keys: ["AD-1"] }),
        /explicit version name/,
      );
      await assert.rejects(
        () => toolJiraRelease({ op: "create", project: "AD", name: "R1", keys: [] }),
        /explicit keys/,
      );
      assert.equal(calls, 0);
    });
  });

  it("create is unreleased; stamps only supplied keys; release is separate", async () => {
    await withJiraEnv(async () => {
      const calls: Array<{ url: string; method: string; body?: unknown }> = [];
      setJiraFetch(
        stub(async (url, init) => {
          const method = init?.method ?? "GET";
          const body = init?.body ? JSON.parse(String(init.body)) : undefined;
          calls.push({ url, method, body });
          if (url.includes("/project/AD") && method === "GET") {
            return json({ id: "10042", key: "AD", name: "AD" });
          }
          if (url.endsWith("/version") && method === "POST") {
            return json({ id: "v9", name: "R1", released: false, projectId: 10042 });
          }
          if (url.includes("/issue/") && method === "PUT") return json({});
          if (url.includes("/sprint/") && url.includes("/issue")) {
            return json({
              issues: [
                { key: "AD-1", fields: { summary: "a", status: { name: "Done" } } },
                { key: "AD-2", fields: { summary: "b", status: { name: "In Progress" } } },
                { key: "AD-3", fields: { summary: "c", status: { name: "Done" } } },
                { key: "AD-4", fields: { summary: "d", status: { name: "Done" } } },
                { key: "AD-5", fields: { summary: "e", status: { name: "To Do" } } },
              ],
            });
          }
          if (url.includes("/version/v9") && method === "PUT") {
            return json({ id: "v9", name: "R1", released: true });
          }
          return json({});
        }),
      );

      const preview = (await toolJiraRelease({ op: "preview", sprintId: 7 })) as {
        issues: Array<{ key: string; status: string; selected?: unknown }>;
      };
      assert.equal(preview.issues.length, 5);
      assert.ok(preview.issues.every((i) => i.selected === undefined));

      const created = (await toolJiraRelease({
        op: "create",
        project: "AD",
        name: "R1",
        keys: ["AD-1", "AD-3"],
      })) as {
        version: { id: string; released: boolean; projectId: number };
        stamped: Array<{ key: string; ok: boolean }>;
      };
      assert.equal(created.version.released, false);
      assert.equal(created.version.projectId, 10042);
      assert.equal(created.stamped.length, 2);
      const puts = calls.filter((c) => c.method === "PUT" && c.url.includes("/issue/"));
      assert.equal(puts.length, 2);
      assert.deepEqual(puts[0]!.body, {
        update: { fixVersions: [{ add: { id: "v9" } }] },
      });
      assert.ok(!calls.some((c) => c.method === "PUT" && c.url.includes("/version/")));

      const rel = (await toolJiraRelease({
        op: "release",
        versionId: "v9",
        releaseDate: "2026-08-13",
      })) as { version: { released: boolean } };
      assert.equal(rel.version.released, true);
      const releaseCall = calls.find(
        (c) => c.method === "PUT" && c.url.includes("/version/v9"),
      );
      assert.deepEqual(releaseCall?.body, {
        released: true,
        releaseDate: "2026-08-13",
      });
    });
  });

  it("partial stamp reports per issue", async () => {
    await withJiraEnv(async () => {
      let puts = 0;
      setJiraFetch(
        stub(async (url, init) => {
          if (url.includes("/project/AD")) return json({ id: "1", key: "AD" });
          if (url.endsWith("/version") && (init?.method ?? "") === "POST") {
            return json({ id: "v1", name: "R", released: false });
          }
          if ((init?.method ?? "") === "PUT" && url.includes("/issue/")) {
            puts += 1;
            if (puts === 2) return json({ errorMessages: ["no"] }, 400);
            return json({});
          }
          return json({});
        }),
      );
      const r = (await toolJiraRelease({
        op: "create",
        project: "AD",
        name: "R",
        keys: ["AD-1", "AD-2", "AD-3"],
      })) as { version: { id: string }; stamped: Array<{ key: string; ok: boolean }> };
      assert.equal(r.version.id, "v1");
      assert.equal(r.stamped[0]!.ok, true);
      assert.equal(r.stamped[1]!.ok, false);
      assert.equal(r.stamped[2]!.ok, true);
    });
  });

  it("sprints lists from project boards (uncached)", async () => {
    await withJiraEnv(async () => {
      let boardCalls = 0;
      setJiraFetch(
        stub(async (url) => {
          if (url.includes("/board") && !url.includes("/sprint")) {
            boardCalls += 1;
            return json({ values: [{ id: 3, name: "AD board" }] });
          }
          if (url.includes("/sprint")) {
            return json({
              values: [{ id: 9, name: "Sprint 9", state: "active" }],
            });
          }
          return json({});
        }),
      );
      const a = (await toolJiraRelease({ op: "sprints", project: "AD" })) as {
        sprints: Array<{ id: number; name: string; state: string }>;
      };
      await toolJiraRelease({ op: "sprints", project: "AD" });
      assert.equal(a.sprints[0]!.id, 9);
      assert.equal(a.sprints[0]!.state, "active");
      assert.equal(boardCalls, 2);
    });
  });
});

