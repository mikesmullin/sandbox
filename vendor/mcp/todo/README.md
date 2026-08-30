# mcp/todo

Session checklist MCP server (stdio, newline JSON-RPC).

This is the **TodoWrite / write_todos** family: a session-scoped plan the model
updates as it works. Not the MCP Tasks extension (`tasks/list` / long-running
`tools/call`).

## Tools

| Tool | Description |
|------|-------------|
| `todo_read` | Return the current list (no args) |
| `todo_write` | Full-list replace (default) or `merge: true` by id |

### `todo_write`

```json
{
  "todos": [
    { "content": "Fix auth redirect", "status": "in_progress", "activeForm": "Fixing auth redirect" },
    { "content": "Write tests", "status": "pending" }
  ]
}
```

- Status: `pending | in_progress | completed` (aliases `todo`→pending, `done`→completed)
- Required per item on replace: `content` (`description` / `step` / `subject` / `title` also accepted)
- Optional: `id` (auto-slug if omitted), `activeForm`
- `merge: true` patches by `id` (Cursor-style partial update)
- `plan` / `task_list` accepted as aliases for `todos`

Ids are assigned on write (`fix-auth-redirect`, …). Exactly one `in_progress`
is a convention in the tool description, not a hard error (a note is appended
if more than one).

The list is **in-memory** (lives with the MCP process) unless `MCP_TODO_PATH` is set.

## Env

- `MCP_TODO_PATH` — optional JSON file `{ "todos": [...] }` to persist across restarts

## Run

From the monorepo root:

```bash
bun ./todo/server.mjs
# or persist:
MCP_TODO_PATH=/tmp/todos.json bun ./todo/server.mjs
```

## Angela

Opt-in preset `todo` (`prefix: false` so the model sees `todo_read` / `todo_write`):

```coffee
mcp: ['file-io', 'term-local', 'todo']
```
