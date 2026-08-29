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
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runMcpStdioServer, textResult } from '../shared/mcp-stdio.mjs';

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

function formatBody(result) {
  return [
    `$ ${result.command}`,
    result.cwd ? `cwd: ${result.cwd}` : '',
    `exit: ${result.code}`,
    result.stdout ? `--- stdout ---\n${result.stdout}` : '',
    result.stderr ? `--- stderr ---\n${result.stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function runProcess(command, args, { cwd, env, track = false } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: cwd || DEFAULT_CWD,
      env: env || process.env,
      shell: false,
    });
    if (track) activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    const done = (result) => {
      if (track) activeChildren.delete(child);
      resolvePromise(result);
    };
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      done({
        code: 127,
        stdout,
        stderr: stderr + (err.message || String(err)),
      });
    });
    child.on('close', (code, signal) => {
      const aborted = signal === 'SIGTERM' || signal === 'SIGKILL';
      done({
        code: aborted ? 130 : (code ?? 0),
        stdout,
        stderr: aborted
          ? stderr + (stderr ? '\n' : '') + `term-local: aborted (${signal})`
          : stderr,
        aborted,
      });
    });
  });
}

async function runJustBash(script, { cwd } = {}) {
  checkAllow(script);
  const body = withEnvExports(String(script));
  // just-bash mounts --root at /home/user/project; cwd inside sandbox defaults there
  const args = ['-c', body, '--root', JB_ROOT, '--json'];
  if (cwd) args.push('--cwd', cwd);

  // just-bash DefenseInDepth expects Node; Bun breaks Module._resolveFilename patches.
  // Always run the CLI under `node` when we have a .js entry.
  let runner;
  let runnerArgs;
  if (JUST_BASH.endsWith('.js')) {
    runner = process.env.JUST_BASH_NODE || 'node';
    runnerArgs = [JUST_BASH, ...args];
  } else {
    runner = JUST_BASH;
    runnerArgs = args;
  }

  const raw = await runProcess(runner, runnerArgs, {
    cwd: JB_ROOT,
    track: true,
  });
  // Parse JSON if present
  try {
    const j = JSON.parse(raw.stdout.trim().split('\n').pop() || '{}');
    return {
      command: script,
      cwd: JB_ROOT,
      code: j.exitCode ?? raw.code,
      stdout: j.stdout ?? '',
      stderr: (j.stderr || '') + (raw.stderr || ''),
      aborted: raw.aborted,
    };
  } catch {
    return {
      command: script,
      cwd: JB_ROOT,
      code: raw.code,
      stdout: raw.stdout,
      stderr: raw.stderr,
      aborted: raw.aborted,
    };
  }
}

const tools = {
  bash: {
    description:
      'Run a shell script via just-bash (emulated bash: pipes, redirects, builtins). ' +
      'Sandbox root is MCP_TERM_JB_ROOT / MCP_TERM_CWD (OverlayFs: reads real files, writes ephemeral). ' +
      'For host processes outside the sandbox, use exec.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Bash script' },
        cwd: { type: 'string', description: 'Optional cwd inside sandbox' },
      },
      required: ['script'],
    },
    async handler({ script, cwd }) {
      if (!script || !String(script).trim()) throw new Error('script required');
      const result = await runJustBash(String(script), { cwd });
      return textResult(formatBody(result), result.code !== 0);
    },
  },

  exec: {
    description:
      'Run a local host program with argv (no shell). Real process on this machine.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
      },
      required: ['command'],
    },
    async handler({ command, args, cwd }) {
      if (!command) throw new Error('command required');
      const argv = Array.isArray(args) ? args.map(String) : [];
      const line = [command, ...argv].join(' ');
      checkAllow(line);
      const workdir = cwd ? resolve(cwd) : DEFAULT_CWD;
      // Host exec: merge agent PATH/env into the real process environment
      const env = { ...process.env, ...TERM_ENV };
      const raw = await runProcess(String(command), argv, {
        cwd: workdir,
        env,
        track: true,
      });
      return textResult(
        formatBody({
          command: line,
          cwd: workdir,
          code: raw.code,
          stdout: raw.stdout,
          stderr: raw.stderr,
        }),
        raw.code !== 0,
      );
    },
  },
};

process.stderr.write(
  `term-local: just-bash=${JUST_BASH} root=${JB_ROOT}` +
    (TERM_ENV.PATH ? ` path=${TERM_ENV.PATH.split(':').length}dirs` : '') +
    `\n`,
);

await runMcpStdioServer({ name: 'term-local', version: '0.1.0', tools });
