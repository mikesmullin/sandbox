#!/usr/bin/env bun
/**
 * MCP server: local filesystem tools (personal / sandboxed root).
 * Env: MCP_FILE_ROOT — optional absolute root; paths must stay under it when set.
 * Absolute paths (e.g. /tmp/foo) are real host paths and are denied if outside the root.
 */
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { runMcpStdioServer, textResult } from '../shared/mcp-stdio.mjs';

const ROOT = process.env.MCP_FILE_ROOT
  ? resolve(process.env.MCP_FILE_ROOT)
  : null;

function resolveSafe(userPath) {
  const raw = String(userPath || '.').trim() || '.';
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(ROOT || process.cwd(), raw);
  if (ROOT) {
    const rel = relative(ROOT, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `That path is outside the allowed sandbox.\n` +
          `  requested: ${raw}\n` +
          `  resolved:  ${abs}\n` +
          `  sandbox:   ${ROOT}\n` +
          `Use a path under the sandbox (relative is fine, e.g. "tmp/poc-test.txt"). ` +
          `Absolute host paths like /tmp/... are not allowed unless they fall under the sandbox directory.`,
      );
    }
  }
  return abs;
}

const tools = {
  list_dir: {
    description: 'List files and directories at path (names + type).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default .)' },
      },
    },
    async handler({ path: p }) {
      const dir = resolveSafe(p || '.');
      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries.map((e) => {
        const kind = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other';
        return `${kind}\t${e.name}`;
      });
      return textResult(lines.join('\n') || '(empty)');
    },
  },

  read_file: {
    description: 'Read a UTF-8 text file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
    async handler({ path: p }) {
      if (!p) throw new Error('path required');
      const abs = resolveSafe(p);
      const data = await readFile(abs, 'utf8');
      return textResult(data);
    },
  },

  write_file: {
    description: 'Write UTF-8 text to a file (creates parent dirs).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async handler({ path: p, content }) {
      if (!p) throw new Error('path required');
      const abs = resolveSafe(p);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, String(content ?? ''), 'utf8');
      return textResult(`wrote ${abs} (${String(content ?? '').length} bytes)`);
    },
  },

  stat: {
    description: 'Stat a path (size, type, mtime).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    async handler({ path: p }) {
      if (!p) throw new Error('path required');
      const abs = resolveSafe(p);
      const s = await stat(abs);
      return textResult(JSON.stringify({
        path: abs,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        size: s.size,
        mtimeMs: s.mtimeMs,
      }, null, 2));
    },
  },
};

await runMcpStdioServer({ name: 'file-io', version: '0.0.1', tools });
