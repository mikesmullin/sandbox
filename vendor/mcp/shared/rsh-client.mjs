/**
 * ESM RSH client for angela / MCP.
 *
 * Prefer **hub** (`cli/rsh/zig-out/bin/hub`): one long-lived UDP peer multiplexing
 * EXEC + FILE (gl1-style). Avoids "peer replaced — session GC" from one-shot
 * `client` / `test_client` processes.
 *
 * Fallback: legacy one-shot `client` / `test_client` if hub is missing.
 *
 * Remote env (PATH etc.) for EXEC:
 *   MCP_RSH_PATH / MCP_RSH_ENV — injected via `export …; exec …` wrapper
 *   (hub EXEC_SPAWN still sends envc=0).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRshHub, abortAllHubs, newId } from './rsh-hub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TARGET =
  process.env.MCP_RSH_TARGET || process.env.RSH_TARGET || '10.1.10.57:9000';export const DEFAULT_HOME = process.env.MCP_RSH_HOME || '/Users/msmullin';
/** Remote default working directory (Lucy agent cwd). Relative FILE/term paths join here. */
export const DEFAULT_REMOTE_CWD = String(
  process.env.MCP_RSH_CWD || process.env.RSH_CWD || '',
).trim();
const DEFAULT_TIMEOUT = Number(process.env.MCP_RSH_TIMEOUT_MS || 60_000);

const CLIENT_CANDIDATES = [
  process.env.RSH_CLIENT,
  '/workspace/cli/rsh/zig-out/bin/client',
  resolve(__dirname, '../../../cli/rsh/zig-out/bin/client'),
].filter(Boolean);

const TEST_CLIENT_CANDIDATES = [
  process.env.RSH_TEST_CLIENT,
  process.env.RSH_FILE_CLIENT,
  '/workspace/cli/rsh/zig-out/bin/test_client',
  resolve(__dirname, '../../../cli/rsh/zig-out/bin/test_client'),
].filter(Boolean);

const activeChildren = new Set();

export function findClient() {
  for (const p of CLIENT_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function findTestClient() {
  for (const p of TEST_CLIENT_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

function fileClientEnv() {
  const env = { ...process.env };
  if (env.SECRET === '' || env.SECRET == null) delete env.SECRET;
  return env;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function parseRemoteEnv(env = process.env) {
  const out = {};
  const path = env.MCP_RSH_PATH || env.RSH_PATH || '';
  if (path) out.PATH = path;
  const raw = env.MCP_RSH_ENV || env.RSH_ENV || '';
  if (raw) {
    const trimmed = String(raw).trim();
    if (trimmed.startsWith('{')) {
      try {
        Object.assign(out, JSON.parse(trimmed));
      } catch {
        /* ignore */
      }
    } else {
      for (const part of trimmed.split(/[\n,]/)) {
        const line = part.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        if (k && k !== 'PATH') out[k] = v;
      }
    }
  }
  return out;
}

function exportPreamble(envMap) {
  const keys = Object.keys(envMap);
  if (!keys.length) return '';
  return (
    keys.map((k) => `export ${k}=${shellQuote(envMap[k])}`).join('; ') + '; '
  );
}

/** True if argv[0] is a shell used with -c. */
function isShellBin(bin) {
  const b = String(bin || '');
  return (
    b === '/bin/sh' ||
    b === 'sh' ||
    b === '/bin/bash' ||
    b === 'bash' ||
    b.endsWith('/sh') ||
    b.endsWith('/bash')
  );
}

/** Prefer absolute path for known shells. */
function normalizeShellBin(bin) {
  const b = String(bin || '');
  if (b === 'bash' || b.endsWith('/bash')) return '/bin/bash';
  if (b === 'sh' || b.endsWith('/sh')) return '/bin/sh';
  return b;
}

export function abortAllRsh(reason = 'aborted') {
  void reason;
  let n = 0;
  for (const child of [...activeChildren]) {
    try {
      child.kill('SIGTERM');
      n++;
    } catch {
      /* ignore */
    }
  }
  activeChildren.clear();
  abortAllHubs();
  return n;
}

/** Join remote posix paths (no node:path — remote is always macOS/Linux). */
export function remoteJoin(base, rel) {
  const b = String(base || '').replace(/\/+$/, '');
  const r = String(rel || '').replace(/^\/+/, '');
  if (!b) return r ? `/${r}` : '';
  if (!r) return b || '/';
  return `${b}/${r}`;
}

export class RshClient {
  constructor(opts = {}) {
    this.target = opts.target || DEFAULT_TARGET;
    this.home = opts.home || DEFAULT_HOME;
    this.defaultCwd = String(
      opts.defaultCwd ?? opts.cwd ?? DEFAULT_REMOTE_CWD ?? '',
    ).trim();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.clientPath = opts.clientPath || findClient();
    this.testClientPath = opts.testClientPath || findTestClient();
    this.remoteEnv = opts.remoteEnv || parseRemoteEnv(process.env);
    this.hub = getRshHub(this.target);
    this.preferHub = opts.preferHub !== false && this.hub.available();
  }

  available() {
    return this.preferHub || Boolean(this.clientPath) || Boolean(this.testClientPath);
  }

  fileAvailable() {
    return this.preferHub || Boolean(this.testClientPath);
  }

  /** Expand ~ only. */
  expand(s) {
    let out = String(s ?? '');
    if (out.startsWith('~/')) out = this.home + out.slice(1);
    else if (out === '~') out = this.home;
    return out;
  }

  /**
   * Resolve a remote path for FILE_* / list_dir:
   *   ~ → home; relative → defaultCwd (Lucy agent cwd); absolute unchanged.
   */
  resolvePath(s) {
    let out = this.expand(s);
    if (!out || out === '.') {
      return this.defaultCwd || this.home || out;
    }
    // Absolute (posix or Windows drive)
    if (out.startsWith('/') || /^[A-Za-z]:[\\/]/.test(out)) return out;
    const base = this.defaultCwd || this.home;
    if (!base) return out;
    return remoteJoin(this.expand(base), out);
  }

  #withRemoteEnv(remoteArgv) {
    const preamble = exportPreamble(this.remoteEnv);
    if (!preamble) return remoteArgv;
    // Preserve the shell already used for -c (bash vs sh); inject exports in front.
    if (
      remoteArgv.length >= 3 &&
      remoteArgv[1] === '-c' &&
      isShellBin(remoteArgv[0])
    ) {
      return [normalizeShellBin(remoteArgv[0]), '-c', preamble + remoteArgv[2]];
    }
    const escaped = remoteArgv.map((a) => shellQuote(a)).join(' ');
    // Generic argv wrap: still POSIX sh is fine (only runs export + exec).
    return ['/bin/sh', '-c', `${preamble}exec ${escaped}`];
  }

  /**
   * @param {string[]} argv
   * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number|null }} [opts]
   *   timeoutMs: 0 = no timeout; omit = instance default (MCP_RSH_TIMEOUT_MS).
   */
  async exec(argv, opts = {}) {
    let remoteArgv = (argv || []).map((a) => this.expand(a));
    const line = remoteArgv.join(' ');

    // Per-call timeout: 0 = none; null/undefined = instance default
    const timeoutMs =
      opts.timeoutMs === 0
        ? 0
        : opts.timeoutMs != null && Number.isFinite(Number(opts.timeoutMs))
          ? Math.max(0, Number(opts.timeoutMs))
          : this.timeoutMs;

    // MCP owns wall-clock timeout: timer → multiplex SIGNAL (exec_kill) → await EXIT.
    // Hub EXEC has no timeout_ms (dumb forwarder).
    const ac = new AbortController();
    const onParentAbort = () => ac.abort();
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    let timedOut = false;
    let timer = null;

    try {
      if (this.preferHub) {
        // Prefer wire cwd + envc so PATH does not bloat bash -c past MAX_FRAME (2048).
        let spawnCwd = '';
        if (opts.cwd != null && String(opts.cwd).trim()) {
          spawnCwd = this.expand(String(opts.cwd).trim());
        }
        const env =
          this.remoteEnv && Object.keys(this.remoteEnv).length
            ? { ...this.remoteEnv }
            : undefined;

        // Stable id so MCP can exec_kill the same request.
        const reqId = newId();
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            // SIGNAL via hub multiplex (not bash wrapper, not EXEC timeout field).
            try {
              this.hub.killExec(reqId);
            } catch {
              /* ignore */
            }
            // Also mark local AbortSignal so hub.request sees abort (same kill path).
            try {
              ac.abort();
            } catch {
              /* ignore */
            }
          }, timeoutMs);
        }
        try {
          const msg = await this.hub.request(
            {
              id: reqId,
              op: 'exec',
              argv: remoteArgv,
              cwd: spawnCwd,
              ...(env ? { env } : {}),
            },
            { signal: ac.signal },
          );
          const killed = timedOut || Boolean(msg.timed_out);
          let stderr = msg.stderr || msg.error || '';
          if (timedOut && !/timed out|SIGKILL/i.test(stderr)) {
            stderr =
              (stderr ? stderr + '\n' : '') +
              'rsh: timed out (SIGKILL requested via SIGNAL multiplex)';
          }
          return {
            code: killed
              ? 137
              : msg.ok === false
                ? 1
                : Number(msg.code ?? 0),
            stdout: msg.stdout || '',
            stderr,
            command: line,
            target: this.target,
            via: 'hub',
            timed_out: killed,
            aborted: Boolean(ac.signal.aborted && !timedOut),
          };
        } catch (err) {
          const aborted = ac.signal.aborted;
          return {
            code: timedOut || aborted ? 137 : 1,
            stdout: '',
            stderr:
              (err?.message || String(err)) +
              (timedOut
                ? '\nrsh: timed out (SIGKILL requested via SIGNAL multiplex)'
                : aborted
                  ? '\nrsh: aborted (SIGKILL via SIGNAL multiplex)'
                  : ''),
            command: line,
            target: this.target,
            via: 'hub',
            timed_out: timedOut,
            aborted: aborted && !timedOut,
          };
        }
      }

      // Legacy one-shot client (no envc on wire — wrap PATH/cwd in shell)
      if (opts.cwd) {
        const c = this.expand(opts.cwd);
        const escaped = remoteArgv.map((a) => shellQuote(a)).join(' ');
        remoteArgv = ['/bin/sh', '-c', `cd ${shellQuote(c)} && exec ${escaped}`];
      }
      remoteArgv = this.#withRemoteEnv(remoteArgv);

      if (!this.clientPath) {
        return {
          code: 127,
          stdout: '',
          stderr: `rsh client missing (and no hub)`,
          command: line,
          target: this.target,
          timed_out: false,
        };
      }
      const procArgs = [this.target, '--', ...remoteArgv];
      return await new Promise((resolvePromise) => {
        const child = spawn(this.clientPath, procArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        });
        activeChildren.add(child);
        let stdout = '';
        let stderr = '';
        const killChild = () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        };
        // One-shot client: Ctrl-C/TERM to remote is handled by the binary;
        // we can only kill the local client process on wall timeout.
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            killChild();
          }, timeoutMs);
        }
        const onAbort = () => {
          if (!timedOut) killChild();
        };
        ac.signal.addEventListener('abort', onAbort, { once: true });
        child.stdout?.on('data', (d) => {
          stdout += d.toString();
        });
        child.stderr?.on('data', (d) => {
          stderr += d.toString();
        });
        child.on('close', (code, signal) => {
          activeChildren.delete(child);
          clearTimeout(timer);
          const sigKill =
            timedOut || signal === 'SIGKILL' || signal === 'SIGTERM';
          resolvePromise({
            code: timedOut ? 137 : sigKill && code == null ? 130 : (code ?? 0),
            stdout,
            stderr: timedOut
              ? stderr + '\nrsh: timed out (SIGKILL)'
              : sigKill
                ? stderr + '\nrsh: aborted'
                : stderr,
            command: line,
            target: this.target,
            via: 'client',
            timed_out: timedOut,
            aborted: sigKill && !timedOut,
          });
        });
        child.on('error', (err) => {
          activeChildren.delete(child);
          clearTimeout(timer);
          resolvePromise({
            code: 127,
            stdout,
            stderr: err.message,
            command: line,
            target: this.target,
            timed_out: false,
          });
        });
      });
    } finally {
      clearTimeout(timer);
      if (opts.signal) {
        opts.signal.removeEventListener?.('abort', onParentAbort);
      }
    }
  }

  /**
   * Run a remote shell script via real bash (`/bin/bash -c`).
   * Prefer bash over `/bin/sh` so process substitution (`<(…)`), arrays, etc. work
   * (macOS /bin/sh is POSIX mode and will not expand those).
   *
   * When `opts.cwd` is set, `cd` is folded into the bash -c string so the whole
   * script (including process subs) runs under bash in that directory.
   */
  bash(script, opts = {}) {
    let s = String(script ?? '');
    s = s.replace(/(^|[\s"'])~\//g, `$1${this.home}/`);
    s = s.replace(/(^|[\s"'])~/g, `$1${this.home}`);
    const cwd =
      opts.cwd != null && String(opts.cwd).trim()
        ? this.expand(String(opts.cwd).trim())
        : '';
    // Hub path: pass cwd on EXEC_SPAWN (keeps -c small). Legacy client has no
    // cwd field — fold `cd` into the bash -c string.
    if (cwd && !this.preferHub) {
      s = `cd ${shellQuote(cwd)} || exit 1; ${s}`;
      return this.exec(['/bin/bash', '-c', s], { ...opts, cwd: undefined });
    }
    return this.exec(['/bin/bash', '-c', s], {
      ...opts,
      cwd: cwd || opts.cwd,
    });
  }

  async *fileReadStream(path, opts = {}) {
    const abs = this.resolvePath(path);
    if (this.preferHub) {
      const chunks = [];
      let done = false;
      let err = null;
      const doneP = this.hub
        .request(
          { op: 'file_read', path: abs },
          {
            signal: opts.signal,
            onChunk: (u8) => chunks.push(u8),
          },
        )
        .then((msg) => {
          done = true;
          if (msg.ok === false) err = new Error(msg.error || 'file_read failed');
        })
        .catch((e) => {
          done = true;
          err = e;
        });

      // Yield as chunks arrive
      let i = 0;
      while (!done || i < chunks.length) {
        if (i < chunks.length) {
          yield chunks[i++];
          continue;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      await doneP;
      if (err) throw err;
      return;
    }

    // Legacy test_client stream
    if (!this.testClientPath) throw new Error('no FILE_* client');
    const child = spawn(
      this.testClientPath,
      [this.target, 'file-read-stream', abs],
      { stdio: ['ignore', 'pipe', 'pipe'], env: fileClientEnv() },
    );
    activeChildren.add(child);
    try {
      let buf = Buffer.alloc(0);
      const queue = [];
      let finished = false;
      let fail = null;
      const wake = { fn: null };
      const notify = () => wake.fn?.();
      child.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            buf = buf.subarray(4);
            finished = true;
            queue.push(null);
            notify();
            return;
          }
          if (buf.length < 4 + len) break;
          queue.push(new Uint8Array(buf.subarray(4, 4 + len)));
          buf = buf.subarray(4 + len);
          notify();
        }
      });
      child.on('close', () => {
        finished = true;
        queue.push(null);
        notify();
      });
      child.on('error', (e) => {
        fail = e;
        finished = true;
        notify();
      });
      while (true) {
        while (!queue.length && !finished && !fail) {
          await new Promise((r) => {
            wake.fn = r;
          });
        }
        if (fail) throw fail;
        if (!queue.length) break;
        const item = queue.shift();
        if (item === null) break;
        yield item;
      }
    } finally {
      activeChildren.delete(child);
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }

  fileReadableStream(path, opts = {}) {
    const self = this;
    let iter = null;
    return new ReadableStream({
      async start() {
        iter = self.fileReadStream(path, opts)[Symbol.asyncIterator]();
      },
      async pull(controller) {
        try {
          const { value, done } = await iter.next();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (e) {
          controller.error(e);
        }
      },
      cancel() {
        try {
          iter?.return?.();
        } catch {
          /* ignore */
        }
      },
    });
  }

  async fileRead(path, opts = {}) {
    const abs = this.resolvePath(path);
    const parts = [];
    try {
      for await (const chunk of this.fileReadStream(abs, opts)) {
        parts.push(chunk);
      }
    } catch (err) {
      return {
        code: 1,
        stdout: '',
        bytes: new Uint8Array(0),
        stderr: err?.message || String(err),
        command: `file_read ${abs}`,
        target: this.target,
        via: this.preferHub ? 'hub' : 'file-stream',
      };
    }
    const bytes = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const encoding = opts.encoding === null ? null : opts.encoding || 'utf8';
    return {
      code: 0,
      stdout: encoding ? bytes.toString(encoding) : '',
      bytes: new Uint8Array(bytes),
      stderr: '',
      command: `file_read ${abs}`,
      target: this.target,
      via: this.preferHub ? 'hub' : 'file-stream',
    };
  }

  async fileStat(path) {
    const abs = this.resolvePath(path);
    if (this.preferHub) {
      const msg = await this.hub.request({ op: 'file_stat', path: abs });
      return {
        code: msg.ok === false ? 1 : 0,
        stdout: msg.stdout || '',
        stderr: msg.error || '',
        command: `file_stat ${abs}`,
        target: this.target,
        via: 'hub',
        path: abs,
      };
    }
    const r = await this.#fileOpLegacy('file-stat', [abs]);
    return { ...r, path: abs };
  }

  async fileLs(path) {
    const abs = this.resolvePath(path);
    if (this.preferHub) {
      const msg = await this.hub.request({ op: 'file_ls', path: abs });
      return {
        code: msg.ok === false ? 1 : 0,
        stdout: msg.stdout || '',
        stderr: msg.error || '',
        command: `file_ls ${abs}`,
        target: this.target,
        via: 'hub',
        path: abs,
      };
    }
    const r = await this.#fileOpLegacy('file-ls', [abs]);
    return { ...r, path: abs };
  }

  async fileWrite(path, content) {
    const abs = this.resolvePath(path);
    if (this.preferHub) {
      const msg = await this.hub.request({
        op: 'file_write',
        path: abs,
        content: String(content ?? ''),
      });
      return {
        code: msg.ok === false ? 1 : 0,
        stdout: msg.ok ? `wrote ${abs}` : '',
        stderr: msg.error || '',
        command: `file_write ${abs}`,
        target: this.target,
        via: 'hub',
      };
    }
    return this.#fileOpLegacy('file-write', [abs, String(content ?? '')]);
  }

  listDir(path) {
    return this.fileLs(path);
  }

  #fileOpLegacy(sub, args) {
    if (!this.testClientPath) {
      return Promise.resolve({
        code: 127,
        stdout: '',
        stderr: 'test_client missing',
        command: sub,
        target: this.target,
      });
    }
    return new Promise((resolvePromise) => {
      const child = spawn(this.testClientPath, [this.target, sub, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: fileClientEnv(),
      });
      activeChildren.add(child);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, this.timeoutMs);
      child.stdout?.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('close', (code) => {
        activeChildren.delete(child);
        clearTimeout(timer);
        resolvePromise({
          code: code ?? 0,
          stdout,
          stderr,
          command: `${sub} ${args.join(' ')}`,
          target: this.target,
          via: 'test_client',
        });
      });
    });
  }
}

export default {
  RshClient,
  findClient,
  findTestClient,
  parseRemoteEnv,
  abortAllRsh,
  DEFAULT_TARGET,
  DEFAULT_HOME,
};
