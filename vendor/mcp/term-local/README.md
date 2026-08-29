# mcp/term-local

Local process execution MCP server. Uses argv spawn (no shell).

## Tools

| Tool | Description |
|------|-------------|
| `exec` | `{ command, args[], cwd? }` — no shell |

## Env

- `MCP_TERM_CWD` — default working directory
- `MCP_TERM_ALLOW` — comma-separated regexes; if set, command line must match one

## Run

From the monorepo root:

```bash
MCP_TERM_ALLOW='echo,ls,pwd' bun ./term-local/server.mjs
```
