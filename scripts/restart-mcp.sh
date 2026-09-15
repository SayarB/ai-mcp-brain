#!/usr/bin/env bash
# Kill running ai-mcp-brain MCP server processes so the editor respawns them
# with the latest code. Also inject Orchesto pack + vault persona sync so a
# push/pull of this repo lands personas in the brain. Inject is fail-open:
# MCP still restarts if inject fails.
# Harnesses often reconnect on the next tool call; if tool schemas still look
# stale, reload the editor window.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATTERN="${ROOT}/src/mcp/server.ts"

# Copy skill pack + safe-sync vault personas. Do not abort MCP restart on failure.
set +e
(
  cd "$ROOT"
  npm run brain -- inject
)
inject_status=$?
set -e
if [[ "${inject_status}" -ne 0 ]]; then
  echo "[restart-mcp] inject failed (status ${inject_status}); continuing to restart MCP" >&2
else
  echo "[restart-mcp] inject ok"
fi

pids="$(pgrep -f "$PATTERN" 2>/dev/null || true)"
if [[ -z "${pids}" ]]; then
  echo "[restart-mcp] no running MCP server matched: ${PATTERN}"
  exit 0
fi

echo "[restart-mcp] stopping PIDs: ${pids}"
# shellcheck disable=SC2086
kill ${pids} 2>/dev/null || true
sleep 0.3
# Force leftover stuck processes
leftover="$(pgrep -f "$PATTERN" 2>/dev/null || true)"
if [[ -n "${leftover}" ]]; then
  echo "[restart-mcp] force-killing: ${leftover}"
  # shellcheck disable=SC2086
  kill -9 ${leftover} 2>/dev/null || true
fi

echo "[restart-mcp] done — editor should respawn MCP on next tool use."
echo "[restart-mcp] if schemas still look old: reload the editor window."
