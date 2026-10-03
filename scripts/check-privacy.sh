#!/usr/bin/env bash
# Fail when a change would publish someone's local setup: absolute home or
# disk paths, personal email addresses, private Jira sites, tailnet hosts,
# or IP addresses. This repo is public — see AGENTS.md "Privacy".
#
# Usage:
#   scripts/check-privacy.sh            staged changes + commit author (pre-commit)
#   scripts/check-privacy.sh <base>     each commit in <base>..HEAD: patch, message, author (CI / PR review)
#   scripts/check-privacy.sh --all      every tracked file
#
# Extra local patterns (your username, disk names, employer, …) go one ERE per
# line in .git/info/privacy-patterns. That file lives inside .git and is never
# pushed, so the real values stay off the public repo.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Written so this file never matches its own patterns.
PATTERN='/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|/Volumes/[A-Za-z0-9]|[A-Za-z]:\\+Users\\+[A-Za-z0-9]|Mobile[ ]Documents/|iCloud[~]'
PATTERN+='|@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail)\.(com|me|ch)'
PATTERN+='|[a-z0-9-]+\.atlassian\.net|\.ts\.net'
PATTERN+='|(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}($|[^0-9.])'

# Placeholders and fixtures that are fine to publish.
ALLOW='/home/(user|runner)/|(your-domain|example|ex)\.atlassian\.net|(^|[^0-9.])(127\.0\.0\.1|0\.0\.0\.0)($|[^0-9.])'

LOCAL_PATTERNS_FILE="$(git rev-parse --git-path info/privacy-patterns)"

# Print added lines of a unified diff (read on stdin) as "file:line: text".
added_lines() {
  awk '
    /^\+\+\+ b\// { file = substr($0, 7); next }
    /^\+\+\+ /    { file = ""; next }
    /^@@/         { match($0, /\+[0-9]+/); line = substr($0, RSTART + 1, RLENGTH - 1) + 0; next }
    /^\+/         { print file ":" line ": " substr($0, 2); line++ }
  '
}

# Print matching lines (read on stdin): built-in patterns after blanking
# allowlisted tokens (so one placeholder cannot excuse a real path on the same
# line), plus anything matching the local patterns file.
find_hits() {
  local input hit_numbers
  input="$(cat)"
  hit_numbers="$(printf '%s\n' "$input" | sed -E "s#$ALLOW# #g" | grep -n -i -E -- "$PATTERN" | cut -d: -f1 || true)"
  {
    if [[ -n "$hit_numbers" ]]; then
      printf '%s\n' "$input" | awk 'NR == FNR { want[$1] = 1; next } want[FNR]' <(printf '%s\n' "$hit_numbers") -
    fi
    if [[ -s "$LOCAL_PATTERNS_FILE" ]]; then
      local patterns
      patterns="$(grep -v -E '^[[:space:]]*(#|$)' "$LOCAL_PATTERNS_FILE" || true)"
      if [[ -n "$patterns" ]]; then
        printf '%s\n' "$input" | grep -i -E -f <(printf '%s\n' "$patterns") || true
      fi
    fi
  } | sort -u
}

mode="${1:-}"
case "$mode" in
  "")
    report="$(
      git diff --cached -U0 --no-color | added_lines
      echo "commit author: $(git var GIT_AUTHOR_IDENT)"
    )"
    ;;
  --all)
    report="$(git grep -n -I -e '' -- .)"
    ;;
  *)
    report="$(
      # Patch of every commit, not the net diff: each commit is published, so
      # a path added then removed in the same PR still leaks.
      git log -p -U0 --no-color --format= "$mode..HEAD" | added_lines
      git log --format='commit %h author: %an <%ae>%ncommit %h committer: %cn <%ce>' "$mode..HEAD"
      git log --format='%B' "$mode..HEAD" | sed 's/^/commit message: /'
    )"
    ;;
esac

hits="$(printf '%s\n' "$report" | find_hits)"
if [[ -z "$hits" ]]; then
  echo "check-privacy: clean"
  exit 0
fi

echo "check-privacy: possible personal info (this repo is public — see AGENTS.md \"Privacy\"):" >&2
printf '%s\n' "$hits" | sed 's/^/  /' >&2
echo "Replace with placeholders (~, <repo>, <vault>), runtime-derived paths, or fake fixtures." >&2
echo "Commit author: use your GitHub no-reply address (git config user.email <id>+<user>@users.noreply.github.com)." >&2
exit 1
