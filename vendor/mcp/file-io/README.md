# mcp/file-io

Local filesystem MCP server (stdio, newline JSON-RPC).

## Tools

| Tool | Description |
|------|-------------|
| `list_dir` | List directory entries (dirs get `/`, default cap 500 / 50KiB) |
| `read_file` | Read UTF-8 file (offset/limit pagination) or attach images |
| `write_file` | Write UTF-8 file (creates parent dirs) |
| `edit` | Exact unique non-overlapping text replacements |
| `grep` | JS content search (gitignore, hidden, glob, context, cap 100 / 1MB) |
| `find` | JS glob file search (gitignore, hidden, cap 1000 / 1MB) |
| `stat` | File metadata |

## Env

- `MCP_FILE_ROOT` — if set, all paths must stay under this root

## Run

From the monorepo root:

```bash
MCP_FILE_ROOT=/tmp/sandbox bun ./file-io/server.mjs
```
