/** Pure merge of Cursor hooks.json — exported for tests. */

export type HooksFile = {
  version?: number;
  hooks?: Record<string, Array<Record<string, unknown>>>;
};

const HOOK_MARKER = "ai-mcp-brain work-event";

export function workEventHookEntries(scriptRel: string): {
  sessionStart: Record<string, unknown>;
  sessionEnd: Record<string, unknown>;
} {
  return {
    sessionStart: {
      command: scriptRel,
      timeout: 8,
    },
    sessionEnd: {
      command: `${scriptRel} session-end`,
      timeout: 8,
    },
  };
}

function isOurs(entry: Record<string, unknown>): boolean {
  const cmd = String(entry.command ?? "");
  return cmd.includes("work-event.sh") || cmd.includes(HOOK_MARKER);
}

export function mergeHooksJson(
  existing: HooksFile,
  scriptRel: string,
): HooksFile {
  const ours = workEventHookEntries(scriptRel);
  const hooks = { ...(existing.hooks ?? {}) };

  const mergeEvent = (name: "sessionStart" | "sessionEnd", entry: Record<string, unknown>) => {
    const list = [...(hooks[name] ?? [])].filter(
      (e) => !isOurs(e as Record<string, unknown>),
    );
    list.push(entry);
    hooks[name] = list;
  };

  mergeEvent("sessionStart", ours.sessionStart);
  mergeEvent("sessionEnd", ours.sessionEnd);

  return { version: existing.version ?? 1, hooks };
}
