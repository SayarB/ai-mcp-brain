#!/usr/bin/env bash
# Optional Cursor session hook. Fail-open: never block a chat.
# BRAIN_REPO_ROOT is rewritten at inject time.
set -u
input=$(cat || true)
kind="${1:-session-start}"
repo_root="${BRAIN_REPO_ROOT:-__BRAIN_REPO_ROOT__}"

parsed=$(printf '%s' "$input" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
  try {
    const j=JSON.parse(s||"{}");
    const id=j.conversation_id||j.session_id||j.conversationId||"";
    const cwd=j.cwd||j.workspace_roots?.[0]||j.workspacePath||"";
    process.stdout.write(String(id).replace(/[\t\r\n]/g,"")+"\t"+String(cwd).replace(/[\t\r\n]/g,""));
  } catch { process.stdout.write("\t"); }
});
' 2>/dev/null || true)

session="${parsed%%$'\t'*}"
cwd="${parsed#*$'\t'}"

if [[ -z "$repo_root" || "$repo_root" == "__BRAIN_REPO_ROOT__" || ! -f "$repo_root/src/cli.ts" ]]; then
  exit 0
fi

run_cli() {
  if command -v bun >/dev/null 2>&1; then
    bun "$repo_root/src/cli.ts" "$@"
  elif [[ -x "$repo_root/node_modules/.bin/tsx" ]]; then
    "$repo_root/node_modules/.bin/tsx" "$repo_root/src/cli.ts" "$@"
  else
    npx --no-install tsx "$repo_root/src/cli.ts" "$@"
  fi
}

run_with_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  else
    "$@"
  fi
}

cd "$repo_root" || exit 0
run_with_timeout 6 run_cli work-event --kind "$kind" ${session:+--session "$session"} >/dev/null 2>&1 || true

# On session-end, passively capture today's own git commit subjects in the background (fail-open)
if [[ "$kind" == "session-end" && "${BRAIN_PASSIVE_CAPTURE:-1}" != "0" ]]; then
  (run_with_timeout 10 run_cli capture --fail-open --app cursor ${session:+--session "$session"} ${cwd:+--cwd "$cwd"} >/dev/null 2>&1 || true) &
fi
exit 0
