# Projects index

Map a git repo to a vault slug when the folder name is wrong or ambiguous.

Format (one per line):

```
/absolute/path/to/repo → slug
https://github.com/org/repo.git → slug
```

Agents: check this file first; else use the git root folder name as `slug`.
