/**
 * execd unit tests — fully hermetic (web/docs/execd-contract.md §Testing).
 *
 * No real containers, no /home/desktop dependency: the server is started
 * in-process on an ephemeral loopback port with a test bearer token and driven
 * with plain fetch. The live smoke (real image + real sandbox) is a separate
 * plain-bun script — NEVER inside bun test (see the busy-wait open issue in
 * web/docs/mcp-driver-contract.md).
 *
 * Run: cd desktop/execd && bun test
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync, statSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { startExecd, startExecdStdio } from '../index.mjs';

const TOKEN = `test-token-${Date.now().toString(36)}`;
let inst;

beforeAll(() => {
  delete process.env.EXECD_DEFAULT_CWD; // tests control the cwd default explicitly
  inst = startExecd({ port: 0, token: TOKEN });
});

afterAll(() => {
  inst?.stop();
  delete process.env.EXECD_DEFAULT_CWD;
});

// ── Client helpers (mirror the mcp-driver's client shape) ────────────────────

function mcpHeaders(token) {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token === undefined ? { authorization: `Bearer ${TOKEN}` } : token === null ? {} : { authorization: `Bearer ${token}` }),
  };
}

async function mcpPost(message, { token, headers = mcpHeaders(token) } = {}) {
  return fetch(`http://127.0.0.1:${inst.port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });
}

let nextId = 1;
async function rpc(method, params, opts) {
  const res = await mcpPost({ jsonrpc: '2.0', id: nextId++, method, params }, opts);
  const bodyText = await res.text();
  return { res, bodyText, body: bodyText ? JSON.parse(bodyText) : null };
}

/** Full stateless handshake + tools/call, the way the mcp-driver speaks. */
async function callTool(name, args, opts) {
  const id = nextId++;
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'execd-test' } }, opts);
  await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, opts);
  const res = await mcpPost({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, opts);
  const bodyText = await res.text();
  return { res, bodyText, body: bodyText ? JSON.parse(bodyText) : null };
}

const callBash = (args, opts) => callTool('bash', args, opts);
const callRead = (args, opts) => callTool('read', args, opts);
const callWrite = (args, opts) => callTool('write', args, opts);

const WORKDIR = mkdtempSync(join(tmpdir(), 'execd-test-'));

// ── Transport & auth ─────────────────────────────────────────────────────────

describe('auth', () => {
  test('401 with no token', async () => {
    const res = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('missing or invalid bearer token');
  });

  test('401 with a wrong token', async () => {
    const res = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'wrong-token' });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('missing or invalid bearer token');
  });

  test('GET /healthz is unauthenticated and answers the fixed shape', async () => {
    const res = await fetch(`http://127.0.0.1:${inst.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'execd' });
  });

  test('GET /mcp is 405 (POST-only transport)', async () => {
    const res = await fetch(`http://127.0.0.1:${inst.port}/mcp`, { headers: mcpHeaders(TOKEN) });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

// ── MCP handshake subset ─────────────────────────────────────────────────────

describe('mcp subset', () => {
  test('initialize → serverInfo execd 0.2.0, protocolVersion 2025-03-26, three-tool instructions', async () => {
    const { res, body } = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'execd-test' } });
    expect(res.status).toBe(200);
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.serverInfo).toEqual({ name: 'execd', version: '0.2.0' });
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toContain('Three tools: bash, read, write');
    expect(body.result.instructions).toContain('Stateless server: perform the initialize handshake per request.');
  });

  test('notifications/initialized → 202 empty body', async () => {
    const res = await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('tools/list → exactly [bash, read, write], bash keeps index 0, schemas intact', async () => {
    const { res, body } = await rpc('tools/list');
    expect(res.status).toBe(200);
    expect(body.result.tools.map((t) => t.name)).toEqual(['bash', 'read', 'write']);
    const [bash, read, write] = body.result.tools;
    expect(bash.inputSchema.required).toEqual(['command']);
    expect(bash.inputSchema.properties.command.type).toBe('string');
    expect(read.inputSchema.required).toEqual(['path']);
    expect(read.inputSchema.properties.path.description).toBe('Path to the file to read (relative or absolute)');
    expect(read.inputSchema.properties.offset.description).toBe('Line number to start reading from (1-indexed)');
    expect(read.inputSchema.properties.limit.description).toBe('Maximum number of lines to read');
    expect(write.inputSchema.required).toEqual(['path', 'content']);
    expect(write.inputSchema.properties.path.description).toBe('Path to the file to write (relative or absolute)');
    expect(write.inputSchema.properties.content.description).toBe('Content to write to the file');
  });

  test('unknown method → JSON-RPC -32601', async () => {
    const { body } = await rpc('driver/bogus');
    expect(body.error.code).toBe(-32601);
  });
});

// ── bash tool ────────────────────────────────────────────────────────────────

describe('bash tool', () => {
  test('happy path: echo + date output, exit_code 0, stderr interleaved', async () => {
    const { res, body } = await callBash(
      { command: 'echo hello-from-execd; echo err-line 1>&2; date -u', cwd: WORKDIR },
    );
    expect(res.status).toBe(200);
    const result = body.result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent.exit_code).toBe(0);
    expect(result.structuredContent.truncated).toBe(false);
    expect(result.structuredContent.full_output_path).toBeUndefined();
    expect(result.structuredContent.wall_time_seconds).toBeGreaterThanOrEqual(0);
    expect(result.structuredContent.output).toContain('hello-from-execd');
    expect(result.structuredContent.output).toContain('err-line'); // stderr is captured
    expect(result.structuredContent.output).toMatch(/\d{2}:\d{2}:\d{2}/); // date -u ran (BSD/GNU output both carry a timestamp)
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe(result.structuredContent.output); // untruncated view = full output
  });

  test('non-zero exit → isError + "Command exited with code N"', async () => {
    const { body } = await callBash({ command: 'echo before-fail; exit 3', cwd: WORKDIR });
    const result = body.result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.exit_code).toBe(3);
    expect(result.content[0].text).toContain('Command exited with code 3');
    expect(result.content[0].text).toContain('before-fail'); // partial output included
  });

  test('signal death → exit_code 128+9=137, isError', async () => {
    const { body } = await callBash({ command: 'kill -9 $$', cwd: WORKDIR });
    const result = body.result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.exit_code).toBe(137);
  });

  test('timeout group-kills: sleep 30 with timeout:1 answers <3s, process gone', async () => {
    const t0 = Date.now();
    const { body } = await callBash({ command: 'sleep 30 && echo never', timeout: 1, cwd: WORKDIR });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3000);
    const result = body.result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.exit_code).toBe(137); // SIGKILL = 128+9
    expect(result.structuredContent.wall_time_seconds).toBeLessThan(3);
    expect(result.content[0].text).toContain('Command timed out after 1 seconds');
    // Whole process group is gone: pgrep finds no `sleep 30` (1 = no match; skip if pgrep missing).
    const pgrep = Bun.spawnSync(['pgrep', '-f', 'sleep 30']);
    if (pgrep.exitCode === 127) {
      console.warn('pgrep not available — skipping group-kill assertion');
    } else {
      expect(pgrep.stdout.toString().trim()).toBe('');
      expect(pgrep.exitCode).toBe(1);
    }
  }, 15000);

  test('truncation: ~120KB output → truncated, marker, full temp file with matching length', async () => {
    const { body } = await callBash({ command: 'seq 1 22000', cwd: WORKDIR });
    const result = body.result;
    const s = result.structuredContent;
    expect(s.truncated).toBe(true);
    expect(typeof s.full_output_path).toBe('string');
    expect(existsSync(s.full_output_path)).toBe(true);
    const fullBytes = statSync(s.full_output_path).size;
    expect(fullBytes).toBe(Buffer.byteLength(s.output, 'utf8')); // file holds the FULL output
    expect(fullBytes).toBeGreaterThan(100 * 1024); // ~120KB
    expect(s.output.endsWith('22000\n')).toBe(true); // structured output is the full text (≤1MiB)
    const view = result.content[0].text;
    expect(view).toContain('chars truncated'); // elision marker present
    expect(view).toContain(`[Full output: ${s.full_output_path}]`);
    expect(view).toContain('22000'); // tail of the output is visible
    expect(view.length).toBeLessThan(64 * 1024); // bounded view
    rmSync(s.full_output_path); // test hygiene
  }, 15000);

  test('cwd default comes from EXECD_DEFAULT_CWD', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'execd-cwd-'));
    process.env.EXECD_DEFAULT_CWD = dir;
    try {
      const { body } = await callBash({ command: 'pwd' });
      expect(body.result.isError).toBe(false);
      // realpath: macOS /tmp is a symlink to /private/tmp — bash reports the physical path.
      expect(body.result.structuredContent.output).toBe(`${realpathSync(dir)}\n`);
    } finally {
      delete process.env.EXECD_DEFAULT_CWD;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explicit cwd overrides the default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'execd-cwd2-'));
    try {
      const { body } = await callBash({ command: 'pwd', cwd: dir });
      expect(body.result.structuredContent.output).toBe(`${realpathSync(dir)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing cwd → clean tool error, never a JSON-RPC error', async () => {
    const bogus = join(tmpdir(), 'nonexistent-execd-cwd-probe');
    const { res, body } = await callBash({ command: 'echo hi', cwd: bogus });
    expect(res.status).toBe(200); // the CALL succeeded; the TOOL errored
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain(`Working directory does not exist: ${bogus}`);
  });
});

// ── read tool (pi parity) ────────────────────────────────────────────────────

describe('read tool', () => {
  test('full file: exact text, structured shape, no truncation', async () => {
    const file = join(WORKDIR, 'read-full.txt');
    writeFileSync(file, 'alpha\nbeta\ngamma\n');
    const { res, body } = await callRead({ path: file });
    expect(res.status).toBe(200);
    const result = body.result;
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('alpha\nbeta\ngamma\n');
    // pi arithmetic: a trailing newline contributes a phantom split element.
    expect(result.structuredContent).toEqual({
      path: resolvePath(file), total_lines: 4, truncated: false, size_bytes: 17,
    });
  });

  test('offset+limit window + user-limit continuation notice (exact format)', async () => {
    const file = join(WORKDIR, 'read-window.txt');
    writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join('\n'));
    const { body } = await callRead({ path: file, offset: 3, limit: 2 });
    const result = body.result;
    expect(result.isError).toBe(false);
    expect(result.content[0].text)
      .toBe('line-3\nline-4\n\n[6 more lines in file. Use offset=5 to continue.]');
    expect(result.structuredContent.truncated).toBe(false);
    expect(result.structuredContent.total_lines).toBe(10);
  });

  test('limit ending exactly at EOF → no continuation notice', async () => {
    const file = join(WORKDIR, 'read-window2.txt');
    writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join('\n'));
    const { body } = await callRead({ path: file, offset: 9, limit: 2 });
    expect(body.result.content[0].text).toBe('line-9\nline-10');
  });

  test('line truncation: >2000 lines → exact lines notice', async () => {
    const file = join(WORKDIR, 'read-many-lines.txt');
    writeFileSync(file, Array.from({ length: 2100 }, (_, i) => `line-${i + 1}`).join('\n'));
    const { body } = await callRead({ path: file });
    const result = body.result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent.truncated).toBe(true);
    expect(result.structuredContent.total_lines).toBe(2100);
    const text = result.content[0].text;
    expect(text.startsWith('line-1\n')).toBe(true);
    expect(text).toContain('line-2000');
    expect(text).not.toContain('line-2001');
    expect(text.endsWith('\n\n[Showing lines 1-2000 of 2100. Use offset=2001 to continue.]')).toBe(true);
  });

  test('byte truncation: >50KB → exact bytes notice', async () => {
    const file = join(WORKDIR, 'read-big-bytes.txt');
    writeFileSync(file, Array.from({ length: 100 }, () => 'x'.repeat(600)).join('\n'));
    const { body } = await callRead({ path: file });
    const result = body.result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent.truncated).toBe(true);
    // 85 lines × (600B + newline) = 51084B ≤ 50KB; line 86 would cross it.
    expect(result.content[0].text)
      .toContain('\n\n[Showing lines 1-85 of 100 (50.0KB limit). Use offset=86 to continue.]');
  });

  test('first line alone exceeds 50KB → exact bash-fallback notice', async () => {
    const file = join(WORKDIR, 'read-huge-line.txt');
    writeFileSync(file, 'y'.repeat(60000));
    const { body } = await callRead({ path: file });
    const result = body.result;
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe(
      `[Line 1 is 58.6KB, exceeds 50.0KB limit. Use bash: sed -n '1p' ${file} | head -c 51200]`,
    );
    expect(result.structuredContent.truncated).toBe(true);
  });

  test('offset beyond EOF → exact pi message (phantom trailing-newline element counts)', async () => {
    const file = join(WORKDIR, 'read-offset-eof.txt');
    writeFileSync(file, 'a\nb\n'); // split('\n') → ['a','b',''] → 3
    // pi parity: offset=3 reads the phantom empty last element, no error.
    const { body: phantom } = await callRead({ path: file, offset: 3 });
    expect(phantom.result.isError).toBe(false);
    expect(phantom.result.content[0].text).toBe('');
    const { body } = await callRead({ path: file, offset: 4 });
    const result = body.result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Offset 4 is beyond end of file (3 lines total)');
    expect(result.structuredContent).toBeUndefined();
  });

  test('missing file → isError with raw ENOENT message, no structuredContent', async () => {
    const missing = join(WORKDIR, 'read-missing-probe.txt');
    const { body } = await callRead({ path: missing });
    const result = body.result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ENOENT');
    expect(result.content[0].text).toContain(missing);
    expect(result.structuredContent).toBeUndefined();
  });

  test('directory → EISDIR raw error', async () => {
    const { body } = await callRead({ path: WORKDIR });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('EISDIR');
  });

  test('unreadable file → EACCES raw error (skipped when running as root)', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads anything
    const file = join(WORKDIR, 'read-eacces.txt');
    writeFileSync(file, 'secret');
    chmodSync(file, 0o000);
    try {
      const { body } = await callRead({ path: file });
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain('EACCES');
    } finally {
      chmodSync(file, 0o644);
    }
  });

  test('image magic → v0 text note (png + bmp), isError false', async () => {
    const png = join(WORKDIR, 'read-image.png');
    const pngBuf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(10, 0x41),
    ]);
    writeFileSync(png, pngBuf);
    const { body } = await callRead({ path: png });
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0].text).toBe(
      `Read image file [image/png] — binary image preview not supported by execd read v0 (${pngBuf.length} bytes). `
      + 'Use bash (e.g. base64/file) if you need its bytes.',
    );
    expect(body.result.structuredContent).toEqual({
      path: resolvePath(png), total_lines: 0, truncated: false, size_bytes: pngBuf.length,
    });

    const bmp = join(WORKDIR, 'read-image.bmp');
    const bmpBuf = Buffer.concat([
      Buffer.from('BM', 'latin1'),
      Buffer.from([54, 0, 0, 0]), // declared file size
      Buffer.alloc(4, 0),
      Buffer.from([54, 0, 0, 0]), // pixel data offset
      Buffer.from([40, 0, 0, 0]), // DIB header size
      Buffer.alloc(12, 0),
      Buffer.from([1, 0]), // color planes
      Buffer.from([24, 0]), // bits per pixel
      Buffer.alloc(22, 0),
    ]);
    writeFileSync(bmp, bmpBuf);
    const { body: b2 } = await callRead({ path: bmp });
    expect(b2.result.isError).toBe(false);
    expect(b2.result.content[0].text).toContain('Read image file [image/bmp]');

    // Negative control: plain text (not starting with a magic signature) stays text.
    const txt = join(WORKDIR, 'read-not-image.txt');
    writeFileSync(txt, 'plain text, definitely not an image');
    const { body: b3 } = await callRead({ path: txt });
    expect(b3.result.content[0].text).toBe('plain text, definitely not an image');
  });

  test('relative path resolves against the default cwd (EXECD_DEFAULT_CWD)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'execd-read-cwd-'));
    process.env.EXECD_DEFAULT_CWD = dir;
    try {
      writeFileSync(join(dir, 'rel-read-probe.txt'), 'relative-read-ok');
      const { body } = await callRead({ path: 'rel-read-probe.txt' });
      expect(body.result.isError).toBe(false);
      expect(body.result.content[0].text).toBe('relative-read-ok');
      expect(body.result.structuredContent.path).toBe(resolvePath(dir, 'rel-read-probe.txt'));
    } finally {
      delete process.env.EXECD_DEFAULT_CWD;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('~ expands to the execd process homedir', async () => {
    const name = `execd-read-home-${Date.now().toString(36)}.txt`;
    const homeFile = join(homedir(), name);
    writeFileSync(homeFile, 'tilde-read-ok');
    try {
      const { body } = await callRead({ path: `~/${name}` });
      expect(body.result.isError).toBe(false);
      expect(body.result.content[0].text).toBe('tilde-read-ok');
      expect(body.result.structuredContent.path).toBe(homeFile);
    } finally {
      rmSync(homeFile, { force: true });
    }
  });

  test('@ prefix is stripped', async () => {
    const file = join(WORKDIR, 'read-at-prefix.txt');
    writeFileSync(file, 'at-prefix-ok');
    const { body } = await callRead({ path: `@${file}` });
    expect(body.result.content[0].text).toBe('at-prefix-ok');
  });

  test('macOS AM/PM narrow-no-break-space variant resolves (pi read variants)', async () => {
    const real = join(WORKDIR, 'shot 3.00.00\u202FPM.txt');
    writeFileSync(real, 'am-pm-variant-ok');
    const { body } = await callRead({ path: join(WORKDIR, 'shot 3.00.00 PM.txt') });
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0].text).toBe('am-pm-variant-ok');
    expect(body.result.structuredContent.path).toBe(resolvePath(real));
  });

  test('macOS curly-quote variant resolves (pi read variants)', async () => {
    const real = join(WORKDIR, 'd\u2019ecran.txt');
    writeFileSync(real, 'curly-variant-ok');
    const { body } = await callRead({ path: join(WORKDIR, "d'ecran.txt") });
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0].text).toBe('curly-variant-ok');
  });
});

// ── write tool (pi parity) ──────────────────────────────────────────────━

describe('write tool', () => {
  test('new file with auto-created parents: exact text, structured shape', async () => {
    const target = join(WORKDIR, 'write-deep', 'a', 'b', 'new.txt');
    const { body } = await callWrite({ path: target, content: 'written-content' });
    const result = body.result;
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe(`Successfully wrote to ${target}`); // pi wording, ORIGINAL arg
    expect(result.structuredContent).toEqual({
      path: resolvePath(target), bytes_written: 15, created_dirs: true,
    });
    expect(readFileSync(target, 'utf8')).toBe('written-content');
  });

  test('overwrite: content replaced, created_dirs false, bytes updated', async () => {
    const target = join(WORKDIR, 'write-overwrite.txt');
    writeFileSync(target, 'original');
    const { body } = await callWrite({ path: target, content: 'replaced-longer' });
    const result = body.result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      path: resolvePath(target), bytes_written: 15, created_dirs: false,
    });
    expect(readFileSync(target, 'utf8')).toBe('replaced-longer');
  });

  test('same-path concurrent writes serialize: final content = last, no corruption', async () => {
    const target = join(WORKDIR, 'write-race.txt');
    const payloads = Array.from({ length: 5 }, (_, i) => `race-payload-${i + 1}-` + 'z'.repeat(200 * (i + 1)));
    const calls = [];
    for (const content of payloads) calls.push(callWrite({ path: target, content })); // issued in order
    const bodies = await Promise.all(calls);
    for (const { body } of bodies) expect(body.result.isError).toBe(false);
    const final = readFileSync(target, 'utf8');
    expect(final).toBe(payloads[4]); // last write wins, byte-exact (no interleaved corruption)
    expect(Buffer.byteLength(final, 'utf8')).toBe(payloads[4].length);
  });

  test('different paths proceed (no cross-blocking): parallel writes all land', async () => {
    const paths = [1, 2, 3].map((n) => join(WORKDIR, `write-par-${n}.txt`));
    const bodies = await Promise.all(paths.map((p, i) => callWrite({ path: p, content: `par-${i}` })));
    for (const [i, { body }] of bodies.entries()) {
      expect(body.result.isError).toBe(false);
      expect(readFileSync(paths[i], 'utf8')).toBe(`par-${i}`);
    }
  });

  test('relative path resolves against the default cwd (EXECD_DEFAULT_CWD)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'execd-write-cwd-'));
    process.env.EXECD_DEFAULT_CWD = dir;
    try {
      const { body } = await callWrite({ path: 'rel-write-probe.txt', content: 'relative-write-ok' });
      expect(body.result.isError).toBe(false);
      expect(body.result.structuredContent.path).toBe(resolvePath(dir, 'rel-write-probe.txt'));
      expect(readFileSync(join(dir, 'rel-write-probe.txt'), 'utf8')).toBe('relative-write-ok');
    } finally {
      delete process.env.EXECD_DEFAULT_CWD;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parent path exists as a file → raw error, no structuredContent (ENOTDIR linux / EEXIST macOS)', async () => {
    const blocker = join(WORKDIR, 'write-blocker.txt');
    writeFileSync(blocker, 'i am a file, not a directory');
    const { body } = await callWrite({ path: join(blocker, 'child.txt'), content: 'x' });
    const result = body.result;
    expect(result.isError).toBe(true);
    // Same situation, platform-specific errno: linux → ENOTDIR, macOS/Bun → EEXIST.
    expect(/ENOTDIR|EEXIST/.test(result.content[0].text)).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  test('~ expansion works for write too', async () => {
    const name = `execd-write-home-${Date.now().toString(36)}.txt`;
    const homeFile = join(homedir(), name);
    try {
      const { body } = await callWrite({ path: `~/${name}`, content: 'tilde-write-ok' });
      expect(body.result.isError).toBe(false);
      expect(body.result.structuredContent.path).toBe(homeFile);
      expect(readFileSync(homeFile, 'utf8')).toBe('tilde-write-ok');
    } finally {
      rmSync(homeFile, { force: true });
    }
  });

  test('binary-safe: writes utf-8 bytes exactly (multi-byte content)', async () => {
    const target = join(WORKDIR, 'write-utf8.txt');
    const content = 'héllo wörld 🎈 \u202F end';
    const { body } = await callWrite({ path: target, content });
    expect(body.result.structuredContent.bytes_written).toBe(Buffer.byteLength(content, 'utf8'));
    expect(readFileSync(target, 'utf8')).toBe(content);
  });
});

// ── JSON-RPC errors ──────────────────────────────────────────────────────

describe('json-rpc errors', () => {
  test('unknown tool → -32601', async () => {
    const { body } = await rpc('tools/call', { name: 'definitely_not_a_tool', arguments: {} });
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain('definitely_not_a_tool');
  });

  test('missing tool name → -32602', async () => {
    const { body } = await rpc('tools/call', {});
    expect(body.error.code).toBe(-32602);
  });

  test('missing command → -32602', async () => {
    const { body } = await rpc('tools/call', { name: 'bash', arguments: {} });
    expect(body.error.code).toBe(-32602);
  });

  test('malformed timeout → -32602', async () => {
    for (const timeout of ['nope', 0, -5, Number.MAX_SAFE_INTEGER + 1]) {
      const { body } = await rpc('tools/call', { name: 'bash', arguments: { command: 'echo hi', timeout } });
      expect(body.error.code).toBe(-32602);
    }
  });

  test('read: malformed params → -32602', async () => {
    for (const args of [
      {}, // missing path
      { path: 42 }, // path not a string
      { path: 'x', offset: 'two' }, // offset not a number
      { path: 'x', limit: 'ten' }, // limit not a number
    ]) {
      const { body } = await rpc('tools/call', { name: 'read', arguments: args });
      expect(body.error.code).toBe(-32602);
    }
    const { body } = await rpc('tools/call', { name: 'read', arguments: 'not-an-object' });
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('arguments must be an object');
  });

  test('write: malformed params → -32602', async () => {
    for (const args of [
      {}, // missing everything
      { content: 'x' }, // missing path
      { path: 'x' }, // missing content
      { path: 'x', content: 7 }, // content not a string
    ]) {
      const { body } = await rpc('tools/call', { name: 'write', arguments: args });
      expect(body.error.code).toBe(-32602);
    }
  });

  test('unparseable body → -32700', async () => {
    const res = await fetch(`http://127.0.0.1:${inst.port}/mcp`, {
      method: 'POST', headers: mcpHeaders(TOKEN), body: '{not json',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).error.code).toBe(-32700);
  });
});

// ── stdio transport — in-process dispatcher (handleLine; real pipe below) ────
//
// handleLine(text) → Promise<string|null>: the response line the loop would
// write to stdout (JSON.stringify(body) + '\n'), or null when the message
// produces NO output (notifications, blank lines). Same dispatchRpc as HTTP.

describe('stdio transport — in-process handleLine', () => {
  let stdio;
  beforeAll(() => {
    stdio = startExecdStdio(); // token/tmpdir accepted and ignored (no auth in stdio)
  });
  afterAll(() => {
    stdio.stop();
  });

  let sid = 500;
  const req = (method, params, id = sid++) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const callToolReq = (name, args, id = sid++) => req('tools/call', { name, arguments: args }, id);

  /** One-line-response invariant: exactly one '\n' and it is terminal. */
  function expectOneLine(out) {
    expect(out.endsWith('\n')).toBe(true);
    expect(out.slice(0, -1).includes('\n')).toBe(false);
  }

  test('initialize → same handshake answer as HTTP (protocol 2025-03-26, serverInfo 0.2.0, three-tool instructions)', async () => {
    const out = await stdio.handleLine(req('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'execd-stdio-test' },
    }));
    expectOneLine(out);
    const body = JSON.parse(out);
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.serverInfo).toEqual({ name: 'execd', version: '0.2.0' });
    expect(body.result.instructions).toContain('Three tools: bash, read, write');
    expect(body.result.instructions).toContain('Stateless server: perform the initialize handshake per request.');
  });

  test('notifications/initialized (and any notification) → null: NO output at all', async () => {
    expect(await stdio.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeNull();
    expect(await stdio.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/whatever' }))).toBeNull();
  });

  test('tools/list → exactly [bash, read, write]', async () => {
    const out = await stdio.handleLine(req('tools/list'));
    expectOneLine(out);
    const body = JSON.parse(out);
    expect(body.result.tools.map((t) => t.name)).toEqual(['bash', 'read', 'write']);
  });

  test('tools/call bash: echo → exit 0, output carried, one-line response', async () => {
    const out = await stdio.handleLine(callToolReq('bash', { command: 'echo stdio-hi', cwd: WORKDIR }));
    expectOneLine(out);
    const body = JSON.parse(out);
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.exit_code).toBe(0);
    expect(body.result.structuredContent.output).toContain('stdio-hi');
  });

  test('tools/call read + write round-trip a tmp file', async () => {
    const file = join(WORKDIR, 'stdio-roundtrip.txt');
    const wOut = await stdio.handleLine(callToolReq('write', { path: file, content: 'stdio-write-ok' }));
    expectOneLine(wOut);
    const w = JSON.parse(wOut);
    expect(w.result.isError).toBe(false);
    expect(w.result.content[0].text).toBe(`Successfully wrote to ${file}`);
    expect(readFileSync(file, 'utf8')).toBe('stdio-write-ok');

    const rOut = await stdio.handleLine(callToolReq('read', { path: file }));
    expectOneLine(rOut);
    const r = JSON.parse(rOut);
    expect(r.result.isError).toBe(false);
    expect(r.result.content[0].text).toBe('stdio-write-ok');
    expect(r.result.structuredContent.size_bytes).toBe(14);
  });

  test('errors: unknown tool -32601, bad params -32602, malformed JSON -32700, bad envelope -32600', async () => {
    const unknown = JSON.parse(await stdio.handleLine(callToolReq('definitely_not_a_tool', {})));
    expect(unknown.error.code).toBe(-32601);
    expect(unknown.error.message).toContain('definitely_not_a_tool');

    const badParams = JSON.parse(await stdio.handleLine(callToolReq('bash', {})));
    expect(badParams.error.code).toBe(-32602);

    const malformed = JSON.parse(await stdio.handleLine('{not json'));
    expect(malformed.error.code).toBe(-32700);
    expect(malformed.id).toBeNull();

    for (const junk of ['123', '[1,2]', JSON.stringify({ id: 7, method: 'tools/list' })]) {
      const envelope = JSON.parse(await stdio.handleLine(junk));
      expect(envelope.error.code).toBe(-32600);
    }
  });

  test('blank / whitespace-only lines → null (skipped silently)', async () => {
    expect(await stdio.handleLine('')).toBeNull();
    expect(await stdio.handleLine('   ')).toBeNull();
    expect(await stdio.handleLine('\t\r')).toBeNull();
  });

  test('concurrent dispatch: slow-first (sleep 0.3) + fast-second (echo) → fast settles FIRST, ids pair', async () => {
    const slowId = sid++;
    const fastId = sid++;
    const settleOrder = [];
    const slowP = stdio.handleLine(callToolReq('bash', { command: 'sleep 0.3 && echo slow-done', cwd: WORKDIR }, slowId))
      .then((out) => { settleOrder.push('slow'); return out; });
    const fastP = stdio.handleLine(callToolReq('bash', { command: 'echo fast-done', cwd: WORKDIR }, fastId))
      .then((out) => { settleOrder.push('fast'); return out; });
    const [slowOut, fastOut] = await Promise.all([slowP, fastP]);
    // A strictly-serial loop would settle slow,fast — async dispatch settles fast first.
    expect(settleOrder).toEqual(['fast', 'slow']);
    expect(JSON.parse(slowOut).id).toBe(slowId);
    expect(JSON.parse(fastOut).id).toBe(fastId);
    expect(JSON.parse(slowOut).result.structuredContent.output).toContain('slow-done');
    expect(JSON.parse(fastOut).result.structuredContent.output).toContain('fast-done');
  }, 10000);

  test('one-line-response invariant holds across every response shape (result, tool-error, rpc-error)', async () => {
    const responses = [
      await stdio.handleLine(req('tools/list')),
      await stdio.handleLine(callToolReq('bash', { command: 'echo shape-probe', cwd: WORKDIR })),
      await stdio.handleLine(callToolReq('read', { path: join(WORKDIR, 'stdio-no-such-file.txt') })), // isError RESULT
      await stdio.handleLine(callToolReq('nope', {})), // -32601 error
      await stdio.handleLine('{broken'), // -32700 error
    ];
    for (const out of responses) expectOneLine(out);
  });
});

// ── stdio transport — REAL child pipe (integration) ──────────────────────────
//
// Spawns the actual `bun index.mjs --stdio` child and drives the true
// stdin/stdout pipe, pinning framing, silence, lifecycle and the no-listener
// guarantee end-to-end.

const INDEX_PATH = resolvePath(import.meta.dir, '..', 'index.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Line reader over a byte ReadableStream (child stdout/stderr): resolves each
 * complete '\n'-terminated line; `next()` → null at clean EOF (any leftover
 * partial tail throws — stdout must carry ONLY complete JSON lines).
 */
function makeLineReader(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  const queued = [];
  let done = false;
  (async () => {
    try {
      for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        for (;;) {
          const nl = buf.indexOf('\n');
          if (nl === -1) break;
          queued.push(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
    } catch {
      // stream destroyed (process exit) — treat as EOF
    }
    buf += decoder.decode();
    done = true;
  })();
  return {
    async next(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (queued.length > 0) return queued.shift();
        if (done) {
          if (buf.trim() !== '') throw new Error(`partial trailing line at EOF: ${JSON.stringify(buf)}`);
          return null;
        }
        if (Date.now() > deadline) throw new Error(`timeout waiting for a line (${queued.length} buffered)`);
        await sleep(10);
      }
    },
  };
}

describe('stdio transport — real child pipe (integration)', () => {
  const STUDIO_PORT = 39213; // pinned probe port: must stay UNBOUND in stdio mode

  function baseChildEnv(extra = {}) {
    const env = { ...process.env, EXECD_DEFAULT_CWD: WORKDIR };
    delete env.EXECD_TRANSPORT; // the child's transport is chosen explicitly per test
    return { ...env, ...extra };
  }

  function spawnChild(argv, env) {
    return Bun.spawn({
      cmd: [process.execPath, INDEX_PATH, ...argv],
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env,
    });
  }

  async function awaitExit(child, timeoutMs = 10000) {
    const code = await Promise.race([child.exited, sleep(timeoutMs).then(() => Symbol('timeout'))]);
    if (typeof code !== 'number') throw new Error('child did not exit within the bounded window');
    return code;
  }

  test('--stdio full lifecycle over the REAL pipe: initialize → tools/list → write → read-back → bash rm → EOF → exit 0', async () => {
    const child = spawnChild(['--stdio'], baseChildEnv({ PORT: String(STUDIO_PORT) }));
    const reader = makeLineReader(child.stdout);
    let id = 1;
    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdin.flush?.();
    };
    const sendReq = (method, params) => send({ jsonrpc: '2.0', id: id++, method, params });

    sendReq('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'execd-child-test' } });
    const init = JSON.parse(await reader.next(10000));
    expect(init.result.serverInfo).toEqual({ name: 'execd', version: '0.2.0' });

    // Notification silence over the true pipe: initialized + tools/list are sent
    // back-to-back — the FIRST line back must be the id-paired tools/list response
    // (any notification output would arrive first and break the id match).
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    sendReq('tools/list');
    const list = JSON.parse(await reader.next(10000));
    expect(list.id).toBe(id - 1);
    expect(list.result.tools.map((t) => t.name)).toEqual(['bash', 'read', 'write']);

    const file = join(WORKDIR, 'stdio-child-file.txt');
    sendReq('tools/call', { name: 'write', arguments: { path: file, content: 'from-stdio-child' } });
    const w = JSON.parse(await reader.next(10000));
    expect(w.result.isError).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('from-stdio-child');

    sendReq('tools/call', { name: 'read', arguments: { path: file } });
    const r = JSON.parse(await reader.next(10000));
    expect(r.result.isError).toBe(false);
    expect(r.result.content[0].text).toBe('from-stdio-child');

    sendReq('tools/call', { name: 'bash', arguments: { command: 'rm stdio-child-file.txt && echo removed-ok', cwd: WORKDIR } });
    const rm = JSON.parse(await reader.next(10000));
    expect(rm.result.isError).toBe(false);
    expect(rm.result.structuredContent.exit_code).toBe(0);
    expect(rm.result.structuredContent.output).toContain('removed-ok');
    expect(existsSync(file)).toBe(false);

    // No HTTP listener in stdio mode — PORT is ignored, nothing bound (while alive).
    await expect(fetch(`http://127.0.0.1:${STUDIO_PORT}/healthz`)).rejects.toThrow();

    // stdin EOF → exit 0 within a bounded window.
    child.stdin.end();
    expect(await awaitExit(child)).toBe(0);

    const stderrText = await new Response(child.stderr).text();
    expect(stderrText).toContain('[execd] stdio mode — newline-delimited JSON-RPC on stdin/stdout');
    // stdout carried ONLY JSON lines: no leftover partial tail, no stray unread line.
    expect(await reader.next(500)).toBeNull();
  }, 30000);

  test('EXECD_TRANSPORT=stdio env equivalent (no flag): initialize answers, EOF exits 0', async () => {
    const child = spawnChild([], baseChildEnv({ EXECD_TRANSPORT: 'stdio' }));
    const reader = makeLineReader(child.stdout);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.flush?.();
    const init = JSON.parse(await reader.next(10000));
    expect(init.result.serverInfo).toEqual({ name: 'execd', version: '0.2.0' });
    child.stdin.end();
    expect(await awaitExit(child)).toBe(0);
    const stderrText = await new Response(child.stderr).text();
    expect(stderrText).toContain('[execd] stdio mode — newline-delimited JSON-RPC on stdin/stdout');
    expect(await reader.next(500)).toBeNull();
  }, 30000);

  test('bounded concurrency: 8 slow + 2 fast concurrent calls — all answered, ids paired (beyond-cap lines queue FIFO)', async () => {
    const child = spawnChild(['--stdio'], baseChildEnv());
    const reader = makeLineReader(child.stdout);
    let id = 1;
    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdin.flush?.();
    };
    send({ jsonrpc: '2.0', id: id++, method: 'initialize', params: {} });
    await reader.next(10000);
    const sentIds = [];
    for (let i = 0; i < 8; i++) {
      const rid = id++;
      sentIds.push(rid);
      send({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name: 'bash', arguments: { command: 'sleep 0.2', cwd: WORKDIR } } });
    }
    for (let i = 0; i < 2; i++) {
      const rid = id++;
      sentIds.push(rid);
      send({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name: 'bash', arguments: { command: `echo quick-${i}`, cwd: WORKDIR } } });
    }
    const answers = [];
    for (let i = 0; i < 10; i++) answers.push(JSON.parse(await reader.next(15000)));
    expect(answers.map((a) => a.id).sort((a, b) => a - b)).toEqual(sentIds.slice().sort((a, b) => a - b));
    for (const a of answers) {
      expect(a.result.isError).toBe(false);
      expect(a.result.structuredContent.exit_code).toBe(0);
    }
    child.stdin.end();
    expect(await awaitExit(child)).toBe(0);
  }, 40000);

  test('HTTP regression: no flag/env → HTTP boots, /healthz answers, SIGTERM exits 0 (zero churn)', async () => {
    const port = 39773;
    const child = Bun.spawn({
      cmd: [process.execPath, INDEX_PATH],
      stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
      env: baseChildEnv({ PORT: String(port) }),
    });
    let body = null;
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        body = await res.json();
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('HTTP child never answered /healthz');
        await sleep(100);
      }
    }
    expect(body).toEqual({ ok: true, service: 'execd' });
    child.kill(); // SIGTERM
    expect(await awaitExit(child)).toBe(0);
    const stderrText = await new Response(child.stderr).text();
    expect(stderrText).toContain(`[execd] listening on 0.0.0.0:${port} (POST /mcp, GET /healthz)`);
    expect(stderrText).not.toContain('stdio mode'); // the HTTP branch, not the stdio branch
  }, 30000);
});

// ── stdio default-cwd chain: args.cwd → EXECD_DEFAULT_CWD → homedir → /home/desktop

describe('default-cwd chain (0.2): EXECD_DEFAULT_CWD → os.homedir() → /home/desktop', () => {
  let stdio;
  beforeAll(() => {
    stdio = startExecdStdio();
  });
  afterAll(() => {
    stdio.stop();
  });

  const bashPwd = async () => {
    const body = JSON.parse(await stdio.handleLine(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: { command: 'pwd' } },
    })));
    expect(body.result.isError).toBe(false);
    return body.result.structuredContent.output;
  };

  test('EXECD_DEFAULT_CWD unset → os.homedir() (the spawning user home; in-guest = /home/desktop)', async () => {
    delete process.env.EXECD_DEFAULT_CWD;
    try {
      expect(await bashPwd()).toBe(`${realpathSync(homedir())}\n`);
    } finally {
      delete process.env.EXECD_DEFAULT_CWD;
    }
  });

  test('EXECD_DEFAULT_CWD set → wins over homedir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'execd-stdio-cwd-'));
    process.env.EXECD_DEFAULT_CWD = dir;
    try {
      expect(await bashPwd()).toBe(`${realpathSync(dir)}\n`);
    } finally {
      delete process.env.EXECD_DEFAULT_CWD;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
