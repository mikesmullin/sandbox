#!/usr/bin/env bun

import { constants } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { access, mkdir, open as fsOpen, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as osConstants, homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePathPosix } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'execd', version: '0.2.0' };
const DEFAULT_GUEST_PORT = 3213;
const DEFAULT_CWD = '/home/desktop';

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000; // 2147483.647

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const MAX_BODY_BYTES = 1024 * 1024;


function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function jsonResponse(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}



function splitLinesForCounting(content) {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}


function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}


function truncateHead(content, { maxLines = MAX_LINES, maxBytes = MAX_BYTES } = {}) {
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content, truncated: false, truncatedBy: null, totalLines, totalBytes,
      outputLines: totalLines, outputBytes: totalBytes, firstLineExceedsLimit: false,
    };
  }
  const firstLineBytes = Buffer.byteLength(lines[0], 'utf-8');
  if (firstLineBytes > maxBytes) {
    return {
      content: '', truncated: true, truncatedBy: 'bytes', totalLines, totalBytes,
      outputLines: 0, outputBytes: 0, firstLineExceedsLimit: true,
    };
  }
  const outputLinesArr = [];
  let outputBytesCount = 0;
  let truncatedBy = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (i > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) truncatedBy = 'lines';
  const outputContent = outputLinesArr.join('\n');
  return {
    content: outputContent, truncated: true, truncatedBy, totalLines, totalBytes,
    outputLines: outputLinesArr.length, outputBytes: Buffer.byteLength(outputContent, 'utf-8'),
    firstLineExceedsLimit: false,
  };
}


const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = '\u202F';


function resolveToCwd(filePath, cwd) {
  let normalized = filePath.replace(UNICODE_SPACES, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  const home = homedir();
  if (normalized === '~') return home;
  if (normalized.startsWith('~/')) normalized = join(home, normalized.slice(2));
  if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  return isAbsolute(normalized) ? resolvePathPosix(normalized) : resolvePathPosix(cwd, normalized);
}

async function pathExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function tryMacOSScreenshotPath(filePath) {
  return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}
function tryNFDVariant(filePath) {
  return filePath.normalize('NFD');
}
function tryCurlyQuoteVariant(filePath) {
  return filePath.replace(/'/g, '\u2019');
}


async function resolveReadPath(filePath, cwd) {
  const resolved = resolveToCwd(filePath, cwd);
  if (await pathExists(resolved)) return resolved;
  const amPmVariant = tryMacOSScreenshotPath(resolved);
  if (amPmVariant !== resolved && (await pathExists(amPmVariant))) return amPmVariant;
  const nfdVariant = tryNFDVariant(resolved);
  if (nfdVariant !== resolved && (await pathExists(nfdVariant))) return nfdVariant;
  const curlyVariant = tryCurlyQuoteVariant(resolved);
  if (curlyVariant !== resolved && (await pathExists(curlyVariant))) return curlyVariant;
  const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
  if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) return nfdCurlyVariant;
  return resolved;
}



function detectImageMimeType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.subarray(0, 6).toString('latin1') === 'GIF87a' || buffer.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp';
  return null;
}


function truncateMiddle(content, maxBytes) {
  const buf = Buffer.from(content, 'utf8');
  if (buf.length <= maxBytes) return { content, removedChars: 0 };
  const isBoundary = (index) => index >= buf.length || (buf[index] & 0xc0) !== 0x80;
  let headEnd = Math.floor(maxBytes / 2);
  while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
  let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
  while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
  const head = buf.subarray(0, headEnd).toString('utf8');
  const tail = buf.subarray(tailStart).toString('utf8');
  const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString('utf8')).length;
  return { content: `${head}…${removedChars} chars truncated…${tail}`, removedChars };
}



class OutputAccumulator {
  constructor({ tempFilePrefix, tempDir, maxLines = MAX_LINES, maxBytes = MAX_BYTES }) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.tempFilePrefix = tempFilePrefix;
    this.tempDir = tempDir;
    this.decoder = new TextDecoder();
    this.rawChunks = [];
    this.tailText = '';
    this.tailStartsAtLineBoundary = true;
    this.totalRawBytes = 0;
    this.totalDecodedBytes = 0;
    this.completedLines = 0;
    this.currentLineBytes = 0;
    this.hasOpenLine = false;
    this.droppedHeadChars = 0;
    this.finished = false;
    this.tempFilePath = null;
    this.tempFileStream = null;
  }

  append(data) {
    if (this.finished) return;
    this.totalRawBytes += data.length;
    this.appendDecoded(this.decoder.decode(data, { stream: true }));
    if (this.tempFileStream || this.shouldUseTempFile()) this.ensureTempFile();
    if (this.tempFileStream) this.tempFileStream.write(data);
    else if (data.length > 0) this.rawChunks.push(data);
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.appendDecoded(this.decoder.decode());
    if (this.shouldUseTempFile()) this.ensureTempFile();
  }

  appendDecoded(text) {
    if (!text) return;
    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    if (byteLength(this.tailText) > this.maxRollingBytes * 2) this.trimTail();
    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
  }


  trimTail() {
    const buffer = Buffer.from(this.tailText, 'utf8');
    if (buffer.length <= this.maxRollingBytes) return;
    let start = buffer.length - this.maxRollingBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
    const nextTail = buffer.subarray(start).toString('utf8');
    this.droppedHeadChars += this.tailText.length - nextTail.length;
    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = nextTail;
  }

  get totalLines() {
    return this.completedLines + (this.hasOpenLine ? 1 : 0);
  }


  snapshotText() {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf('\n');
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }


  truncated() {
    return this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
  }

  shouldUseTempFile() {
    return this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes
      || this.totalLines > this.maxLines;
  }

  ensureTempFile() {
    if (this.tempFilePath) return;
    this.tempFilePath = `${this.tempDir}/${this.tempFilePrefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.txt`;
    this.tempFileStream = createWriteStream(this.tempFilePath, { flags: 'w' });
    this.tempFileStream.on('error', () => {});
    for (const chunk of this.rawChunks) this.tempFileStream.write(chunk);
    this.rawChunks = [];
  }

  closeTempFile() {
    if (!this.tempFileStream) return Promise.resolve();
    const stream = this.tempFileStream;
    this.tempFileStream = null;
    return new Promise((resolve) => {
      stream.once('error', () => resolve());
      stream.once('finish', () => resolve());
      stream.end();
    });
  }


  async readFullOutput(maxBytes) {
    if (!this.tempFilePath) {
      return { content: Buffer.concat(this.rawChunks).toString('utf8'), truncated: false };
    }
    const file = await fsOpen(this.tempFilePath, 'r');
    try {
      const size = (await file.stat()).size;
      if (size <= maxBytes) {
        return { content: await file.readFile({ encoding: 'utf8' }), truncated: false };
      }
      const headBytes = Math.floor(maxBytes / 2);
      const tailBytes = maxBytes - headBytes;
      const head = Buffer.alloc(headBytes);
      const tail = Buffer.alloc(tailBytes);
      await file.read(head, 0, headBytes, 0);
      await file.read(tail, 0, tailBytes, size - tailBytes);
      const headText = new TextDecoder().decode(head, { stream: true });
      let tailStart = 0;
      while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
      const tailText = new TextDecoder().decode(tail.subarray(tailStart));
      const omitted = size - headBytes - tailBytes;
      return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
    } finally {
      await file.close();
    }
  }
}

/**
 * Bounded display view (contract: last 2000 lines / 50KB, head+tail with a
 * `…N chars truncated…` elision marker). Line overflow keeps the LAST
 * MAX_LINES lines and marks the dropped head with the elision marker; byte
 * overflow is pi truncateMiddle (head+tail halves around the same marker).
 */
function buildView(acc) {
  const snap = acc.snapshotText();
  if (!acc.truncated()) return { content: snap, truncated: false };
  const lines = splitLinesForCounting(snap);
  let text = snap;
  let prefix = '';
  if (acc.totalLines > acc.maxLines && lines.length > acc.maxLines) {
    const dropped = lines.slice(0, lines.length - acc.maxLines);
    const droppedText = dropped.join('\n') + '\n';
    prefix = `…${droppedText.length + acc.droppedHeadChars} chars truncated…\n`;
    text = lines.slice(lines.length - acc.maxLines).join('\n');
  } else if (acc.droppedHeadChars > 0) {
    prefix = `…${acc.droppedHeadChars} chars truncated…\n`;
  }
  const mid = truncateMiddle(text, acc.maxBytes);
  const content = mid.content === text ? text : mid.content;
  return { content: prefix + content, truncated: true };
}


const EXIT_STDIO_GRACE_MS = 100;


function waitForChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    let exited = false;
    let code = null;
    let signal = null;
    let spawnError = null;
    let postExitTimer;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
    };
    const finalize = () => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, signal, spawnError });
    };
    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize();
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(finalize, EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => { stdoutEnded = true; maybeFinalizeAfterExit(); };
    const onStderrEnd = () => { stderrEnded = true; maybeFinalizeAfterExit(); };
    const onError = (err) => { spawnError = err; };

    child.stdout?.once('end', onStdoutEnd);
    child.stderr?.once('end', onStderrEnd);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', onError);
    child.once('exit', (c, s) => {
      exited = true;
      code = c;
      signal = s;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    });
    child.once('close', () => finalize());
  });
}


function killProcessGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
}


const BASH_TOOL = {
  name: 'bash',
  description: 'Execute a bash command inside the sandbox (one-shot: each call is independent). '
    + 'Returns combined stdout and stderr. Output is truncated to the last 2000 lines or 50KB '
    + '(whichever is hit first) with a full copy saved to a guest temp file when truncated. '
    + 'Optionally provide a timeout in seconds (no default).',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in seconds (optional, no default timeout)' },
      cwd: { type: 'string', description: `Working directory (default: /home/desktop)` },
    },
    required: ['command'],
  },
};

function toolResult(text, structured, isError, extraContent) {
  const result = { content: [...(extraContent ?? []), { type: 'text', text }], structuredContent: structured, isError };
  if (structured === null || structured === undefined) delete result.structuredContent;
  return result;
}


function resolveCwd(args) {
  return args.cwd ?? (process.env.EXECD_DEFAULT_CWD || homedir() || DEFAULT_CWD);
}


function validateBashArgs(args) {
  if (typeof args.command !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "command" is required and must be a string' };
  }
  if (args.cwd !== undefined && typeof args.cwd !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "cwd" must be a string' };
  }
  if (args.timeout !== undefined) {
    if (typeof args.timeout !== 'number' || !Number.isFinite(args.timeout) || args.timeout <= 0) {
      return { code: INVALID_PARAMS, message: 'Invalid timeout: must be a finite number of seconds' };
    }
    if (args.timeout * 1000 > MAX_TIMEOUT_MS) {
      return { code: INVALID_PARAMS, message: `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds` };
    }
  }
  return { args: { command: args.command, timeout: args.timeout, cwd: args.cwd } };
}


const BASE_TOOL_REGISTRY = {
  bash: { validate: validateBashArgs, run: (args, trackChild) => runBash(args, trackChild) },
  read: { validate: validateReadArgs, run: (args) => runRead(args) },
  write: { validate: validateWriteArgs, run: (args) => runWrite(args) },
};


function validateToolCallParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { code: INVALID_PARAMS, message: 'Invalid params: params must be an object' };
  }
  const { name, arguments: rawArgs } = params;
  if (typeof name !== 'string' || name.length === 0) {
    return { code: INVALID_PARAMS, message: 'Invalid params: missing tool name' };
  }
  const tool = TOOL_REGISTRY[name];
  if (!tool) return { unknownTool: name };
  const args = rawArgs === undefined ? {} : rawArgs;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { code: INVALID_PARAMS, message: 'Invalid params: arguments must be an object' };
  }
  const checked = tool.validate(args);
  if (checked.code) return checked;
  return { name, args: checked.args };
}


async function runBash(args, trackChild) {
  const cwd = resolveCwd(args);
  try {
    await access(cwd, constants.F_OK);
  } catch {
    return { isError: true, text: `Working directory does not exist: ${cwd}\nCannot execute bash commands.` };
  }

  const startedAt = performance.now();
  const acc = new OutputAccumulator({ tempFilePrefix: 'execd-output', tempDir: process.env.EXECD_TMPDIR || '/tmp' });
  let timedOut = false;
  let timeoutHandle;
  const child = spawn('bash', ['-c', args.command], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid) trackChild(child.pid);
  const onData = (data) => acc.append(data);
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  if (args.timeout !== undefined) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessGroup(child.pid);
    }, args.timeout * 1000);
  }

  const exit = await waitForChild(child);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (child.pid) trackChild(child.pid, { remove: true });
  acc.finish();
  const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;

  if (exit.spawnError && exit.code === null && !exit.signal) {
    return {
      isError: true,
      text: `Failed to spawn bash: ${exit.spawnError.message}`,
      structured: {
        output: '', truncated: false, exit_code: 1, wall_time_seconds: wallTimeSeconds,
      },
    };
  }

  await acc.closeTempFile();
  const exitCode = exit.code ?? (exit.signal ? 128 + (osConstants.signals[exit.signal] ?? 0) : 1);

  const view = buildView(acc);
  let text = view.content || '(no output)';
  if (view.truncated && acc.tempFilePath) text += `\n\n[Full output: ${acc.tempFilePath}]`;
  if (timedOut) text += `\n\nCommand timed out after ${args.timeout} seconds`;
  else if (exitCode !== 0) text += `\n\nCommand exited with code ${exitCode}`;

  const full = await acc.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
  const structured = {
    output: full.content,
    truncated: view.truncated,
    ...(view.truncated && acc.tempFilePath ? { full_output_path: acc.tempFilePath } : {}),
    exit_code: exitCode,
    wall_time_seconds: wallTimeSeconds,
  };
  return { isError: timedOut || exitCode !== 0, text, structured };
}


const READ_TOOL = {
  name: 'read',
  description: 'Read the contents of a file. Supports text files; images are detected but not previewed '
    + 'by execd read v0. Output is truncated to 2000 lines or 50KB (whichever is hit first). '
    + 'Use offset/limit for large files. When you need the full file, continue with offset until complete.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to read (relative or absolute)' },
      offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
      limit: { type: 'number', description: 'Maximum number of lines to read' },
    },
    required: ['path'],
  },
};


async function runRead(args) {
  const cwd = resolveCwd({});
  const absolutePath = await resolveReadPath(args.path, cwd);
  try {
    await access(absolutePath, constants.R_OK);
    const buffer = await readFile(absolutePath);
    const size = buffer.length;
    const mimeType = detectImageMimeType(buffer);
    if (mimeType) {
      return {
        isError: false,
        text: `Read image file [${mimeType}] — binary image preview not supported by execd read v0 `
          + `(${size} bytes). Use bash (e.g. base64/file) if you need its bytes.`,
        structured: { path: absolutePath, total_lines: 0, truncated: false, size_bytes: size },
      };
    }
    const textContent = buffer.toString('utf-8');
    const allLines = textContent.split('\n');
    const totalFileLines = allLines.length;
    const startLine = args.offset ? Math.max(0, args.offset - 1) : 0;
    const startLineDisplay = startLine + 1;
    if (startLine >= allLines.length) {
      return { isError: true, text: `Offset ${args.offset} is beyond end of file (${allLines.length} lines total)` };
    }
    let selectedContent;
    let userLimitedLines;
    if (args.limit !== undefined) {
      const endLine = Math.min(startLine + args.limit, allLines.length);
      selectedContent = allLines.slice(startLine, endLine).join('\n');
      userLimitedLines = endLine - startLine;
    } else {
      selectedContent = allLines.slice(startLine).join('\n');
    }
    const truncation = truncateHead(selectedContent);
    let outputText;
    if (truncation.firstLineExceedsLimit) {
      const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], 'utf-8'));
      outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(MAX_BYTES)} limit. `
        + `Use bash: sed -n '${startLineDisplay}p' ${args.path} | head -c ${MAX_BYTES}]`;
    } else if (truncation.truncated) {
      const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
      const nextOffset = endLineDisplay + 1;
      outputText = truncation.content;
      if (truncation.truncatedBy === 'lines') {
        outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. `
          + `Use offset=${nextOffset} to continue.]`;
      } else {
        outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} `
          + `(${formatSize(MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
      }
    } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
      const remaining = allLines.length - (startLine + userLimitedLines);
      const nextOffset = startLine + userLimitedLines + 1;
      outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText = truncation.content;
    }
    return {
      isError: false,
      text: outputText,
      structured: { path: absolutePath, total_lines: totalFileLines, truncated: truncation.truncated, size_bytes: size },
    };
  } catch (err) {
    return { isError: true, text: String(err?.message ?? err) };
  }
}


function validateReadArgs(args) {
  if (typeof args.path !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "path" is required and must be a string' };
  }
  if (args.offset !== undefined && typeof args.offset !== 'number') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "offset" must be a number' };
  }
  if (args.limit !== undefined && typeof args.limit !== 'number') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "limit" must be a number' };
  }
  return { args: { path: args.path, offset: args.offset, limit: args.limit } };
}


const WRITE_TOOL = {
  name: 'write',
  description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. "
    + 'Automatically creates parent directories.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write (relative or absolute)' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['path', 'content'],
  },
};


const fileMutationQueues = new Map();
let registrationQueue = Promise.resolve();

function isMissingPathError(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}


async function getMutationQueueKey(filePath) {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return filePath;
    throw error;
  }
}


async function withFileMutationQueue(filePath, fn) {
  const registration = registrationQueue.then(async () => {
    const key = await getMutationQueueKey(filePath);
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
    let releaseNext;
    const nextQueue = new Promise((resolveQueue) => { releaseNext = resolveQueue; });
    const chainedQueue = currentQueue.then(() => nextQueue);
    fileMutationQueues.set(key, chainedQueue);
    return { key, currentQueue, chainedQueue, releaseNext };
  });
  registrationQueue = registration.then(() => undefined, () => undefined);
  const { key, currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) fileMutationQueues.delete(key);
  }
}


async function runWrite(args) {
  const cwd = resolveCwd({});
  const absolutePath = resolveToCwd(args.path, cwd);
  const dir = dirname(absolutePath);
  return withFileMutationQueue(absolutePath, async () => {
    const createdDirs = await mkdir(dir, { recursive: true });
    await writeFile(absolutePath, args.content, 'utf-8');
    return {
      isError: false,
      text: `Successfully wrote to ${args.path}`,
      structured: {
        path: absolutePath,
        bytes_written: Buffer.byteLength(args.content, 'utf-8'),
        created_dirs: createdDirs !== undefined,
      },
    };
  }).catch((err) => ({ isError: true, text: String(err?.message ?? err) }));
}


function validateWriteArgs(args) {
  if (typeof args.path !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "path" is required and must be a string' };
  }
  if (typeof args.content !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "content" is required and must be a string' };
  }
  return { args: { path: args.path, content: args.content } };
}


const BROWSER_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.CUA_BROWSER_TOOLS ?? '').trim());
const BROWSER_SESSION = 'agent';
const SPACESD_URL = process.env.CUA_SPACESD_URL || 'http://127.0.0.1:3211/mcp';
const SPACESD_TOKEN = process.env.CUA_ENV_TOKEN ?? '';
const BROWSER_REQUEST_TIMEOUT_MS = 180000;

const browserState = {
  targetId: null, tabId: null, pid: null, windowId: null, url: null,
  recording: null,
};

async function ensureBrowserLease() {
  if (browserLease) return browserLease;
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'authorization': `Bearer ${SPACESD_TOKEN}`,
  };
  const init = await fetch(SPACESD_URL, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'execd' } },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!init.ok) throw new Error(`spacesd initialize failed (HTTP ${init.status})`);
  const sessionId = init.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('spacesd did not issue an mcp-session-id — cannot keep a browser lease');
  browserLease = { sessionId };
  try {
    await fetch(SPACESD_URL, {
      method: 'POST', headers: { ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { }
  return browserLease;
}

let browserLease = null;
let browserSessionActive = false;
const browserQueue = { tail: Promise.resolve() };

function enqueueBrowser(fn) {
  const run = browserQueue.tail.then(fn);
  browserQueue.tail = run.then(() => undefined, () => undefined);
  return run;
}

function pickSpacesdText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  const t = result.content.find(c => c && c.type === 'text');
  return t?.text ?? '';
}

function isSessionEndedRefusal(res) {
  return res?.structuredContent?.refusal?.code === 'session_ended';
}

async function callSpacesdTool(toolName, args) {
  const lease = await ensureBrowserLease();
  const res = await fetch(SPACESD_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'authorization': `Bearer ${SPACESD_TOKEN}`,
      'mcp-session-id': lease.sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: toolName, arguments: { ...args, session: BROWSER_SESSION } },
    }),
    signal: AbortSignal.timeout(BROWSER_REQUEST_TIMEOUT_MS),
  });
  let body = null;
  try { body = await res.json(); } catch { }
  if (!res.ok) {
    return { isError: true, text: `spacesd answered HTTP ${res.status}`, structuredContent: null, content: [] };
  }
  if (!body || typeof body !== 'object') {
    return { isError: true, text: 'spacesd answered an unreadable payload', structuredContent: null, content: [] };
  }
  if (body.error) {
    return { isError: true, text: `spacesd refused: ${body.error.message ?? JSON.stringify(body.error)}`, structuredContent: null, content: [] };
  }
  const result = body.result;
  return {
    isError: !!result?.isError,
    text: pickSpacesdText(result),
    structuredContent: result?.structuredContent ?? null,
    content: Array.isArray(result?.content) ? result.content : [],
  };
}


async function withNamedSession(toolName, args, { retryOnce = true } = {}) {
  if (!browserSessionActive) {
    const started = await callSpacesdTool('start_session', {});
    if (started.isError) {
      return { isError: true, text: `could not start lifecycle session '${BROWSER_SESSION}': ${started.text}`, structuredContent: null, content: [] };
    }
    browserSessionActive = true;
  }
  let res = await callSpacesdTool(toolName, args);
  if (retryOnce && isSessionEndedRefusal(res)) {
    browserSessionActive = false;
    const started = await callSpacesdTool('start_session', {});
    if (!started.isError) {
      browserSessionActive = true;
      res = await callSpacesdTool(toolName, args);
    }
  }
  return res;
}

function browserResult(text, structured) {
  return { text, structured, isError: false };
}

function browserError(text) {
  return { text, structured: null, isError: true };
}


function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function isChromiumWindow(w) {
  const title = typeof w?.title === 'string' ? w.title : '';
  const app = typeof w?.app_name === 'string' ? w.app_name : '';
  return /chromium/i.test(title) || /chromium/i.test(app);
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sideNote(result) {
  if (!result) return 'unknown error';
  return result.text || JSON.stringify(result.structuredContent ?? {}) || 'unknown error';
}


async function requireBoundBrowser() {
  try {
    if (browserState.pid !== null && !isProcessAlive(browserState.pid)) {
      browserState.targetId = browserState.tabId = browserState.pid = browserState.windowId = null;
      browserState.url = null;
      return { error: 'browser is gone — call browser_open again' };
    }
    let { pid, windowId } = browserState;
    if (pid === null || windowId === null) {
      const listRes = await withNamedSession('list_windows', {});
      if (listRes.isError) return { error: `could not list windows: ${listRes.text || 'unknown error'}` };
      const windows = Array.isArray(listRes?.structuredContent?.windows) ? listRes.structuredContent.windows : [];
      const chromium = windows.find(isChromiumWindow);
      if (!chromium) return { error: 'no browser — call browser_open' };
      pid = chromium.pid;
      windowId = chromium.window_id;
    }
    const prepared = await withNamedSession('browser_prepare', {
      pid, window_id: windowId, strategy: { kind: 'existing_profile' },
    });
    if (prepared.isError) return { error: `could not attach to the browser (pid ${pid}): ${prepared.text || 'unknown error'}` };
    const state4 = await withNamedSession('get_browser_state', { pid, window_id: windowId });
    if (state4.isError) return { error: `could not read browser state (pid ${pid}): ${state4.text || 'unknown error'}` };
    const targetId = state4.structuredContent?.target_id ?? null;
    const tabs = Array.isArray(state4.structuredContent?.tabs) ? state4.structuredContent.tabs : [];
    const tab0 = tabs[0] ?? null;
    const tabId = tab0?.tab_id ?? null;
    if (!targetId || !tabId) return { error: 'no browser tab is available — cannot continue' };
    browserState.pid = pid;
    browserState.windowId = windowId;
    browserState.targetId = targetId;
    browserState.tabId = tabId;
    browserState.url = tab0?.url ?? null;
    return { pid, windowId, targetId, tabId, url: tab0?.url ?? null, tabs };
  } catch (err) {
    return { error: `spacesd unreachable: ${String(err?.message ?? err)}` };
  }
}

function snapTabsToContract(tabs) {
  return (Array.isArray(tabs) ? tabs : []).map(t => ({
    tabId: t?.tab_id ?? null,
    url: t?.url ?? null,
    title: t?.title ?? null,
    active: Boolean(t?.active),
  }));
}

function viewportFromStructured(structured) {
  const sc = structured ?? {};
  return {
    width: sc.width ?? null,
    height: sc.height ?? null,
    scaleFactor: sc.scale_factor ?? null,
  };
}

async function runBrowserStatus(_args, _trackChild) {
  const bound = await requireBoundBrowser();
  if (bound.error) return browserError(bound.error);
  const size = await withNamedSession('get_screen_size', {});
  if (size.isError) return browserError(`could not read screen size: ${size.text || 'unknown error'}`);
  const viewport = viewportFromStructured(size.structuredContent);
  return browserResult(
    `browser ready: target ${bound.targetId}, tab ${bound.tabId}`,
    {
      ready: true,
      browserPid: bound.pid,
      windowId: bound.windowId,
      targetId: bound.targetId,
      tabId: bound.tabId,
      viewport,
      tabs: snapTabsToContract(bound.tabs),
    },
  );
}

async function runBrowserOpen(args, _trackChild) {
  try {
    const launched = await withNamedSession('browser_prepare', {
      allow_launch: true,
      profile: { mode: 'isolated_new' },
    });
    if (launched.isError) return browserError(`could not launch a browser: ${launched.text || 'unknown error'}`);
    const preparedPid = launched.structuredContent?.prepared_pid ?? null;
    if (preparedPid === null) return browserError('could not launch a browser: spacesd did not report prepared_pid');
    browserState.pid = preparedPid;
    const deadline = Date.now() + 15000;
    let chromium = null;
    while (Date.now() < deadline) {
      const strip = await withNamedSession('list_windows', {});
      if (!strip.isError) {
        const windows = Array.isArray(strip.structuredContent?.windows) ? strip.structuredContent.windows : [];
        chromium = windows.find(isChromiumWindow) ?? null;
        if (chromium) break;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!chromium) return browserError('timed out after 15000ms waiting for the Chromium window to appear');
    const windowId = chromium.window_id;
    browserState.windowId = windowId;
    browserState.pid = chromium.pid ?? preparedPid;
    const prepared = await withNamedSession('browser_prepare', {
      pid: browserState.pid, window_id: windowId, strategy: { kind: 'existing_profile' },
    });
    if (prepared.isError) return browserError(`could not attach to the browser: ${prepared.text || 'unknown error'}`);
    const state4 = await withNamedSession('get_browser_state', { pid: browserState.pid, window_id: windowId });
    if (state4.isError) return browserError(`could not read browser state: ${state4.text || 'unknown error'}`);
    const targetId = state4.structuredContent?.target_id ?? null;
    const tabs = Array.isArray(state4.structuredContent?.tabs) ? state4.structuredContent.tabs : [];
    const tab0 = tabs[0] ?? null;
    const tabId = tab0?.tab_id ?? null;
    if (!targetId || !tabId) return browserError('browser has no tab — cannot finish browser_open');
    browserState.targetId = targetId;
    browserState.tabId = tabId;
    browserState.url = tab0?.url ?? null;
    if (args.url) {
      const nav = await withNamedSession('browser_navigate', { target_id: targetId, tab_id: tabId, url: args.url });
      if (nav.isError) return browserError(`browser opened but navigation failed: ${nav.text || 'unknown error'}`);
      browserState.url = nav.structuredContent?.url ?? args.url;
    }
    const finalUrl = args.url ?? browserState.url;
    return browserResult(`browser ready: target ${targetId}, tab ${tabId}${finalUrl ? `, ${finalUrl}` : ''}`, {
      targetId, tabId, url: finalUrl ?? undefined, windowId, pid: browserState.pid,
    });
  } catch (err) {
    return browserError(`spacesd unreachable: ${String(err?.message ?? err)}`);
  }
}

async function runBrowserNavigate(args, _trackChild) {
  const bound = await requireBoundBrowser();
  if (bound.error) return browserError(bound.error);
  const tabId = args.tabId ?? bound.tabId;
  const nav = await withNamedSession('browser_navigate', { target_id: bound.targetId, tab_id: tabId, url: args.url });
  if (nav.isError) return browserError(`navigation failed: ${nav.text || 'unknown error'}`);
  browserState.url = nav.structuredContent?.url ?? args.url;
  return browserResult(nav.text || `navigated to ${args.url}`, { url: nav.structuredContent?.url ?? args.url, tabId, targetId: bound.targetId });
}

async function runBrowserDialog(args, _trackChild) {
  const bound = await requireBoundBrowser();
  if (bound.error) return browserError(bound.error);
  const res = await withNamedSession('browser_dialog', {
    target_id: bound.targetId, tab_id: bound.tabId, action: args.action,
    dialog_id: args.dialogId, prompt_text: args.promptText,
    delivery_mode: 'foreground',
  });
  if (res.isError) return browserError(`dialog ${args.action} failed: ${res.text || 'unknown error'}`);
  return browserResult(res.text || `dialog ${args.action}`, { action: args.action, ...(res.structuredContent ?? {}) });
}

const BROWSER_RESIZE_PRESETS = {
  default: [1280, 800],
  hd: [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '2160p': [3840, 2160],
};
const BROWSER_RESIZE_MAX_WIDTH = 7680;
const BROWSER_RESIZE_MAX_HEIGHT = 4320;
const BROWSER_RESIZE_MIN_WIDTH = 320;
const BROWSER_RESIZE_MIN_HEIGHT = 200;

async function runBrowserResize(args, trackChild) {
  let width = null, height = null, preset = null;
  if (args.mode === 'reset') {
    width = 1280; height = 800; preset = 'default';
  } else if (args.mode === 'preset') {
    const [w, h] = BROWSER_RESIZE_PRESETS[args.preset];
    width = w; height = h; preset = args.preset;
  } else {
    width = args.width; height = args.height;
  }
  const cmd = `xrandr --fb ${width}x${height}`;
  const res = await runBash({ command: cmd, timeout: 15 }, trackChild);
  if (res.structured?.exit_code !== 0) return browserError(`xrandr failed: ${(res.structured?.output ?? '').trim() || res.text}`);
  let screen = null;
  try {
    const size = await withNamedSession('get_screen_size', {});
    if (!size.isError) screen = viewportFromStructured(size.structuredContent);
  } catch { }
  return browserResult(`desktop resolution set to ${width}x${height}${preset ? ` (preset ${preset})` : ''}`, {
    mode: args.mode, width, height, preset, screen,
  });
}

async function runBrowserSnapshot(args, _trackChild) {
  const bound = await requireBoundBrowser();
  if (bound.error) return browserError(bound.error);
  const snap = await withNamedSession('get_browser_state', {
    target_id: bound.targetId, tab_id: bound.tabId, include_screenshot: true,
  });
  if (snap.isError) return browserError(`snapshot failed: ${snap.text || 'unknown error'}`);
  const structured = snap.structuredContent ?? {};
  const content = Array.isArray(snap.content) ? snap.content : [];
  const imageBlocks = content.filter(c => c && c.type === 'image' && typeof c.data === 'string')
    .map(c => ({ type: 'image', data: c.data, mimeType: c.mimeType ?? 'image/png' }));
  const textBlock = content.find(c => c && c.type === 'text');
  const screenshot = structured.screenshot ?? null;
  const shotDims = screenshot ? { width: screenshot.width ?? null, height: screenshot.height ?? null, mimeType: screenshot.mime_type ?? 'image/png' } : null;
  let passImage = imageBlocks.length > 0;
  if (args.maxImageDimension && shotDims && (shotDims.width === null || shotDims.width > args.maxImageDimension || shotDims.height === null || shotDims.height > args.maxImageDimension)) {
    passImage = false;
  }
  const text = textBlock?.text ?? `snapshot ${structured.snapshot_id ?? 'unknown'} of ${structured.url ?? bound.url ?? 'about:blank'}`;
  return {
    text,
    structured: {
      snapshotId: structured.snapshot_id ?? null,
      mode: 'snapshot',
      targetId: bound.targetId,
      tabId: bound.tabId,
      url: structured.url ?? null,
      refs: Array.isArray(structured.refs) ? structured.refs : [],
      screenshot: shotDims,
      truncated: structured.truncated ?? false,
      status: structured.status ?? 'ok',
      ...(args.maxImageDimension && !passImage ? { imageSkipped: `screenshot exceeds maxImageDimension ${args.maxImageDimension}` } : {}),
    },
    isError: false,
    extraContent: passImage ? imageBlocks : [],
  };
}

function buildBrowserActCall(action, args, bound) {
  switch (action) {
    case 'click':
      return { name: 'browser_click', args: {
        target_id: bound.targetId, tab_id: bound.tabId, ref: args.ref, x: args.x, y: args.y,
        delivery_mode: 'foreground',
      } };
    case 'double_click':
      return { name: 'browser_pointer', args: {
        target_id: bound.targetId, tab_id: bound.tabId, action: 'double_click', ref: args.ref, x: args.x, y: args.y,
        delivery_mode: 'foreground',
      } };
    case 'right_click':
      return { name: 'browser_pointer', args: {
        target_id: bound.targetId, tab_id: bound.tabId, action: 'right_click', ref: args.ref, x: args.x, y: args.y,
        delivery_mode: 'foreground',
      } };
    case 'type':
      return { name: 'browser_type', args: {
        target_id: bound.targetId, tab_id: bound.tabId, ref: args.ref, text: args.text,
        ...(args.replace !== undefined ? { replace: args.replace } : {}),
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
      } };
    case 'select':
      return { name: 'browser_select', args: {
        target_id: bound.targetId, tab_id: bound.tabId, ref: args.ref, label: args.label, value: args.value,
      } };
    case 'hover':
    case 'point':
      return { name: 'browser_pointer', args: {
        target_id: bound.targetId, tab_id: bound.tabId, action: 'hover', ref: args.ref, x: args.x, y: args.y,
        delivery_mode: 'foreground',
      } };
    case 'drag':
      return { name: 'browser_pointer', args: {
        target_id: bound.targetId, tab_id: bound.tabId, action: 'drag', ref: args.ref, x: args.x, y: args.y,
        destination_ref: args.destinationRef, to_x: args.toX, to_y: args.toY,
        delivery_mode: 'foreground',
      } };
    case 'scroll':
      return { name: 'browser_pointer', args: {
        target_id: bound.targetId, tab_id: bound.tabId, action: 'scroll', ref: args.ref, x: args.x, y: args.y,
        delta_x: args.deltaX, delta_y: args.deltaY,
        delivery_mode: 'foreground',
      } };
    case 'press_key':
      return { name: 'press_key', args: {
        key: args.key, pid: bound.pid, window_id: bound.windowId,
        delivery_mode: 'foreground',
      } };
    case 'set_input_files':
      return { name: 'browser_set_input_files', args: {
        target_id: bound.targetId, tab_id: bound.tabId, ref: args.ref, files: args.files,
      } };
    default:
      return null;
  }
}

async function runBrowserAct(args, _trackChild) {
  const bound = await requireBoundBrowser();
  if (bound.error) return browserError(bound.error);
  const call = buildBrowserActCall(args.action, args, bound);
  if (!call) return browserError(`unsupported action: ${args.action}`);
  const params = Object.fromEntries(Object.entries(call.args).filter(([, v]) => v !== undefined));
  const res = await withNamedSession(call.name, params);
  if (res.isError) return browserError(`${args.action} failed: ${res.text || 'unknown error'}`);
  return browserResult(res.text || `${args.action} ok`, { action: args.action, status: 'ok' });
}

async function runBrowserEvaluate(args, _trackChild) {
    const bound = await requireBoundBrowser();
    if (bound.error) return browserError(bound.error);
    try {
        const out = await cdpEvaluate(bound.pid, args.expression, !!args.awaitPromise);
        const text = typeof out === "string" ? out : JSON.stringify(out);
        return browserResult(text ?? "undefined", { expression: args.expression, value: out ?? null });
    } catch (e) {
        return browserError(`evaluation failed: ${e?.message || e}`);
    }
}

async function cdpEvaluate(pid, expression, awaitPromise) {
    let port = null;
    for (let i = 0; i < 20 && !port; i++) {
        port = await discoverCdpPort(pid);
        if (!port) await new Promise((r) => setTimeout(r, 500));
    }
    if (!port) throw new Error(`no CDP endpoint found for pid ${pid}`);
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) throw new Error(`CDP endpoint ${port} did not answer`);
    const targets = await res.json();
    const pages = (targets || []).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    const page = pages.find((t) => !(t.url || "").startsWith("about:"))
        || pages[0]
        || (targets || []).find((t) => t.webSocketDebuggerUrl);
    const wsUrl = page?.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error("the browser reports no page target to evaluate in");
    return await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
            try { ws.close(); } catch { }
            reject(new Error("CDP evaluate timed out"));
        }, 30000);
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({
                id: 1,
                method: "Runtime.evaluate",
                params: { expression, returnByValue: true, awaitPromise: !!awaitPromise },
            }));
        });
        ws.addEventListener("message", (ev) => {
            try {
                const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
                if (msg.id !== 1) return;
                clearTimeout(timer);
                ws.close();
                if (msg.error) return reject(new Error(msg.error.message || "CDP error"));
                const r = msg.result?.result;
                if (r?.subtype === "error") return reject(new Error(r.description || "page error"));
                resolve(r && "value" in r ? r.value : (r?.description ?? null));
            } catch (e) {
                clearTimeout(timer);
                reject(e);
            }
        });
        ws.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error("CDP socket error"));
        });
    });
}

async function discoverCdpPort(pid) {
  try {
    const root = join(homedir(), '.local/share/cua-driver-profiles');
    const names = await readdir(root);
    let best = null;
    let bestMtime = 0;
    for (const n of names) {
      const p = join(root, n, 'DevToolsActivePort');
      try {
        const st = await stat(p);
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          best = p;
        }
      } catch { }
    }
    if (best) {
      const first = (await readFile(best, 'utf8')).split('\n')[0].trim();
      const port = parseInt(first, 10);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
  } catch { }
  try {
    const raw = await readProcCmdline(pid);
    const udd = raw.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    if (!udd) return null;
    const first = (await readFile(join(udd, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim();
    const port = parseInt(first, 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

async function readProcCmdline(pid) {
  const fh = await fsOpen(`/proc/${pid}/cmdline`, 'r');
  try {
    const chunks = [];
    const buf = Buffer.alloc(4096);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks).toString('latin1').split('\0').filter((a) => a.length > 0);
  } finally {
    await fh.close();
  }
}

async function runBrowserWaitFor(args, _trackChild) {
  const bound = await requireBoundBrowser();
  if (bound.error) return browserError(bound.error);
  const res = await withNamedSession('verify_state', {
    pid: bound.pid, window_id: bound.windowId, expect: args.expect,
  });
  if (res.isError) return browserError(`wait failed: ${res.text || 'unknown error'}`);
  return browserResult(res.text || 'wait complete', res.structuredContent ?? null);
}

async function runBrowserRecordingStart(args, trackChild) {
  try {
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    let finalPath = (args.path ?? '').trim() || `/work/demo-${ts}.mp4`;
    if (!finalPath.startsWith('/')) {
      return browserError('path must be absolute and under /work (the mounted checkout)');
    }
    if (!finalPath.startsWith('/work/')) {
      return browserError('path must live under /work — the mounted checkout is the only place a recording survives the sandbox');
    }
    finalPath = await uniquePath(finalPath);
    const outDir = `/tmp/browser-recording/${randomBytes(4).toString('hex')}`;
    await mkdir(outDir, { recursive: true });
    if (browserState.recording) {
      return browserError(`a recording is already in progress (id ${browserState.recording.id})`);
    }
    const cursor = await withNamedSession('set_agent_cursor_enabled', { enabled: true });
    if (cursor.isError) return browserError(`could not enable the agent cursor: ${cursor.text || 'unknown error'}`);
    const started = await withNamedSession('start_recording', {
      record_video: true, output_dir: outDir, include_accessibility_tree: false,
    });
    if (started.isError) return browserError(`could not start the recording: ${started.text || 'unknown error'}`);
    const narrationPath = join(outDir, 'narration.m4a');
    let ffmpegChild = null;
    try {
      ffmpegChild = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'pulse',
        '-i', 'cua_desktop.monitor', '-c:a', 'aac', narrationPath], { stdio: 'ignore', detached: false });
    } catch (err) {
      ffmpegChild = null;
      try { await withNamedSession('stop_recording', {}); } catch { }
      return browserError(`could not start audio capture (ffmpeg): ${String(err?.message ?? err)}`);
    }
    ffmpegChild.once('error', () => {});
    const id = `rec-${randomBytes(6).toString('hex')}`;
    const recording = {
      id, outputDir: outDir, finalPath, tabId: browserState.tabId, url: browserState.url,
      createdAt: new Date().toISOString(), ffmpegPid: ffmpegChild.pid, ffmpegChild,
    };
    browserState.recording = recording;
    return browserResult(`recording started (id ${id}) — the finished video will be at ${finalPath}`, {
      id, path: finalPath, outputDir: outDir, tabId: recording.tabId, createdAt: recording.createdAt,
    });
  } catch (err) {
    return browserError(`could not start the recording: ${String(err?.message ?? err)}`);
  }
}

async function uniquePath(p) {
  const m = p.match(/^(.*?)(\.mp4)?$/);
  const base = m[1];
  const ext = m[2] ?? '.mp4';
  let candidate = p;
  for (let n = 1; ; n++) {
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
    candidate = `${base}-${n}${ext}`;
  }
}

async function runBrowserRecordingStop(_args, trackChild) {
  const recording = browserState.recording;
  browserState.recording = null;
  if (!recording) return browserError('no recording in progress');
  let stopRes = null;
  try { stopRes = await withNamedSession('stop_recording', {}); }
  catch (err) { stopRes = { isError: true, text: String(err?.message ?? err), structuredContent: null, content: [] }; }
  if (recording.ffmpegPid) {
    try { process.kill(recording.ffmpegPid, 'SIGINT'); } catch { }
    try {
      await Promise.race([
        new Promise(r => {
          recording.ffmpegChild.once('exit', r);
          recording.ffmpegChild.once('close', r);
        }),
        new Promise(r => setTimeout(r, 5000)),
      ]);
    } catch { }
  }
  if (stopRes.isError) {
    return browserError(`recording stop failed: ${stopRes.text || 'unknown error'} — audio capture was killed, the video path is unknown`);
  }
  const lastVideo = stopRes.structuredContent?.last_video_path ?? null;
  if (!lastVideo) return browserError('recording stopped but spacesd did not report last_video_path');
  const narrationPath = join(recording.outputDir, 'narration.m4a');
  let audioOk = false;
  try {
    const st = await stat(narrationPath);
    if (st.size > 0) {
      const probe = await runBash({
        command: `ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 ${shQuote(narrationPath)}`,
        timeout: 30,
      }, trackChild);
      const out = (probe.structured?.output ?? '').trim();
      audioOk = out.length > 0 && !/no streams|error/i.test(out);
    }
  } catch { audioOk = false; }
  let path = lastVideo;
  let muxed = false;
  const finalPath = recording.finalPath ?? lastVideo;
  await mkdir(dirname(finalPath), { recursive: true }).catch(() => {});
  if (audioOk) {
    const mux = await runBash({
      command: `ffmpeg -y -i ${shQuote(lastVideo)} -i ${shQuote(narrationPath)} -map 0:v -map 1:a -c:v copy -c:a aac -shortest ${shQuote(finalPath)}`,
      timeout: 120,
    }, trackChild);
    if (mux.structured?.exit_code === 0) { path = finalPath; muxed = true; }
    else return browserError(`recording audio is present but the mux failed: ${(mux.structured?.output ?? '').trim() || mux.text} — video kept at ${lastVideo}`);
  } else {
    const copy = await runBash({
      command: `cp ${shQuote(lastVideo)} ${shQuote(finalPath)}`,
      timeout: 120,
    }, trackChild);
    if (copy.structured?.exit_code === 0) { path = finalPath; }
    else return browserError(`could not write the video to ${finalPath}: ${(copy.structured?.output ?? '').trim() || copy.text} — video kept at ${lastVideo}`);
  }
  let sizeBytes = 0;
  try { sizeBytes = (await stat(path)).size; } catch { sizeBytes = 0; }
  return browserResult(`recording saved: ${path} (${sizeBytes} bytes)${muxed ? ' (with narration audio)' : ''}`, {
    id: recording.id, tabId: recording.tabId, path, mimeType: 'video/mp4', sizeBytes,
    createdAt: recording.createdAt, muxed,
  });
}

async function runBrowserList(_args, _trackChild) {
  const bound = await requireBoundBrowser();
  if (bound.error) return browserError(bound.error);
  return browserResult(`${(bound.tabs ?? []).length} tab(s)`, { tabs: snapTabsToContract(bound.tabs) });
}

async function runBrowserClose(_args, _trackChild) {
  if (browserState.pid === null) return browserError('no browser — call browser_open');
  const pid = browserState.pid;
  const res = await withNamedSession('kill_app', { pid });
  if (res.isError) return browserError(`could not close browser (pid ${pid}): ${res.text || 'unknown error'}`);
  browserState.targetId = browserState.tabId = browserState.pid = browserState.windowId = browserState.url = null;
  return browserResult(`browser closed (pid ${pid}) — tabs do not survive`);
}

async function runBrowserFullscreen(_args, trackChild) {
  const bound = await requireBoundBrowser();
  if (bound.error) return browserError(bound.error);
  const winId = bound.windowId;
  const act = await runBash({ command: `xdotool windowactivate --sync ${winId} && xdotool key F11`, timeout: 15 }, trackChild);
  let method;
  if (act.structured?.exit_code === 0) {
    method = 'f11';
  } else {
    const fb = await runBash({ command: `xdotool windowmaximize ${winId}`, timeout: 15 }, trackChild);
    if (fb.structured?.exit_code !== 0) {
      return browserError(`could not full-screen the browser window: xdotool key F11 failed (${(act.structured?.output ?? '').trim() || act.text}) and windowmaximize also failed (${(fb.structured?.output ?? '').trim() || fb.text})`);
    }
    method = 'windowmaximize';
  }
  let bounds = null;
  try {
    const strip = await withNamedSession('list_windows', {});
    if (!strip.isError) {
      const windows = Array.isArray(strip.structuredContent?.windows) ? strip.structuredContent.windows : [];
      const win = windows.find(w => w.window_id === winId);
      if (win) bounds = win.bounds ?? { x: win.x ?? null, y: win.y ?? null, width: win.width ?? null, height: win.height ?? null };
    }
  } catch { }
  return browserResult(`browser window full-screened (${method})${bounds ? `: ${bounds.width}x${bounds.height}@${bounds.x},${bounds.y}` : ''}`, {
    method, windowId: winId, bounds,
  });
}

async function runBrowserNarrate(args, _trackChild) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => { if (settled) return; settled = true; clearTimeout(timer); resolve(out); };
    const child = spawn('/usr/local/bin/voice', ['say', ...(args.voice ? ['--voice', args.voice] : []), args.text], { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { }
      finish(browserError('voice timed out after 180s'));
    }, 180000);
    if (timer.unref) timer.unref();
    child.stderr?.on('data', d => { if (stderr.length < 8000) stderr += d; });
    child.once('error', (err) => {
      finish(browserError(`voice client could not start: ${err.message}`));
    });
    child.once('close', (code, signal) => {
      if (code === 0) finish(browserResult(`spoken: ${args.text}`, { spoken: true, voice: args.voice ?? null, text: args.text }));
      else finish(browserError(`voice failed (exit ${code ?? signal ?? 'unknown'}): ${stderr.trim() || 'no error output'}`));
    });
  });
}


function validateBrowserActArgs(args) {
  const action = args.action;
  const ACTIONS = ['click', 'point', 'double_click', 'right_click', 'type', 'select', 'hover', 'drag', 'scroll', 'press_key', 'set_input_files'];
  if (typeof action !== 'string' || !ACTIONS.includes(action)) {
    return { code: INVALID_PARAMS, message: `Invalid params: "action" must be one of ${ACTIONS.join('|')}` };
  }
  for (const [key, v] of Object.entries(args)) {
    if (key === 'action') continue;
    if (v !== undefined && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return { code: INVALID_PARAMS, message: `Invalid params: "${key}" must be a scalar, not an object` };
    }
  }
  if (args.ref !== undefined && args.ref !== null && typeof args.ref !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "ref" must be a string' };
  }
  for (const k of ['x', 'y', 'toX', 'toY', 'deltaX', 'deltaY']) {
    if (args[k] !== undefined && typeof args[k] !== 'number') {
      return { code: INVALID_PARAMS, message: `Invalid params: "${k}" must be a number` };
    }
  }
  if (args.text !== undefined && typeof args.text !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "text" must be a string' };
  }
  if (args.replace !== undefined && typeof args.replace !== 'boolean') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "replace" must be a boolean' };
  }
  if (args.mode !== undefined && args.mode !== 'insert_text' && args.mode !== 'keystrokes') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "mode" must be "insert_text" or "keystrokes"' };
  }
  if (args.label !== undefined && typeof args.label !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "label" must be a string' };
  }
  if (args.value !== undefined && typeof args.value !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "value" must be a string' };
  }
  if (args.key !== undefined && typeof args.key !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "key" must be a string' };
  }
  if (args.files !== undefined) {
    if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 32) {
      return { code: INVALID_PARAMS, message: 'Invalid params: "files" must be an array of 1..32 absolute file paths' };
    }
    for (const f of args.files) {
      if (typeof f !== 'string' || !isAbsolute(f)) {
        return { code: INVALID_PARAMS, message: 'Invalid params: "files" must be absolute file paths' };
      }
    }
  }
  if (args.destinationRef !== undefined && typeof args.destinationRef !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "destinationRef" must be a string' };
  }
  const point = args.ref !== undefined || (args.x !== undefined && args.y !== undefined);
  switch (action) {
    case 'click':
    case 'point':
    case 'double_click':
    case 'right_click':
    case 'hover':
      if (!point) return { code: INVALID_PARAMS, message: `Invalid params: ${action} requires a ref or both x and y` };
      break;
    case 'type':
      if (args.ref === undefined) return { code: INVALID_PARAMS, message: 'Invalid params: type requires "ref"' };
      if (args.text === undefined) return { code: INVALID_PARAMS, message: 'Invalid params: type requires "text"' };
      break;
    case 'select':
      if (args.ref === undefined) return { code: INVALID_PARAMS, message: 'Invalid params: select requires "ref"' };
      if ((args.label === undefined) === (args.value === undefined)) {
        return { code: INVALID_PARAMS, message: 'Invalid params: select requires exactly one of "label" or "value"' };
      }
      break;
    case 'drag':
      if (!point) return { code: INVALID_PARAMS, message: 'Invalid params: drag requires an origin (ref or x and y)' };
      if (args.destinationRef === undefined && !(args.toX !== undefined && args.toY !== undefined)) {
        return { code: INVALID_PARAMS, message: 'Invalid params: drag requires a destination (destinationRef or toX and toY)' };
      }
      break;
    case 'scroll':
      if (args.deltaX === undefined && args.deltaY === undefined) {
        return { code: INVALID_PARAMS, message: 'Invalid params: scroll requires deltaX or deltaY' };
      }
      break;
    case 'press_key':
      if (args.key === undefined) return { code: INVALID_PARAMS, message: 'Invalid params: press_key requires "key"' };
      break;
    case 'set_input_files':
      if (args.ref === undefined) return { code: INVALID_PARAMS, message: 'Invalid params: set_input_files requires "ref"' };
      if (args.files === undefined) return { code: INVALID_PARAMS, message: 'Invalid params: set_input_files requires "files"' };
      break;
  }
  return { args: { ...args } };
}

function validateBrowserOpenArgs(args) {
  if (args.url !== undefined && typeof args.url !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "url" must be a string' };
  }
  return { args: { url: args.url } };
}

function validateBrowserNavigateArgs(args) {
  if (typeof args.url !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "url" is required and must be a string' };
  }
  if (args.tabId !== undefined && typeof args.tabId !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "tabId" must be a string' };
  }
  return { args: { url: args.url, tabId: args.tabId } };
}

function validateBrowserDialogArgs(args) {
  const ACTIONS = ['inspect', 'accept', 'dismiss'];
  if (typeof args.action !== 'string' || !ACTIONS.includes(args.action)) {
    return { code: INVALID_PARAMS, message: `Invalid params: "action" must be one of ${ACTIONS.join('|')}` };
  }
  if (args.dialogId !== undefined && typeof args.dialogId !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "dialogId" must be a string' };
  }
  if (args.promptText !== undefined && typeof args.promptText !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "promptText" must be a string' };
  }
  return { args: { action: args.action, dialogId: args.dialogId, promptText: args.promptText } };
}

function validateBrowserResizeArgs(args) {
  const MODES = ['freeform', 'preset', 'reset'];
  if (typeof args.mode !== 'string' || !MODES.includes(args.mode)) {
    return { code: INVALID_PARAMS, message: `Invalid params: "mode" must be one of ${MODES.join('|')}` };
  }
  if (args.mode === 'reset') return { args: { mode: 'reset' } };
  if (args.mode === 'preset') {
    if (typeof args.preset !== 'string' || !(args.preset in BROWSER_RESIZE_PRESETS)) {
      return { code: INVALID_PARAMS, message: `Invalid params: "preset" must be one of ${Object.keys(BROWSER_RESIZE_PRESETS).join('|')}` };
    }
    return { args: { mode: 'preset', preset: args.preset } };
  }
  if (typeof args.width !== 'number' || !Number.isFinite(args.width)) {
    return { code: INVALID_PARAMS, message: 'Invalid params: "width" is required and must be a number' };
  }
  if (typeof args.height !== 'number' || !Number.isFinite(args.height)) {
    return { code: INVALID_PARAMS, message: 'Invalid params: "height" is required and must be a number' };
  }
  if (args.width < BROWSER_RESIZE_MIN_WIDTH || args.width > BROWSER_RESIZE_MAX_WIDTH) {
    return { code: INVALID_PARAMS, message: `Invalid params: "width" must be between ${BROWSER_RESIZE_MIN_WIDTH} and ${BROWSER_RESIZE_MAX_WIDTH}` };
  }
  if (args.height < BROWSER_RESIZE_MIN_HEIGHT || args.height > BROWSER_RESIZE_MAX_HEIGHT) {
    return { code: INVALID_PARAMS, message: `Invalid params: "height" must be between ${BROWSER_RESIZE_MIN_HEIGHT} and ${BROWSER_RESIZE_MAX_HEIGHT}` };
  }
  return { args: { mode: 'freeform', width: args.width, height: args.height } };
}

function validateBrowserSnapshotArgs(args) {
  if (args.maxImageDimension !== undefined) {
    if (typeof args.maxImageDimension !== 'number' || !Number.isFinite(args.maxImageDimension) || args.maxImageDimension < 1) {
      return { code: INVALID_PARAMS, message: 'Invalid params: "maxImageDimension" must be a positive number' };
    }
  }
  return { args: { maxImageDimension: args.maxImageDimension } };
}

function validateBrowserEvaluateArgs(args) {
  if (typeof args.expression !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "expression" is required and must be a string' };
  }
  if (args.awaitPromise !== undefined && typeof args.awaitPromise !== 'boolean') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "awaitPromise" must be a boolean' };
  }
  return { args: { expression: args.expression, awaitPromise: args.awaitPromise } };
}

function validateBrowserWaitForArgs(args) {
  if (!Array.isArray(args.expect) || args.expect.length < 1 || args.expect.length > 8) {
    return { code: INVALID_PARAMS, message: 'Invalid params: "expect" must be an array of 1..8 predicates' };
  }
  for (const pred of args.expect) {
    if (!pred || typeof pred !== 'object' || Array.isArray(pred)) {
      return { code: INVALID_PARAMS, message: 'Invalid params: every "expect" predicate must be an object' };
    }
  }
  return { args: { expect: args.expect } };
}

function validateBrowserRecordingStartArgs(args) {
  if (args.path !== undefined && typeof args.path !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "path" must be a string' };
  }
  return { args: { path: args.path } };
}

function validateBrowserNarrateArgs(args) {
  if (typeof args.text !== 'string' || args.text.length === 0) {
    return { code: INVALID_PARAMS, message: 'Invalid params: "text" is required and must be a non-empty string' };
  }
  if (args.voice !== undefined && typeof args.voice !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "voice" must be a string' };
  }
  return { args: { text: args.text, voice: args.voice } };
}

const BROWSER_TOOLS = [
  {
    name: 'browser_status',
    description: 'Read the bound browser: ready state, browserPid, windowId, targetId, tabId, viewport and tab list. Auto-binds the running browser when one is alive (re-runs the browser_open attach flow); errors "no browser — call browser_open" otherwise.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'browser_open',
    description: 'Launch a driver-owned isolated Chromium (allow_launch) or attach to a running one and bind it: launches, finds the Chromium window, attaches (existing_profile), reads the target/tab, then navigates when a URL is given. Returns {targetId, tabId, url?, windowId, pid}.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL to navigate the browser to (http:, https:, or about:)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a tab of the bound browser to a new URL (http/https/about only — file:// is refused). Pass tabId to override the bound tab.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Destination URL (http:, https:, or about:)' },
        tabId: { type: 'string', description: 'Optional tab id override — defaults to the bound tab' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_dialog',
    description: 'Inspect or resolve a page-owned JS alert/confirm/prompt/beforeunload dialog on the bound tab. action=inspect returns the current dialog_id; accept/dismiss require that exact id. Linux callers always use foreground delivery (trusted input is refused in the background).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'accept', 'dismiss'], description: 'What to do with the current dialog' },
        dialogId: { type: 'string', description: 'Opaque dialog id from action=inspect (required for accept/dismiss)' },
        promptText: { type: 'string', description: 'Sensitive response text, valid only when accepting a prompt dialog' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_resize',
    description: 'Resize the WHOLE desktop (xrandr --fb WxH — the window manager, the viewer and the recording follow). mode=freeform takes width/height (320..7680 / 200..4320); mode=preset picks a named resolution (default 1280x800, hd 1280x720, 1080p 1920x1080, 1440p 2560x1440, 2160p 3840x2160); mode=reset restores the 1280x800 default.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['freeform', 'preset', 'reset'], description: 'freeform: width/height required; preset: preset required; reset: always 1280x800' },
        width: { type: 'number', description: 'freeform only — framebuffer width in px (320..7680)' },
        height: { type: 'number', description: 'freeform only — framebuffer height in px (200..4320)' },
        preset: { type: 'string', enum: ['default', 'hd', '1080p', '1440p', '2160p'], description: 'preset only — named desktop resolution' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Capture the exact tab viewport (PNG) plus the snapshot refs and metadata. Returns the image block verbatim (one PNG image block) + the text summary + structured refs. maxImageDimension skips the image block when the viewport exceeds it (no resizing is done) and records imageSkipped instead. Refs are session-scoped and are invalidated by navigation/snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        maxImageDimension: { type: 'number', description: 'Skip the image block when either viewport dimension exceeds this value (default: always include)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_act',
    description: 'Perform one browser action on the bound tab/window, dispatched to the matching spacesd tool: click→browser_click (also moves the agent-cursor overlay); double_click/right_click/hover/drag/scroll→browser_pointer (hover/double_click/right_click/drag need ref or x/y; scroll needs deltaX or deltaY; drag needs a destination); type→browser_type (ref + text, optional replace/mode); select→browser_select (ref + exactly one of label/value); press_key→press_key (key, desktop-level XSendEvent to the browser window); set_input_files→browser_set_input_files (ref + 1..32 absolute files). Input tools always default delivery_mode to foreground.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'point', 'double_click', 'right_click', 'type', 'select', 'hover', 'drag', 'scroll', 'press_key', 'set_input_files'], description: 'The action to perform. "point" moves the agent cursor to the spot WITHOUT clicking — a narration aid that shows in recordings; "click" and friends click.' },
        ref: { type: 'string', description: 'Page element ref (from browser_snapshot)' },
        x: { type: 'number', description: 'Viewport x (CSS px) — alternative to ref' },
        y: { type: 'number', description: 'Viewport y (CSS px) — alternative to ref' },
        text: { type: 'string', description: 'type: text to type (required)' },
        replace: { type: 'boolean', description: 'type: select the whole field content first (default: insert at caret)' },
        mode: { type: 'string', enum: ['insert_text', 'keystrokes'], description: 'type: insert_text (default) or keystrokes' },
        label: { type: 'string', description: 'select: exact visible label of the option' },
        value: { type: 'string', description: 'select: exact value attribute of the option' },
        key: { type: 'string', description: 'press_key: key name (enter, tab, escape, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, f1-f12, or a single ASCII character)' },
        files: { type: 'array', items: { type: 'string' }, description: 'set_input_files: 1..32 absolute file paths' },
        deltaX: { type: 'number', description: 'scroll: horizontal scroll delta (CSS px)' },
        deltaY: { type: 'number', description: 'scroll: vertical scroll delta (CSS px)' },
        destinationRef: { type: 'string', description: 'drag: destination page ref' },
        toX: { type: 'number', description: 'drag: destination viewport x (CSS px)' },
        toY: { type: 'number', description: 'drag: destination viewport y (CSS px)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Execute a JavaScript expression in the bound browser via the legacy page tool (page {action:"execute_javascript"}). The expression is self-contained (e.g. "document.title"); values are returned in the text summary. awaitPromise has no spacesd-side effect in v1 — keep the expression self-contained (the document is already loaded).',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript source to execute in the bound page' },
        awaitPromise: { type: 'boolean', description: 'Accepted for contract parity — no spacesd-side effect; do not rely on it' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Deterministically wait for 1..8 window predicates (verify_state) on the bound browser window. Pass the expect array verbatim. Predicate results are satisfied/unsatisfied/unknown — unknown never implies success.',
    inputSchema: {
      type: 'object',
      properties: {
        expect: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object' }, description: '1..8 predicates combined with logical AND (see verify_state for the predicate grammar)' },
      },
      required: ['expect'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_recording_start',
    description: 'Start a narrated desktop recording. Audio played in the sandbox (browser_narrate) is captured alongside the video (the sandbox pulse monitor) and muxed into the finished mp4. Shows the agent-cursor overlay. `path` is where the FINISHED mp4 will land — give the final name up front; there is no copy step afterwards. Returns {id, path, tabId, createdAt}.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute final video path under /work (the mounted checkout — the only place a recording survives the sandbox). Default: /work/demo-<timestamp>.mp4. An existing file is never overwritten; a numeric suffix is added instead.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_recording_stop',
    description: 'Stop the recording and finalize the mp4 at the path given to browser_recording_start: the narration audio is muxed in when present (copied without audio otherwise). Returns {id, tabId, path, mimeType:"video/mp4", sizeBytes, createdAt, muxed} — `path` is the finished artifact, ready where you asked for it. Robust: if spacesd stop fails, the audio is still killed and the failure is reported honestly.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'browser_list',
    description: 'List the tabs of the bound browser: {tabs:[{tabId,url,title,active}]}.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'browser_close',
    description: 'Kill the driver-owned browser process and clear module browser state. Only the driver-owned browser is killed — tabs do NOT survive (unlike a human-quit browser).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'browser_fullscreen',
    description: 'Toggle the browser window full-screen (xdotool windowactivate --sync <id> && xdotool key F11; fallback windowmaximize). Whole-window state, not tab state. Returns the window bounds afterwards plus {method:"f11"|"windowmaximize"}.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'browser_narrate',
    description: 'Speak a text through the sandbox audio via the in-image voice client (/usr/local/bin/voice say [--voice V] <text>; env VOICE_TTS_URL is the client endpoint). Blocks until playback finishes — narration must be sequenced before the next action. When recording, the narration lands in the mp4.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak' },
        voice: { type: 'string', description: "Voice preset override (default: the voice server's own default preset — leave unspecified for that)" },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

const BROWSER_TOOL_REGISTRY = {
  browser_status: { validate: () => ({ args: {} }), run: (args) => enqueueBrowser(() => runBrowserStatus(args)) },
  browser_open: { validate: validateBrowserOpenArgs, run: (args) => enqueueBrowser(() => runBrowserOpen(args)) },
  browser_navigate: { validate: validateBrowserNavigateArgs, run: (args) => enqueueBrowser(() => runBrowserNavigate(args)) },
  browser_dialog: { validate: validateBrowserDialogArgs, run: (args) => enqueueBrowser(() => runBrowserDialog(args)) },
  browser_resize: { validate: validateBrowserResizeArgs, run: (args, trackChild) => enqueueBrowser(() => runBrowserResize(args, trackChild)) },
  browser_snapshot: { validate: validateBrowserSnapshotArgs, run: (args) => enqueueBrowser(() => runBrowserSnapshot(args)) },
  browser_act: { validate: validateBrowserActArgs, run: (args) => enqueueBrowser(() => runBrowserAct(args)) },
  browser_evaluate: { validate: validateBrowserEvaluateArgs, run: (args) => enqueueBrowser(() => runBrowserEvaluate(args)) },
  browser_wait_for: { validate: validateBrowserWaitForArgs, run: (args) => enqueueBrowser(() => runBrowserWaitFor(args)) },
  browser_recording_start: { validate: validateBrowserRecordingStartArgs, run: (args, trackChild) => enqueueBrowser(() => runBrowserRecordingStart(args, trackChild)) },
  browser_recording_stop: { validate: () => ({ args: {} }), run: (args, trackChild) => enqueueBrowser(() => runBrowserRecordingStop(args, trackChild)) },
  browser_list: { validate: () => ({ args: {} }), run: (args) => enqueueBrowser(() => runBrowserList(args)) },
  browser_close: { validate: () => ({ args: {} }), run: (args) => enqueueBrowser(() => runBrowserClose(args)) },
  browser_fullscreen: { validate: () => ({ args: {} }), run: (args, trackChild) => enqueueBrowser(() => runBrowserFullscreen(args, trackChild)) },
  browser_narrate: { validate: validateBrowserNarrateArgs, run: (args) => enqueueBrowser(() => runBrowserNarrate(args)) },
};

const TOOL_REGISTRY = {
  ...BASE_TOOL_REGISTRY,
  ...(BROWSER_ENABLED ? BROWSER_TOOL_REGISTRY : {}),
};

const BASE_TOOLS = [BASH_TOOL, READ_TOOL, WRITE_TOOL];



function handleInitialize() {
  return rpcResult(null, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: BROWSER_ENABLED
      ? 'Eighteen tools: bash, read, write + 15 gated browser tools (CUA_BROWSER_TOOLS=1) — one-shot shell execution, file primitives and browser automation (pi-harness semantics). Stateless server: perform the initialize handshake per request.'
      : 'Three tools: bash, read, write — one-shot shell execution and file primitives '
        + 'in the sandbox (pi-harness semantics). Stateless server: perform the initialize handshake per request.',
  }).result;
}


async function dispatchRpc(message, trackChild) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0'
    || typeof message.method !== 'string') {
    return { status: 200, body: rpcError(null, INVALID_REQUEST, 'Invalid JSON-RPC request') };
  }
  const { id, method, params } = message;
  if (id === null || id === undefined) return { status: 202, body: null };
  switch (method) {
    case 'initialize':
      return { status: 200, body: rpcResult(id, handleInitialize()) };
    case 'notifications/initialized':
      return { status: 202, body: null };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: [...BASE_TOOLS, ...(BROWSER_ENABLED ? BROWSER_TOOLS : [])] }) };
    case 'tools/call': {
      const checked = validateToolCallParams(params);
      if (checked.unknownTool) {
        return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `Unknown tool: ${checked.unknownTool}`) };
      }
      if (checked.code) return { status: 200, body: rpcError(id, checked.code, checked.message) };
      const out = await TOOL_REGISTRY[checked.name].run(checked.args, trackChild);
      return { status: 200, body: rpcResult(id, toolResult(out.text ?? '', out.structured ?? null, out.isError ?? false, out.extraContent)) };
    }
    default:
      return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `Unknown method: ${method}`) };
  }
}


function bearerToken(req) {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

function tokenMatches(presented, expected) {
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && a.equals(b);
}


async function handleMcpPost(req, expectedToken, trackChild) {
  if (!tokenMatches(bearerToken(req), expectedToken)) {
    return new Response('missing or invalid bearer token', { status: 401 });
  }
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return new Response('request body too large', { status: 413 });
  }
  let raw;
  try {
    raw = await req.text();
  } catch {
    return jsonResponse(rpcError(null, PARSE_ERROR, 'Could not read request body'));
  }
  if (raw.length > MAX_BODY_BYTES) return new Response('request body too large', { status: 413 });
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return jsonResponse(rpcError(null, PARSE_ERROR, 'Invalid JSON'));
  }
  try {
    const { status, body } = await dispatchRpc(message, trackChild);
    return jsonResponse(body, status);
  } catch (err) {
    const id = message && typeof message === 'object' && !Array.isArray(message) ? message.id ?? null : null;
    if (id === null || id === undefined) return new Response(null, { status: 202 });
    return jsonResponse(rpcError(id, INTERNAL_ERROR, `Internal error: ${String(err?.message ?? err)}`));
  }
}


export function startExecd({
  port = Number(process.env.PORT) || DEFAULT_GUEST_PORT,
  hostname = '0.0.0.0',
  token = process.env.CUA_ENV_TOKEN ?? '',
} = {}) {
  const activePids = new Set();
  const trackChild = (pid, { remove = false } = {}) => {
    if (remove) activePids.delete(pid);
    else activePids.add(pid);
  };
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/healthz' && req.method === 'GET') {
        return jsonResponse({ ok: true, service: 'execd' });
      }
      if (url.pathname !== '/mcp') {
        return jsonResponse({ error: { code: 'not_found', message: `No such endpoint: ${url.pathname}` } }, 404);
      }
      if (req.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
      }
      return handleMcpPost(req, token, trackChild);
    },
  });
  const stop = () => {
    for (const pid of activePids) killProcessGroup(pid);
    activePids.clear();
    server.stop(true);
  };
  return { port: server.port, stop };
}



function parseArgs(argv = process.argv) {
  return { stdio: argv.includes('--stdio') || process.env.EXECD_TRANSPORT === 'stdio' };
}


const STDIO_MAX_IN_FLIGHT = 8;


export function startExecdStdio({ token: _ignoredToken, tmpdir: _ignoredTmpdir } = {}) {
  const activePids = new Set();
  const trackChild = (pid, { remove = false } = {}) => {
    if (remove) activePids.delete(pid);
    else activePids.add(pid);
  };
  let stopped = false;

  async function handleLine(text) {
    if (typeof text !== 'string') return null;
    if (text.trim() === '') return null;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return `${JSON.stringify(rpcError(null, PARSE_ERROR, 'Invalid JSON'))}\n`;
    }
    try {
      const { status, body } = await dispatchRpc(message, trackChild);
      if (status === 202 || body === null) return null;
      return `${JSON.stringify(body)}\n`;
    } catch (err) {
      const id = message && typeof message === 'object' && !Array.isArray(message) ? message.id ?? null : null;
      if (id === null || id === undefined) return null;
      return `${JSON.stringify(rpcError(id, INTERNAL_ERROR, `Internal error: ${String(err?.message ?? err)}`))}\n`;
    }
  }


  async function run() {
    console.error('[execd] stdio mode — newline-delimited JSON-RPC on stdin/stdout');
    let finished = false;
    const pending = [];
    let inFlight = 0;

    const writeLine = (line) => {
      if (stopped || finished || line === null || line === undefined) return;
      try {
        process.stdout.write(line);
        process.stdout.flush?.();
      } catch {
      }
    };

    const shutdown = (why) => {
      if (finished) return;
      finished = true;
      stop();
      console.error(`[execd] ${why} — stopping (active children group-killed)`);
      try { process.stdout.flush?.(); } catch { }
      process.exit(0);
    };

    const pump = () => {
      while (!stopped && !finished && pending.length > 0 && inFlight < STDIO_MAX_IN_FLIGHT) {
        dispatchLine(pending.shift());
      }
    };
    const settle = () => {
      inFlight--;
      pump();
    };
    const dispatchLine = (lineText) => {
      inFlight++;
      handleLine(lineText)
        .then(writeLine)
        .catch(() => {})
        .finally(settle);
    };
    const onLine = (lineText) => {
      if (stopped || finished) return;
      if (inFlight >= STDIO_MAX_IN_FLIGHT) {
        pending.push(lineText);
        return;
      }
      dispatchLine(lineText);
    };

    const decoder = new TextDecoder();
    let carry = '';
    const feedBytes = (bytes) => {
      carry += decoder.decode(bytes, { stream: true });
      for (;;) {
        const nl = carry.indexOf('\n');
        if (nl === -1) break;
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line.trim() !== '') onLine(line);
      }
    };

    try {
      for await (const chunk of Bun.stdin.stream()) {
        feedBytes(chunk);
        if (finished) return;
      }
      if (carry.trim() !== '') {
        console.error(`[execd] stdio: discarding ${Buffer.byteLength(carry, 'utf8')}-byte partial trailing line at EOF`);
      }
      shutdown('stdin EOF');
    } catch (err) {
      console.error(`[execd] stdin error: ${String(err?.message ?? err)} — stopping`);
      shutdown('stdin error');
    }
  }

  const stop = () => {
    stopped = true;
    for (const pid of activePids) killProcessGroup(pid);
    activePids.clear();
  };

  return { handleLine, run, stop };
}


if (import.meta.main) {
  if (parseArgs().stdio) {
    const session = startExecdStdio();
    const shutdown = (signal) => {
      console.error(`[execd] ${signal} — stopping (active children group-killed)`);
      session.stop();
      try { process.stdout.flush?.(); } catch { }
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    void session.run();
  } else {
    const port = Number(process.env.PORT) || DEFAULT_GUEST_PORT;
    if (!process.env.CUA_ENV_TOKEN) {
      console.error('[execd] warning: CUA_ENV_TOKEN not set — every /mcp request will 401 (fail-closed)');
    }
    const instance = startExecd({ port });
    console.error(`[execd] listening on 0.0.0.0:${instance.port} (POST /mcp, GET /healthz)`);
    const shutdown = (signal) => {
      console.error(`[execd] ${signal} — stopping (active children group-killed)`);
      instance.stop();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}
