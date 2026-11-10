#!/usr/bin/env bun
/**
 * execd — guest exec MCP server for sandbox2 (contract: web/docs/execd-contract.md).
 *
 * THREE tools — `bash`, `read`, `write` — with pi-harness semantics
 * (pi-coding-agent dist/core/tools/{bash,read,write}.js — semantics copied,
 * not code). TWO transports, one dispatch (contract: web/docs/execd-contract.md):
 *
 * Streamable-HTTP (default): JSON-RPC at POST /mcp, plain-JSON responses,
 * stateless (no session ids):
 *
 *   initialize                   → protocolVersion 2025-03-26, serverInfo execd 0.2.0
 *   notifications/initialized    → 202, empty
 *   tools/list                   → exactly [bash, read, write]
 *   tools/call                   → tool result (or JSON-RPC error, see below)
 *   GET /healthz                 → 200 {ok:true,service:'execd'}
 *
 * stdio (0.2 — `--stdio` flag or EXECD_TRANSPORT=stdio): the SAME dispatch
 * over newline-delimited JSON-RPC on stdin/stdout (one COMPLETE line in, one
 * JSON.stringify(body)+'\n' line out, notifications silent, ≤8 in flight with
 * a FIFO queue, no auth — the pipe is the trust boundary, EOF → stop → exit 0,
 * logs on stderr only). Lets the HOST spawn execd as its own child for HOST
 * agent stages — no ports, no token, no daemon lifecycle.
 *
 * Auth: Authorization: Bearer <CUA_ENV_TOKEN> — 401 "missing or invalid bearer
 * token" otherwise (fail-closed: no token configured → every /mcp request
 * 401s). JSON-RPC level: unknown tool → -32601, missing/malformed params →
 * -32602, everything else answers as a result — every request answers, never
 * hangs. Transport-level: GET /mcp → 405 (POST-only), unknown path → 404.
 *
 * Bound 0.0.0.0:3213 in-guest (PORT env override for tests). Started by
 * desktop/entrypoint.sh as the `desktop` user with the session env.
 */
import { constants } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { access, mkdir, open as fsOpen, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as osConstants, homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePathPosix } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'execd', version: '0.2.0' };
const DEFAULT_GUEST_PORT = 3213;
const DEFAULT_CWD = '/home/desktop';

// pi bash parity: MAX_TIMEOUT_MS = 2^31-1 (setTimeout ceiling).
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000; // 2147483.647

// pi truncate.js defaults: whichever limit is hit first wins.
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024; // 50KB
// structuredContent.output budget for programmatic callers (pi STRUCTURED_OUTPUT_MAX_BYTES).
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const MAX_BODY_BYTES = 1024 * 1024;

// ── Small JSON helpers ───────────────────────────────────────────────────────

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

// ── pi truncate.js semantics (ported: behavior, not code) ────────────────────

/** pi splitLinesForCounting: a trailing newline does not start a new line. */
function splitLinesForCounting(content) {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

/** pi truncate.js formatSize: bytes → "N B"/"N.NKB"/"N.NMB". */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * pi truncateHead: keep the FIRST N lines/bytes (file reads — you want the
 * beginning). Never returns partial lines; if the first line alone exceeds the
 * byte limit, returns empty content with firstLineExceedsLimit=true (the read
 * tool points the model at a bash fallback instead).
 */
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
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (i > 0 ? 1 : 0); // +1 for newline
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }
  // If we exited due to line limit
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) truncatedBy = 'lines';
  const outputContent = outputLinesArr.join('\n');
  return {
    content: outputContent, truncated: true, truncatedBy, totalLines, totalBytes,
    outputLines: outputLinesArr.length, outputBytes: Buffer.byteLength(outputContent, 'utf-8'),
    firstLineExceedsLimit: false,
  };
}

// ── pi path-utils.js semantics (ported: behavior, not code) ─────────────────

// pi paths.js UNICODE_SPACES: non-breaking + typographic spaces normalize to a plain space.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = '\u202F';

/**
 * pi resolveToCwd: unicode-space normalize, @-prefix strip, ~ / ~/… expansion
 * (the execd process's homedir — the desktop user in-guest), file:// URL
 * conversion, then resolve against the base dir. NO realpath (resolved ≠
 * physical). Windows drive-path rewriting is n/a (guest is linux).
 */
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

// macOS read-variant fallbacks (pi path-utils.js, in pi's order).
function tryMacOSScreenshotPath(filePath) {
  return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}
function tryNFDVariant(filePath) {
  return filePath.normalize('NFD');
}
function tryCurlyQuoteVariant(filePath) {
  return filePath.replace(/'/g, '\u2019');
}

/**
 * pi resolveReadPathAsync: resolved path first; when missing, the macOS
 * variants in pi's order (AM/PM narrow-no-break-space, NFD, curly quote,
 * NFD+curly); else the resolved path (the eventual error names it).
 */
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

// ── Image magic detection (v0: pi mime.js signatures, magic bytes only) ─────

/**
 * Magic-byte sniff of a buffer head. v0 skips pi's fuller validations (IHDR
 * chunk checks, BMP header fields, APNG acTL scan): a text file beginning
 * "BM" is misdetected as image/bmp — documented contract cost.
 */
function detectImageMimeType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.subarray(0, 6).toString('latin1') === 'GIF87a' || buffer.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp';
  return null;
}

/**
 * pi truncateMiddle: keep head+tail halves of `maxBytes` each around a
 * `…N chars truncated…` elision marker. Cuts only at UTF-8 character
 * boundaries. N counts characters (code units) of the elided middle.
 */
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

// ── Output accumulator (pi output-accumulator.js semantics, bounded memory) ─

/**
 * Tracks combined stdout+stderr in arrival order. Keeps a bounded decoded tail
 * window for the display view; the FULL raw byte stream spills to a temp file
 * as soon as any display limit is exceeded (pi parity), so nothing outlives
 * memory that the caller cannot recover from disk.
 */
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
    this.droppedHeadChars = 0; // chars lost off the front by rolling-window trims
    this.finished = false;
    this.tempFilePath = null;
    this.tempFileStream = null;
  }

  append(data) {
    if (this.finished) return; // defensive: late chunks after finalize are dropped
    this.totalRawBytes += data.length;
    this.appendDecoded(this.decoder.decode(data, { stream: true }));
    if (this.tempFileStream || this.shouldUseTempFile()) this.ensureTempFile();
    if (this.tempFileStream) this.tempFileStream.write(data);
    else if (data.length > 0) this.rawChunks.push(data);
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.appendDecoded(this.decoder.decode()); // flush the streaming decoder
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

  /** Drop the head of the tail window at a UTF-8 boundary, counting what went. */
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

  /** Tail window aligned to a line boundary (drop a torn first line). */
  snapshotText() {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf('\n');
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  /** Display truncation = either pi limit hit (drives `truncated`/full_output_path). */
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
    this.tempFileStream.on('error', () => {}); // best-effort: never crash the server on fs errors
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

  /**
   * Full output for programmatic callers (pi readFullOutput semantics): whole
   * content up to `maxBytes`; beyond that head+tail halves around a
   * `[... N bytes omitted ...]` marker.
   */
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

// ── Child-process wait (pi waitForChildProcess semantics, adapted) ───────────

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for the child to terminate AND its pipes to fall idle, without hanging
 * on stdio handles inherited by detached descendants (pi #5303): after `exit`
 * the pipes are drained until they end or go quiet for the grace period; then
 * streams are destroyed. A spawn-level failure resolves (never rejects) so the
 * HTTP request always answers.
 */
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
      if (exited && !settled) armIdleTimer(); // a descendant is still writing — keep draining
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

/** SIGKILL the child's whole process group (pi killProcessTree, unix branch). */
function killProcessGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead
    }
  }
}

// ── The bash tool (pi parity) ───────────────────────────────────────────────

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

function toolResult(text, structured, isError) {
  const result = { content: [{ type: 'text', text }], structuredContent: structured, isError };
  if (structured === null) delete result.structuredContent;
  return result;
}

/**
 * Default cwd chain (0.2): args.cwd → EXECD_DEFAULT_CWD → os.homedir() →
 * /home/desktop. Host-honest: AJCS sets EXECD_DEFAULT_CWD; a bare
 * host-spawned stdio process falls back to the spawning user's home. In the
 * guest the homedir rung IS /home/desktop — guest behavior unchanged.
 */
function resolveCwd(args) {
  return args.cwd ?? (process.env.EXECD_DEFAULT_CWD || homedir() || DEFAULT_CWD);
}

/**
 * Validate bash args (missing/malformed → -32602, pi's messages where they
 * overlap). Returns {args} or {code, message}.
 */
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

/** Tool registry: name → validator + runner. */
const TOOL_REGISTRY = {
  bash: { validate: validateBashArgs },
  read: { validate: validateReadArgs },
  write: { validate: validateWriteArgs },
};

/**
 * Validate tools/call params (missing/malformed → -32602, unknown tool →
 * -32601 via {unknownTool}). Returns {name, args} or {code, message} or
 * {unknownTool}.
 */
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

/**
 * Execute one bash command with pi semantics: one-shot spawn, detached group
 * leader, optional per-call timeout (group SIGKILL on expiry), interleaved
 * output, bounded view + full temp file, verbatim exit codes (128+sig).
 */
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
    detached: true, // child leads its own process group — the whole group is killable
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
  // Killed by a signal (timeout SIGKILL or self-kill): shell convention 128+signal.
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

// ── The read tool (pi parity) ────────────────────────────────────────────━

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

/** pi read.js text path: offset/limit window → truncateHead → continuation notices. */
async function runRead(args) {
  const cwd = resolveCwd({}); // read/write have no cwd arg — the bash default-cwd rule applies
  const absolutePath = await resolveReadPath(args.path, cwd);
  try {
    await access(absolutePath, constants.R_OK);
    const buffer = await readFile(absolutePath);
    const size = buffer.length;
    const mimeType = detectImageMimeType(buffer);
    if (mimeType) {
      // v0: NO image processing (no photon in execd) — text note only.
      return {
        isError: false,
        text: `Read image file [${mimeType}] — binary image preview not supported by execd read v0 `
          + `(${size} bytes). Use bash (e.g. base64/file) if you need its bytes.`,
        structured: { path: absolutePath, total_lines: 0, truncated: false, size_bytes: size },
      };
    }
    const textContent = buffer.toString('utf-8');
    const allLines = textContent.split('\n'); // pi arithmetic: a trailing newline adds a phantom last element
    const totalFileLines = allLines.length;
    const startLine = args.offset ? Math.max(0, args.offset - 1) : 0;
    const startLineDisplay = startLine + 1;
    if (startLine >= allLines.length) {
      return { isError: true, text: `Offset ${args.offset} is beyond end of file (${allLines.length} lines total)` };
    }
    let selectedContent;
    let userLimitedLines;
    // User limit is honored first; otherwise truncateHead decides.
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
      // First line alone exceeds the byte limit — point the model at a bash fallback.
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
      // User-specified limit stopped early, but the file still has more content.
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
    // Contract: failures carry the RAW error message, no structuredContent.
    return { isError: true, text: String(err?.message ?? err) };
  }
}

/** Validate read args (missing/malformed → -32602). */
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

// ── The write tool (pi parity) ───────────────────────────────────────────────

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

// ── Per-path mutation queue (pi file-mutation-queue.js semantics) ────────────

const fileMutationQueues = new Map();
let registrationQueue = Promise.resolve();

function isMissingPathError(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** Queue key: the physical path when it exists, else the resolved path. */
async function getMutationQueueKey(filePath) {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return filePath;
    throw error;
  }
}

/**
 * Serialize file mutations targeting the same file; different files run in
 * parallel. Registrations themselves are serialized (global registration
 * queue) so queue chaining is race-free; a failing fn releases the queue.
 */
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

/**
 * pi write.js semantics: resolveToCwd (NO read variants), mkdir -p parent,
 * overwrite always, same-path writes serialized by the mutation queue.
 */
async function runWrite(args) {
  const cwd = resolveCwd({}); // write has no cwd arg — the bash default-cwd rule applies
  const absolutePath = resolveToCwd(args.path, cwd);
  const dir = dirname(absolutePath);
  return withFileMutationQueue(absolutePath, async () => {
    const createdDirs = await mkdir(dir, { recursive: true }); // first created path, or undefined if it existed
    await writeFile(absolutePath, args.content, 'utf-8');
    return {
      isError: false,
      text: `Successfully wrote to ${args.path}`, // pi wording: the ORIGINAL path arg
      structured: {
        path: absolutePath,
        bytes_written: Buffer.byteLength(args.content, 'utf-8'),
        created_dirs: createdDirs !== undefined,
      },
    };
  }).catch((err) => ({ isError: true, text: String(err?.message ?? err) }));
}

/** Validate write args (missing/malformed → -32602). */
function validateWriteArgs(args) {
  if (typeof args.path !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "path" is required and must be a string' };
  }
  if (typeof args.content !== 'string') {
    return { code: INVALID_PARAMS, message: 'Invalid params: "content" is required and must be a string' };
  }
  return { args: { path: args.path, content: args.content } };
}

// ── JSON-RPC dispatch ────────────────────────────────────────────────────────

function handleInitialize() {
  return rpcResult(null, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: 'Three tools: bash, read, write — one-shot shell execution and file primitives '
      + 'in the sandbox (pi-harness semantics). Stateless server: perform the initialize handshake per request.',
  }).result;
}

/**
 * Handle one decoded JSON-RPC message. Returns {status, body} where body null
 * means an empty 202 (notifications). Every request answers.
 */
async function dispatchRpc(message, trackChild) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0'
    || typeof message.method !== 'string') {
    return { status: 200, body: rpcError(null, INVALID_REQUEST, 'Invalid JSON-RPC request') };
  }
  const { id, method, params } = message;
  if (id === null || id === undefined) return { status: 202, body: null }; // notification → 202 empty
  switch (method) {
    case 'initialize':
      // Stateless per-request handshake: always answer, never wedge (params are
      // the caller's affair — we advertise our own protocol version).
      return { status: 200, body: rpcResult(id, handleInitialize()) };
    case 'notifications/initialized':
      return { status: 202, body: null };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: [BASH_TOOL, READ_TOOL, WRITE_TOOL] }) };
    case 'tools/call': {
      const checked = validateToolCallParams(params);
      if (checked.unknownTool) {
        return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `Unknown tool: ${checked.unknownTool}`) };
      }
      if (checked.code) return { status: 200, body: rpcError(id, checked.code, checked.message) };
      const out = checked.name === 'bash'
        ? await runBash(checked.args, trackChild)
        : checked.name === 'read'
          ? await runRead(checked.args)
          : await runWrite(checked.args);
      return { status: 200, body: rpcResult(id, toolResult(out.text, out.structured ?? null, out.isError)) };
    }
    default:
      return { status: 200, body: rpcError(id, METHOD_NOT_FOUND, `Unknown method: ${method}`) };
  }
}

// ── HTTP surface ─────────────────────────────────────────────────────────────

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

/** One POST /mcp request: auth → parse → dispatch → plain-JSON reply. */
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
    // A crashing handler must still answer (contract: never a hung request).
    const id = message && typeof message === 'object' && !Array.isArray(message) ? message.id ?? null : null;
    if (id === null || id === undefined) return new Response(null, { status: 202 });
    return jsonResponse(rpcError(id, INTERNAL_ERROR, `Internal error: ${String(err?.message ?? err)}`));
  }
}

/**
 * Start execd. Returns { port, stop } — stop() closes the listener and
 * group-kills any still-running children (best-effort; the container teardown
 * kills everything anyway).
 */
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
    idleTimeout: 0, // long silent tool calls must not be dropped mid-flight
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

// ── stdio transport (0.2 — HOST agent stages spawn execd as their own child) ─

/**
 * Stdio activation: `--stdio` argv flag OR `EXECD_TRANSPORT=stdio`. Anything
 * else (no flag, other env values, other argv) → HTTP mode, byte-identical
 * to before. Deliberately dumb — this is the ONLY new activation surface.
 */
function parseArgs(argv = process.argv) {
  return { stdio: argv.includes('--stdio') || process.env.EXECD_TRANSPORT === 'stdio' };
}

/** Bounded dispatch: at most this many tools/calls executing at once; the
 * rest queue FIFO in the stdin loop (an unbounded task pileup is a footgun). */
const STDIO_MAX_IN_FLIGHT = 8;

/**
 * Start the stdio transport WITHOUT owning a pipe. Returns { handleLine, run,
 * stop }: `handleLine(text) → Promise<string|null>` is the per-line dispatcher
 * the real loop uses — tests drive it directly (no child process needed);
 * `run()` pins the true stdin/stdout pipe for the real boot; `stop()`
 * group-kills any tracked children. Same dispatchRpc + tool registry as HTTP —
 * ZERO tool-semantics duplication.
 *
 * handleLine semantics (one COMPLETE JSON-RPC line, trailing newline optional
 * — JSON.parse tolerates trailing whitespace):
 *   → the response line to write to stdout: `JSON.stringify(body)` + '\n'
 *     (the one-line-response invariant: exactly one '\n', terminal), or
 *   → null when the message produces NO output at all: notifications
 *     (notification-silence invariant) and blank/whitespace-only lines.
 * Options { token, tmpdir } are accepted for call-site symmetry with
 * startExecd and deliberately ignored (no auth in stdio mode; bash temp
 * files keep honoring EXECD_TMPDIR).
 */
export function startExecdStdio({ token: _ignoredToken, tmpdir: _ignoredTmpdir } = {}) {
  const activePids = new Set();
  const trackChild = (pid, { remove = false } = {}) => {
    if (remove) activePids.delete(pid);
    else activePids.add(pid);
  };
  let stopped = false;

  async function handleLine(text) {
    if (typeof text !== 'string') return null;
    if (text.trim() === '') return null; // blank lines skipped silently
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return `${JSON.stringify(rpcError(null, PARSE_ERROR, 'Invalid JSON'))}\n`;
    }
    try {
      const { status, body } = await dispatchRpc(message, trackChild);
      if (status === 202 || body === null) return null; // notification → NO output at all
      return `${JSON.stringify(body)}\n`; // exactly one '\n', terminal
    } catch (err) {
      // A crashing handler must still answer (the pipe must never hang).
      const id = message && typeof message === 'object' && !Array.isArray(message) ? message.id ?? null : null;
      if (id === null || id === undefined) return null; // notification crash → silence (the 202 analog)
      return `${JSON.stringify(rpcError(id, INTERNAL_ERROR, `Internal error: ${String(err?.message ?? err)}`))}\n`;
    }
  }

  /**
   * The real stdin loop. Strict-JSONL framing: complete ('\n'-terminated)
   * lines only — a partial trailing line waits for the rest and is discarded
   * at EOF (never emitted). Dispatch is asynchronous with the ≤8-in-flight
   * FIFO cap; each response is written when its own result settles (the
   * JSON-RPC id pairs everything — interleaved completion order is legal).
   * EOF → stop() (group-kills tracked children) → exit 0. Logs: stderr only.
   */
  async function run() {
    console.error('[execd] stdio mode — newline-delimited JSON-RPC on stdin/stdout');
    let finished = false;
    const pending = []; // FIFO of complete lines beyond the in-flight cap
    let inFlight = 0;

    const writeLine = (line) => {
      if (stopped || finished || line === null || line === undefined) return;
      try {
        process.stdout.write(line);
        process.stdout.flush?.(); // Bun FileSink — deliver even if exit follows close behind
      } catch {
        // reader vanished mid-write — EOF/exit follows anyway
      }
    };

    const shutdown = (why) => {
      if (finished) return;
      finished = true;
      stop(); // group-kill any tracked children
      console.error(`[execd] ${why} — stopping (active children group-killed)`);
      try { process.stdout.flush?.(); } catch { /* nothing left to do */ }
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
        .catch(() => {}) // handleLine is total (catches its own handler crashes); belt-and-braces
        .finally(settle);
    };
    const onLine = (lineText) => {
      if (stopped || finished) return;
      if (inFlight >= STDIO_MAX_IN_FLIGHT) {
        pending.push(lineText); // queue FIFO beyond the cap
        return;
      }
      dispatchLine(lineText);
    };

    // Decode stdin byte-chunks into complete lines. '\n' (0x0A) never occurs
    // inside a multi-byte UTF-8 sequence, so splitting the streamed-decoded
    // text on '\n' is byte-safe.
    const decoder = new TextDecoder();
    let carry = '';
    const feedBytes = (bytes) => {
      carry += decoder.decode(bytes, { stream: true });
      for (;;) {
        const nl = carry.indexOf('\n');
        if (nl === -1) break;
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line.trim() !== '') onLine(line); // blank lines skipped silently
      }
    };

    try {
      for await (const chunk of Bun.stdin.stream()) {
        feedBytes(chunk);
        if (finished) return; // a signal handler already shut us down
      }
      if (carry.trim() !== '') {
        // A partial trailing line waits for the rest of the line; at EOF it is
        // discarded — incomplete input never emits.
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

// ── Main boot (in-guest: bun /opt/execd/index.mjs) ───────────────────────────

if (import.meta.main) {
  if (parseArgs().stdio) {
    // stdio: no ports, no token warning, no HTTP listener. Same shutdown as HTTP.
    const session = startExecdStdio();
    const shutdown = (signal) => {
      console.error(`[execd] ${signal} — stopping (active children group-killed)`);
      session.stop();
      try { process.stdout.flush?.(); } catch { /* nothing left to do */ }
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    void session.run(); // owns the lifecycle: EOF → stop → exit 0
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
