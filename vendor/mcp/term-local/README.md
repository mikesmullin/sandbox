# mcp/term-local

Local process execution MCP server.

## Tools

| Tool | Description |
|------|-------------|
| `bash` | `{ script, cwd?, timeout? }` — just-bash sandbox |
| `exec` | `{ command, args[], cwd?, timeout? }` — no shell |

Stdout and stderr are merged in arrival order. Exit 0 returns the merged
output (or `(no output)`). Non-zero exit / timeout / abort throw with Pi
`appendStatus` text (`Command exited with code N`, etc.). Output is tail-truncated
to 2000 lines / 50KiB; full output spills under `.angela/tmp/` when truncated.

Progress: MCP `notifications/progress` with `{ progressToken, output }`.

## Env

- `MCP_TERM_CWD` — default working directory
- `MCP_TERM_JB_ROOT` — just-bash overlay root
- `MCP_TERM_ALLOW` — comma-separated regexes; if set, command line must match one

## Run

From the monorepo root:

```bash
MCP_TERM_ALLOW='echo,ls,pwd' bun ./term-local/server.mjs
```
