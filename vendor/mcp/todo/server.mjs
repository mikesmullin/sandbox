#!/usr/bin/env bun
/**
 * MCP server: session checklist (TodoWrite / write_todos family).
 *
 * Tools:
 *   todo_read  — no args; return the current list
 *   todo_write — full-list replace (default) or merge-by-id
 *
 * Status enum: pending | in_progress | completed
 * Item fields: content (required on replace), status, optional id + activeForm
 *
 * Env:
 *   MCP_TODO_PATH — optional JSON file to persist the list
 */
import { runMcpStdioServer, textResult } from '../shared/mcp-stdio.mjs';
import {
  createStore,
  extractList,
  formatTodos,
} from './lib/store.mjs';

export { createStore, formatTodos, extractList } from './lib/store.mjs';

const WRITE_DESCRIPTION = [
  'Replace (default) or merge the session todo list.',
  'Use when the work has 3+ distinct steps, the user gave a list, or they asked for a todo list.',
  'Skip for single-shot Q&A or one trivial step.',
  '',
  'Pass the full list every call unless merge=true.',
  'Each item: content + status (pending | in_progress | completed).',
  'Optional: id, activeForm (present-tense UI label, e.g. "Fixing auth redirect").',
  'Aliases accepted: description/step/subject/title → content; taskId/task_id → id; plan/task_list → todos.',
  '',
  'Conventions:',
  '- Exactly one item in_progress at a time.',
  '- Mark in_progress BEFORE starting that step; mark completed only after the work (and verification) is done.',
  '- Do not batch-complete after the fact; do not jump pending → completed.',
  '- merge=true patches by id (partial update). merge=false (default) replaces the entire list.',
].join('\n');

/**
 * @param {ReturnType<typeof createStore>} [store]
 */
export function createTools(store) {
  const st = store || createStore({ path: process.env.MCP_TODO_PATH || null });

  async function afterWrite() {
    try {
      await st.persist();
    } catch (err) {
      process.stderr.write(`todo: persist failed: ${err.message}\n`);
    }
  }

  return {
    todo_read: {
      description:
        'Read the current session todo list. No arguments. Session-scoped checklist (not a project tracker).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async handler() {
        return textResult(formatTodos(st.list()));
      },
    },

    todo_write: {
      description: WRITE_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description:
              'Todo items. On replace (default) this is the entire list. On merge, only the items to patch/create.',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'Stable id (optional on replace; required to patch an existing item when merge=true).',
                },
                content: {
                  type: 'string',
                  description: 'What to do (imperative). Required on replace; required to create when merging.',
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'pending | in_progress | completed (aliases: todo, done). Default pending.',
                },
                activeForm: {
                  type: 'string',
                  description: 'Present-tense UI label, e.g. "Fixing auth redirect".',
                },
              },
            },
          },
          merge: {
            type: 'boolean',
            description:
              'If true, patch/create by id (partial update). If false/omitted, replace the entire list.',
          },
        },
        required: ['todos'],
      },
      async handler(args) {
        const list = extractList(args);
        if (!list) throw new Error('todos array required (or plan / task_list)');
        const merge = Boolean(args?.merge);
        const next = merge ? st.merge(list) : st.replace(list);
        await afterWrite();
        return textResult(formatTodos(next));
      },
    },
  };
}

export async function startStore(opts = {}) {
  const store = createStore({
    path: opts.path ?? process.env.MCP_TODO_PATH ?? null,
  });
  try {
    await store.load();
  } catch (err) {
    process.stderr.write(`todo: load failed (${store.path}): ${err.message}\n`);
  }
  return store;
}

if (import.meta.main) {
  const store = await startStore();
  await runMcpStdioServer({
    name: 'todo',
    version: '0.1.0',
    tools: createTools(store),
  });
}
