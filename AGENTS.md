# Agent and contributor guide

Rules for anyone — person or coding agent — changing this repo. Product and install docs live in [README.md](README.md) and [INSTALL.md](INSTALL.md).

## Privacy (public repo) — hard rule

This repo is **public**. No change may reveal anyone's machine, folder layout, identity, or private setup — not the maintainer's, not yours.

**Covers everything that lands in git:** code, comments, docs, templates (`templates/`, `skills/`), examples, tests, fixtures, snapshots, generated and lock files, config samples, `site/`, commit messages, author emails, PR titles and bodies. Every commit in a PR is published, so a leak added and then removed in the same PR still counts.

### Never commit

- **Absolute local paths:** `/Users/<name>/…`, `/home/<name>/…`, `C:\Users\<name>\…`, `/Volumes/<disk>/…`, iCloud or other synced-folder paths, real vault paths.
- **Folder structure:** where you keep code, disk names, worktree or workspace-tool paths and names, real checkout locations.
- **Identity:** OS usernames, real names, personal email addresses, machine or host names.
- **Other work:** employer, client, or other project names; Jira sites, project keys, issue keys; links to private Slack, Notion, Drive, or similar.
- **Infrastructure:** hosting providers you use, VPN or tailnet names, IP addresses, hostnames, ports of personal services.
- **Private content:** real vault notes, preferences, logs, or tool history. Templates ship generic content only — never copy from a live vault into `templates/`.
- **Secrets:** tokens, API keys, `.env` values. Local-only files stay gitignored and unstaged: `config.toml`, `.env`, `.cursor/mcp.json`, `.plans/`, `.audits/`, editor or agent state dirs.

### Use instead

- **Paths:** `~`, `<repo>`, `<vault>`, `<clone>`, `$HOME`, `%USERPROFILE%`, or paths derived at runtime (`os.homedir()`, `git rev-parse`, `import.meta`).
- **Tests:** `mkdtemp` / `os.tmpdir()` directories, or obviously fake values: `/home/user/…`, `me@example.com`, `https://example.atlassian.net`, `PROJ-1`.
- **Commit author:** your GitHub no-reply address (`<id>+<user>@users.noreply.github.com`).
- **Public identifiers that are fine:** this repo's GitHub owner in install and clone URLs, and the docs site domain already in `site/`.

### Check before you commit

```bash
bash scripts/check-privacy.sh            # staged changes + commit author
bash scripts/check-privacy.sh origin/main # every commit on your branch: patch, message, author
bash scripts/check-privacy.sh --all       # every tracked file
```

- `git config core.hooksPath .githooks` runs the staged check as a pre-commit hook.
- CI runs the branch check on every pull request and fails on any hit.
- Add your own identifiers (username, disk names, employer, …) one regex per line to `.git/info/privacy-patterns`. That file stays inside `.git` and is never pushed.
- The script is a floor, not the whole rule. It cannot know names of your projects or tools — read your diff for those too.

### Reviewing a PR

Any privacy hit is a **blocker**, not a nit. Check the CI result, then read the diff, new files, commit messages, author emails, and PR text against the lists above. Flag template content that reads like a copy of someone's real notes. Report each hit with `file:line` and a generic replacement.
