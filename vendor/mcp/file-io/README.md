# mcp/file-io

Local filesystem MCP server (stdio, newline JSON-RPC).

## Tools

| Tool | Description |
|------|-------------|
| `list_dir` | List directory entries |
| `read_file` | Read UTF-8 file |
| `write_file` | Write UTF-8 file |
| `stat` | File metadata |

## Env

- `MCP_FILE_ROOT` — if set, all paths must stay under this root

## Run

From the monorepo root:

```bash
MCP_FILE_ROOT=/tmp/sandbox bun ./file-io/server.mjs
```
