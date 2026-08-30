#!/usr/bin/env bun
/**
 * MCP server: local terminal — just-bash CLI for scripts + argv exec for host binaries.
 *
 * just-bash is invoked as a subprocess (more reliable under Bun than in-process
 * DefenseInDepthBox patches). Uses OverlayFs semantics: --root mounts project.
 *
 * Env:
 *   MCP_TERM_CWD / MCP_TERM_JB_ROOT — sandbox root (default cwd)
 *   MCP_TERM_ALLOW — comma regex allowlist (optional)
 *   JUST_BASH_BIN — path to just-bash binary
 */
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runMcpStdioServer, textResult } from '../shared/mcp-stdio.mjs';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from '../shared/truncate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const DEFAULT_CWD = process.env.MCP_TERM_CWD
  ? resolve(process.env.MCP_TERM_CWD)
  : process.cwd();

const JB_ROOT = process.env.MCP_TERM_JB_ROOT
  ? resolve(process.env.MCP_TERM_JB_ROOT)
  : DEFAULT_CWD;

/**
 * Sandbox env for just-bash / host exec (from agent coffee via MCP_TERM_PATH /
 * MCP_TERM_ENV). Prepended to scripts as `export KEY=…` because just-bash has
 * no --env flag.
 */
function parseTermEnv() {
  const out = {};
  if (process.env.MCP_TERM_PATH) out.PATH = process.env.MCP_TERM_PATH;
  const raw = process.env.MCP_TERM_ENV || '';
  if (raw.trim().startsWith('{')) {
    try {
      Object.assign(out, JSON.parse(raw));
    } catch {
      /* ignore */
    }
  } else if (raw) {
    for (const part of raw.split(/[\n,]/)) {
      const line = part.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      if (k && k !== 'PATH') out[k] = line.slice(eq + 1).trim();
    }
  }
  return out;
}

const TERM_ENV = parseTermEnv();

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function withEnvExports(script) {
  const keys = Object.keys(TERM_ENV);
  if (!keys.length) return script;
  const preamble = keys
    .map((k) => `export ${k}=${shellQuote(TERM_ENV[k])}`)
    .join('; ');
  return `${preamble}; ${script}`;
}

/** Active host exec children for Stop */
const activeChildren = new Set();

export function abortAllTermLocal() {
  let n = 0;
  for (const c of [...activeChildren]) {
    try {
      c.kill('SIGTERM');
      n++;
    } catch {
      /* ignore */
    }
  }
  activeChildren.clear();
  return n;
}

function findJustBash() {
  if (process.env.JUST_BASH_BIN && existsSync(process.env.JUST_BASH_BIN)) {
    return process.env.JUST_BASH_BIN;
  }
  try {
    const pkg = dirname(require.resolve('just-bash/package.json'));
    const bin = join(pkg, 'dist/bin/just-bash.js');
    if (existsSync(bin)) return bin;
  } catch {
    /* ignore */
  }
  const local = join(__dirname, '../node_modules/just-bash/dist/bin/just-bash.js');
  if (existsSync(local)) return local;
  return 'just-bash';
}

const JUST_BASH = findJustBash();

const allowRaw = process.env.MCP_TERM_ALLOW || '';
const allowRules = allowRaw
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => new RegExp(s));

function checkAllow(commandLine) {
  if (allowRules.length === 0) return;
  if (!allowRules.some((re) => re.test(commandLine))) {
    throw new Error(`Command denied by MCP_TERM_ALLOW: ${commandLine}`);
  }
}

function createProgressEmitter(ctx) {
  if (!ctx?.notify || ctx.progressToken == null || ctx.progressToken === '') {
    return { push() {}, flush() {} };
  }
  let last = 0;
  let pending = null;
  let timer = null;
  const send = (output) => {
    ctx.notify('notifications/progress', {
      progressToken: ctx.progressToken,
      output,
    });
  };
  return {
    push(merged) {
      pending = merged;
      const now = Date.now();
      const wait = 250 - (now - last);
      if (wait <= 0) {
        last = now;
        pending = null;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        send(merged);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          if (pending != null) send(pending);
          pending = null;
        }, wait);
      }
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending != null) send(pending);
      pending = null;
    },
  };
}

function runProcess(command, args, { cwd, env, track = false, timeoutSec, onChunk } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: cwd || DEFAULT_CWD,
      env: env || process.env,
      shell: false,
    });
    if (track) activeChildren.add(child);
    let merged = '';
    let timedOut = false;
    let timer;
    if (timeoutSec && Number(timeoutSec) > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 1000);
      }, Number(timeoutSec) * 1000);
    }
    const done = (result) => {
      if (timer) clearTimeout(timer);
      if (track) activeChildren.delete(child);
      resolvePromise(result);
    };
    const onData = (d) => {
      const s = d.toString();
      merged += s;
      onChunk?.(s, merged);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      done({
        code: 127,
        merged: merged + (err.message || String(err)),
        timedOut: false,
        aborted: false,
      });
    });
    child.on('close', (code, signal) => {
      const aborted = !timedOut && (signal === 'SIGTERM' || signal === 'SIGKILL');
      done({
        code: timedOut ? 124 : aborted ? 130 : (code ?? 0),
        merged,
        timedOut,
        aborted,
        timeoutSec: timedOut ? Number(timeoutSec) : undefined,
      });
    });
  });
}

async function spillFullOutput(fullText, jailRoot) {
  const bases = [];
  if (jailRoot) bases.push(join(jailRoot, '.angela', 'tmp'));
  bases.push(join(tmpdir(), 'angela-bash'));
  let lastErr;
  for (const dir of bases) {
    try {
      await mkdir(dir, { recursive: true });
      const path = join(dir, `bash-${Date.now()}-${process.pid}.txt`);
      await writeFile(path, fullText, 'utf8');
      return path;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('could not write full output');
}

async function formatShellOutput(merged, { jailRoot } = {}) {
  const truncation = truncateTail(merged);
  let text = truncation.content || '';
  let fullOutputPath = null;
  if (truncation.truncated) {
    try {
      fullOutputPath = await spillFullOutput(merged, jailRoot);
    } catch {
      fullOutputPath = null;
    }
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    const endLine = truncation.totalLines;
    if (truncation.lastLinePartial) {
      text +=
        `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}` +
        (fullOutputPath ? `. Full output: ${fullOutputPath}` : '') +
        `]`;
    } else if (truncation.truncatedBy === 'lines') {
      text +=
        `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}` +
        (fullOutputPath ? `. Full output: ${fullOutputPath}` : '') +
        `]`;
    } else {
      text +=
        `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} ` +
        `(${formatSize(DEFAULT_MAX_BYTES)} limit)` +
        (fullOutputPath ? `. Full output: ${fullOutputPath}` : '') +
        `]`;
    }
  }
  return { text, truncation, fullOutputPath };
}

function appendStatus(text, status) {
  return `${text ? `${text}\n\n` : ''}${status}`;
}

function finishShellResult(formatted, raw) {
  let text = formatted.text;
  if (raw.timedOut) {
    throw new Error(
      appendStatus(text, `Command timed out after ${raw.timeoutSec} seconds`),
    );
  }
  if (raw.aborted) {
    throw new Error(appendStatus(text, 'Command aborted'));
  }
  if (raw.code !== 0 && raw.code != null) {
    throw new Error(appendStatus(text || '(no output)', `Command exited with code ${raw.code}`));
  }
  return textResult(text || '(no output)');
}

async function runJustBash(script, { cwd, timeoutSec, onChunk } = {}) {
  checkAllow(script);
  const body = withEnvExports(String(script));
  const args = ['-c', body, '--root', JB_ROOT];
  if (cwd) args.push('--cwd', cwd);

  let runner;
  let runnerArgs;
  if (JUST_BASH.endsWith('.js')) {
    runner = process.env.JUST_BASH_NODE || 'node';
    runnerArgs = [JUST_BASH, ...args];
  } else {
    runner = JUST_BASH;
    runnerArgs = args;
  }

  return runProcess(runner, runnerArgs, {
    cwd: JB_ROOT,
    track: true,
    timeoutSec,
    onChunk,
  });
}

const tools = {
  bash: {
    description:
      `Run a shell script via just-bash (emulated bash: pipes, redirects, builtins). ` +
      `Sandbox root is MCP_TERM_JB_ROOT / MCP_TERM_CWD (OverlayFs: reads real files, writes ephemeral). ` +
      `Stdout and stderr are merged. Non-zero exit throws. Output is truncated to last ${DEFAULT_MAX_LINES} lines ` +
      `or ${DEFAULT_MAX_BYTES / 1024}KB. For host processes outside the sandbox, use exec.`,
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Bash script' },
        cwd: { type: 'string', description: 'Optional cwd inside sandbox' },
        timeout: { type: 'number', description: 'Timeout in seconds (optional)' },
      },
      required: ['script'],
    },
    async handler({ script, cwd, timeout }, ctx) {
      if (!script || !String(script).trim()) throw new Error('script required');
      const progress = createProgressEmitter(ctx);
      const raw = await runJustBash(String(script), {
        cwd,
        timeoutSec: timeout,
        onChunk: (_chunk, merged) => progress.push(merged),
      });
      progress.flush();
      const formatted = await formatShellOutput(raw.merged, { jailRoot: JB_ROOT });
      return finishShellResult(formatted, raw);
    },
  },

  exec: {
    description:
      `Run a local host program with argv (no shell). Real process on this machine. ` +
      `Stdout and stderr are merged. Non-zero exit throws. Output is truncated to last ${DEFAULT_MAX_LINES} lines ` +
      `or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        timeout: { type: 'number', description: 'Timeout in seconds (optional)' },
      },
      required: ['command'],
    },
    async handler({ command, args, cwd, timeout }, ctx) {
      if (!command) throw new Error('command required');
      const argv = Array.isArray(args) ? args.map(String) : [];
      const line = [command, ...argv].join(' ');
      checkAllow(line);
      const workdir = cwd ? resolve(cwd) : DEFAULT_CWD;
      const env = { ...process.env, ...TERM_ENV };
      const progress = createProgressEmitter(ctx);
      const raw = await runProcess(String(command), argv, {
        cwd: workdir,
        env,
        track: true,
        timeoutSec: timeout,
        onChunk: (_chunk, merged) => progress.push(merged),
      });
      progress.flush();
      const formatted = await formatShellOutput(raw.merged, { jailRoot: workdir });
      return finishShellResult(formatted, raw);
    },
  },
};

process.stderr.write(
  `term-local: just-bash=${JUST_BASH} root=${JB_ROOT}` +
    (TERM_ENV.PATH ? ` path=${TERM_ENV.PATH.split(':').length}dirs` : '') +
    `\n`,
);

await runMcpStdioServer({ name: 'term-local', version: '0.2.0', tools });
