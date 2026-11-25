# Projects index

Map a git repo to a vault slug when the folder name is wrong or ambiguous.

Format (one per line):

```
/absolute/path/to/repo → slug
https://github.com/org/repo.git → slug
```

Add your mappings below, **outside** the example code fence (lines inside fenced code blocks are ignored by MCP auto-resolution).

MCP tools resolve this file automatically; when no mapping matches, they fall back to the git root folder name.
