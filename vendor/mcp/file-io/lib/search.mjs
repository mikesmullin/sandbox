/**
 * JS grep / find (Pi output contract, no rg/fd).
 */
import { readFile, stat } from 'node:fs/promises';
import { truncateHead, truncateLine, formatSize, GREP_MAX_LINE_LENGTH } from '../../shared/truncate.mjs';
import { walkFiles, globMatch } from './ignore.mjs';
import { toPosix, relPosix } from './paths.mjs';

export const GREP_DEFAULT_LIMIT = 100;
export const GREP_MAX_BYTES = 1 * 1024 * 1024;
export const FIND_DEFAULT_LIMIT = 1000;
export const FIND_MAX_BYTES = 1 * 1024 * 1024;

const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'zip', 'gz', 'tgz',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'webm', 'ogg', 'wasm',
  'so', 'dylib', 'dll', 'exe', 'bin', 'class', 'o', 'a',
]);

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function compilePattern(pattern, { literal, ignoreCase }) {
  if (literal) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, ignoreCase ? 'i' : '');
  }
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${err.message}`);
  }
}

function formatGrepPath(fileAbs, searchAbs, searchIsDir) {
  if (searchIsDir) {
    const relative = toPosix(relPosix(searchAbs, fileAbs));
    if (relative && !relative.startsWith('..')) return relative;
  }
  return fileAbs.split(/[/\\]/).pop();
}

/**
 * @returns {Promise<{ text: string }>}
 */
export async function runGrep({
  pattern,
  searchAbs,
  searchIsDir,
  glob,
  ignoreCase = false,
  literal = false,
  context = 0,
  limit = GREP_DEFAULT_LIMIT,
  jailAbs,
}) {
  const re = compilePattern(String(pattern), { literal: Boolean(literal), ignoreCase: Boolean(ignoreCase) });
  const contextValue = context && context > 0 ? Number(context) : 0;
  const effectiveLimit = Math.max(1, Number(limit) || GREP_DEFAULT_LIMIT);
  const matches = [];
  let matchLimitReached = false;
  let linesTruncated = false;
  let outputBytes = 0;

  const shouldStop = () => matchLimitReached || outputBytes >= GREP_MAX_BYTES;

  await walkFiles(searchAbs, jailAbs, {
    shouldStop,
    async onFile(abs, rel) {
      if (shouldStop()) return false;
      if (glob && !globMatch(glob, rel)) return;
      if (BINARY_EXTS.has(extOf(rel))) return;
      let content;
      try {
        const st = await stat(abs);
        if (st.size > 5 * 1024 * 1024) return;
        content = await readFile(abs, 'utf8');
      } catch {
        return;
      }
      if (content.includes('\0')) return;
      const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      const relativePath = formatGrepPath(abs, searchAbs, searchIsDir);
      for (let i = 0; i < lines.length; i++) {
        if (shouldStop()) return false;
        if (!re.test(lines[i])) continue;
        matches.push({ relativePath, lineNumber: i + 1, lines });
        matchLimitReached = matches.length >= effectiveLimit;
        if (matchLimitReached) return false;
      }
    },
  });

  if (matches.length === 0) {
    return { text: 'No matches found' };
  }

  const outputLines = [];
  for (const m of matches) {
    const start = contextValue > 0 ? Math.max(1, m.lineNumber - contextValue) : m.lineNumber;
    const end = contextValue > 0 ? Math.min(m.lines.length, m.lineNumber + contextValue) : m.lineNumber;
    for (let current = start; current <= end; current++) {
      const lineText = (m.lines[current - 1] ?? '').replace(/\r/g, '');
      const { text: truncatedText, wasTruncated } = truncateLine(lineText);
      if (wasTruncated) linesTruncated = true;
      const sep = current === m.lineNumber ? ':' : '-';
      const row = `${m.relativePath}${sep}${current}${sep === ':' ? ': ' : '- '}${truncatedText}`;
      outputLines.push(row);
      outputBytes += Buffer.byteLength(row, 'utf-8') + 1;
      if (outputBytes >= GREP_MAX_BYTES) break;
    }
    if (outputBytes >= GREP_MAX_BYTES) break;
  }

  const rawOutput = outputLines.join('\n');
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: GREP_MAX_BYTES });
  let output = truncation.content;
  const notices = [];
  if (matchLimitReached) {
    notices.push(
      `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
    );
  }
  if (truncation.truncated || outputBytes >= GREP_MAX_BYTES) {
    notices.push(`${formatSize(GREP_MAX_BYTES)} limit reached`);
  }
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
  }
  if (notices.length) output += `\n\n[${notices.join('. ')}]`;
  return { text: output };
}

export function relativizeFindResultPath(resultPath, searchPath) {
  const posix = toPosix(relPosix(searchPath, resultPath));
  if (!posix || posix.startsWith('..')) return toPosix(resultPath).split('/').pop();
  return posix;
}

/**
 * @returns {Promise<{ text: string }>}
 */
export async function runFind({ pattern, searchAbs, limit = FIND_DEFAULT_LIMIT, jailAbs }) {
  const effectiveLimit = Math.max(1, Number(limit) || FIND_DEFAULT_LIMIT);
  const results = [];
  let resultLimitReached = false;
  let bytes = 0;

  const shouldStop = () => resultLimitReached || bytes >= FIND_MAX_BYTES;

  await walkFiles(searchAbs, jailAbs, {
    shouldStop,
    async onFile(abs, rel) {
      if (shouldStop()) return false;
      if (!globMatch(pattern, rel) && !globMatch(pattern, abs.split(/[/\\]/).pop())) {
        return;
      }
      const posix = relativizeFindResultPath(abs, searchAbs);
      results.push(posix);
      bytes += Buffer.byteLength(posix, 'utf-8') + 1;
      if (results.length >= effectiveLimit) {
        resultLimitReached = true;
        return false;
      }
      if (bytes >= FIND_MAX_BYTES) return false;
    },
  });

  if (results.length === 0) {
    return { text: 'No files found matching pattern' };
  }

  const rawOutput = results.join('\n');
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: FIND_MAX_BYTES });
  let resultOutput = truncation.content;
  const notices = [];
  if (resultLimitReached) {
    notices.push(
      `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
    );
  }
  if (truncation.truncated || bytes >= FIND_MAX_BYTES) {
    notices.push(`${formatSize(FIND_MAX_BYTES)} limit reached`);
  }
  if (notices.length) resultOutput += `\n\n[${notices.join('. ')}]`;
  return { text: resultOutput };
}
