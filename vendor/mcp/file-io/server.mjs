#!/usr/bin/env bun
/**
 * MCP server: local filesystem tools (personal / sandboxed root).
 * Env: MCP_FILE_ROOT — optional absolute root; paths must stay under it when set.
 * Absolute paths (e.g. /tmp/foo) are real host paths and are denied if outside the root.
 */
import { join } from 'node:path';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { runMcpStdioServer, textResult } from '../shared/mcp-stdio.mjs';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from '../shared/truncate.mjs';
import { ROOT, resolveSafe, dirname } from './lib/paths.mjs';
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  prepareEdits,
  restoreLineEndings,
  splitBom,
} from './lib/edit.mjs';
import {
  looksLikeImagePath,
  detectImageMimeType,
  processImageFile,
} from './lib/image.mjs';
import {
  GREP_DEFAULT_LIMIT,
  FIND_DEFAULT_LIMIT,
  runGrep,
  runFind,
} from './lib/search.mjs';

const LIST_DIR_DEFAULT_LIMIT = 500;

const tools = {
  list_dir: {
    description:
      `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. ` +
      `Includes dotfiles. Output is truncated to ${LIST_DIR_DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB ` +
      `(whichever is hit first).`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default .)' },
        limit: {
          type: 'number',
          description: `Maximum number of entries to return (default: ${LIST_DIR_DEFAULT_LIMIT})`,
        },
      },
    },
    async handler({ path: p, limit }) {
      const dir = resolveSafe(p || '.');
      let st;
      try {
        st = await stat(dir);
      } catch {
        throw new Error(`Path not found: ${dir}`);
      }
      if (!st.isDirectory()) throw new Error(`Not a directory: ${dir}`);

      const entries = await readdir(dir);
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const total = entries.length;
      const effectiveLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.floor(Number(limit))
        : LIST_DIR_DEFAULT_LIMIT;

      const results = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        if (results.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        const fullPath = join(dir, entry);
        let suffix = '';
        try {
          const entryStat = await stat(fullPath);
          if (entryStat.isDirectory()) suffix = '/';
        } catch {
          continue;
        }
        results.push(entry + suffix);
      }

      if (results.length === 0) return textResult('(empty)');

      const rawOutput = results.join('\n');
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const notices = [];
      if (entryLimitReached) {
        notices.push(
          `${effectiveLimit} entries limit. ${total} total. Pass limit=${effectiveLimit * 2} for more.`,
        );
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit`);
      }
      if (notices.length) {
        output += `\n\n[Truncated: ${notices.join(' ')}]`;
      }
      return textResult(output);
    },
  },

  read_file: {
    description:
      `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). ` +
      `Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines ` +
      `or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. ` +
      `When you need the full file, continue with offset until complete.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (1-indexed, default 1)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read before the 2000/50KiB cap',
        },
      },
      required: ['path'],
    },
    async handler({ path: p, offset, limit }) {
      if (!p) throw new Error('path required');
      const abs = resolveSafe(p);

      let buf;
      try {
        buf = await readFile(abs);
      } catch (err) {
        throw new Error(err?.message || String(err));
      }

      const sniffed = detectImageMimeType(buf);
      if (looksLikeImagePath(p) || sniffed) {
        const processed = await processImageFile(abs);
        if (!processed) {
          // fall through to text if detection failed
        } else {
          let textNote = `Read image file [${processed.mimeType}]`;
          if (processed.hints?.length) textNote += `\n${processed.hints.join('\n')}`;
          return {
            content: [
              { type: 'text', text: textNote },
              { type: 'image', mimeType: processed.mimeType, data: processed.data },
            ],
          };
        }
      }

      const textContent = buf.toString('utf-8');
      const allLines = textContent.split('\n');
      const totalFileLines = allLines.length;
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        throw new Error(
          `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
        );
      }

      let selectedContent;
      let userLimitedLines;
      if (limit !== undefined && limit !== null && limit !== '') {
        const n = Number(limit);
        const endLine = Math.min(startLine + Math.max(0, n), allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join('\n');
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join('\n');
      }

      const truncation = truncateHead(selectedContent);
      let outputText;
      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], 'utf-8'));
        outputText =
          `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. ` +
          `Use bash: sed -n '${startLineDisplay}p' ${p} | head -c ${DEFAULT_MAX_BYTES}]`;
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        if (truncation.truncatedBy === 'lines') {
          outputText +=
            `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. ` +
            `Use offset=${nextOffset} to continue.]`;
        } else {
          outputText +=
            `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} ` +
            `(${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        }
      } else if (
        userLimitedLines !== undefined &&
        startLine + userLimitedLines < allLines.length
      ) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText =
          `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
      }
      return textResult(outputText);
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
      const body = String(content ?? '');
      await writeFile(abs, body, 'utf8');
      return textResult(`Successfully wrote ${Buffer.byteLength(body, 'utf8')} bytes to ${p}`);
    },
  },

  edit: {
    description:
      'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, ' +
      'non-overlapping region of the original file. If two changes affect the same block or nearby lines, ' +
      'merge them into one edit instead of emitting overlapping edits. Do not include large unchanged ' +
      'regions just to connect distant changes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit' },
        edits: {
          type: 'array',
          description:
            'One or more targeted replacements. Each edit is matched against the original file, not incrementally.',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
            required: ['oldText', 'newText'],
          },
        },
        oldText: { type: 'string', description: 'Legacy single-edit oldText' },
        newText: { type: 'string', description: 'Legacy single-edit newText' },
      },
      required: ['path'],
    },
    async handler(args) {
      const { path: p, edits } = prepareEdits(args);
      if (!p) throw new Error('path required');
      const abs = resolveSafe(p);
      let raw;
      try {
        raw = await readFile(abs, 'utf8');
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
        throw new Error(`Could not edit file: ${p}. ${code ? `Error code: ${code}` : err.message}.`);
      }
      const { bom, text: content } = splitBom(raw);
      const originalEnding = detectLineEnding(content);
      const normalizedContent = normalizeToLF(content);
      const { baseContent, newContent } = applyEditsToNormalizedContent(
        normalizedContent,
        edits,
        p,
      );
      const finalContent = bom + restoreLineEndings(newContent, originalEnding);
      await writeFile(abs, finalContent, 'utf8');
      const diffResult = generateDiffString(baseContent, newContent);
      const patch = generateUnifiedPatch(p, baseContent, newContent);
      const summary = `Successfully replaced ${edits.length} block(s) in ${p}.`;
      const text = diffResult.diff ? `${summary}\n\n${diffResult.diff}` : summary;
      return {
        content: [{ type: 'text', text }],
        _meta: {
          details: {
            diff: diffResult.diff,
            patch,
            firstChangedLine: diffResult.firstChangedLine,
          },
        },
      };
    },
  },

  grep: {
    description:
      `Search file contents for a pattern. Returns matching lines with file paths and line numbers. ` +
      `Respects .gitignore. Includes hidden files. Output is truncated to ${GREP_DEFAULT_LIMIT} matches ` +
      `or 1MB (whichever is hit first). Long lines are truncated to 500 chars.`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex or literal string)' },
        path: { type: 'string', description: 'Directory or file to search (default: .)' },
        glob: { type: 'string', description: "Filter files by glob pattern, e.g. '*.ts'" },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
        literal: {
          type: 'boolean',
          description: 'Treat pattern as literal string instead of regex (default: false)',
        },
        context: {
          type: 'number',
          description: 'Number of lines to show before and after each match (default: 0)',
        },
        limit: {
          type: 'number',
          description: `Maximum number of matches to return (default: ${GREP_DEFAULT_LIMIT})`,
        },
      },
      required: ['pattern'],
    },
    async handler({ pattern, path: p, glob, ignoreCase, literal, context, limit }) {
      if (pattern == null || pattern === '') throw new Error('pattern required');
      const searchAbs = resolveSafe(p || '.');
      let searchIsDir = true;
      try {
        searchIsDir = (await stat(searchAbs)).isDirectory();
      } catch {
        throw new Error(`Path not found: ${searchAbs}`);
      }
      const { text } = await runGrep({
        pattern,
        searchAbs,
        searchIsDir,
        glob,
        ignoreCase,
        literal,
        context,
        limit,
        jailAbs: ROOT || searchAbs,
      });
      return textResult(text);
    },
  },

  find: {
    description:
      `Search for files by glob pattern. Returns matching file paths relative to the search directory. ` +
      `Respects .gitignore. Includes hidden files. Output is truncated to ${FIND_DEFAULT_LIMIT} results or 1MB.`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: "Glob pattern to match files, e.g. '*.ts', '**/*.json'",
        },
        path: { type: 'string', description: 'Directory to search in (default: .)' },
        limit: {
          type: 'number',
          description: `Maximum number of results (default: ${FIND_DEFAULT_LIMIT})`,
        },
      },
      required: ['pattern'],
    },
    async handler({ pattern, path: p, limit }) {
      if (pattern == null || pattern === '') throw new Error('pattern required');
      const searchAbs = resolveSafe(p || '.');
      try {
        const st = await stat(searchAbs);
        if (!st.isDirectory()) throw new Error(`Not a directory: ${searchAbs}`);
      } catch (err) {
        if (String(err.message || err).startsWith('Not a directory')) throw err;
        throw new Error(`Path not found: ${searchAbs}`);
      }
      const { text } = await runFind({
        pattern,
        searchAbs,
        limit,
        jailAbs: ROOT || searchAbs,
      });
      return textResult(text);
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

await runMcpStdioServer({ name: 'file-io', version: '0.1.0', tools });
