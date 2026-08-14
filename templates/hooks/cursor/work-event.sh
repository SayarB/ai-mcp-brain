#!/usr/bin/env bash
# Optional Cursor session hook. Fail-open: never block a chat.
# BRAIN_REPO_ROOT is rewritten at inject time.
set -u
input=$(cat || true)
kind="${1:-session-start}"
repo_root="${BRAIN_REPO_ROOT:-__BRAIN_REPO_ROOT__}"

session=$(printf '%s' "$input" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
  try {
    const j=JSON.parse(s||"{}");
    const id=j.conversation_id||j.session_id||j.conversationId||"";
    process.stdout.write(String(id));
  } catch { process.stdout.write(""); }
});
' 2>/dev/null || true)

if [[ -z "$repo_root" || "$repo_root" == "__BRAIN_REPO_ROOT__" || ! -f "$repo_root/src/cli.ts" ]]; then
  exit 0
fi

cd "$repo_root" || exit 0
npx --yes tsx src/cli.ts work-event --kind "$kind" ${session:+--session "$session"} >/dev/null 2>&1 || true
exit 0
