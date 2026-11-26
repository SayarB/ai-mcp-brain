#!/usr/bin/env bash
# Optional Claude Code SessionStart / SessionEnd hook for Hem Vault (ai-mcp-brain).
# Fail-open: never blocks a session.
#
# Usage in ~/.claude/settings.json:
#   "hooks": {
#     "SessionStart": [{ "hooks": [{ "type": "command", "command": "/path/to/brain-hook.sh session-start" }] }],
#     "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "/path/to/brain-hook.sh session-end" }] }]
#   }
set -u
input=$(cat || true)
kind="${1:-session-start}"
repo_root="${BRAIN_REPO_ROOT:-__BRAIN_REPO_ROOT__}"

parsed=$(printf '%s' "$input" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
  try {
    const j=JSON.parse(s||"{}");
    const id=j.session_id||j.conversation_id||"";
    const cwd=j.cwd||"";
    process.stdout.write(String(id).replace(/[\t\r\n]/g,"")+"\t"+String(cwd).replace(/[\t\r\n]/g,""));
  } catch { process.stdout.write("\t"); }
});
' 2>/dev/null || true)

session="${parsed%%$'\t'*}"
cwd="${parsed#*$'\t'}"

if [[ -z "$repo_root" || "$repo_root" == "__BRAIN_REPO_ROOT__" || ! -f "$repo_root/src/cli.ts" ]]; then
  exit 0
fi

cd "$repo_root" || exit 0
if [[ "$kind" == "session-start" ]]; then
  # Print compact token-budgeted context briefing for SessionStart injection
  npx --yes tsx src/cli.ts bootstrap --max-chars 3200 ${cwd:+--cwd "$cwd"} 2>/dev/null || true
elif [[ "$kind" == "session-end" && "${BRAIN_PASSIVE_CAPTURE:-1}" != "0" ]]; then
  npx --yes tsx src/cli.ts capture --app claude ${session:+--session "$session"} ${cwd:+--cwd "$cwd"} >/dev/null 2>&1 || true
fi
exit 0
