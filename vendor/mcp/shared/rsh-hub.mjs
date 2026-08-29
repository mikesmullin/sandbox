/**
 * Long-lived RSH hub client — single UDP peer multiplexes EXEC + FILE + SIGNAL.
 *
 * Spawns `cli/rsh/zig-out/bin/hub` once per process and speaks NDJSON.
 * Prevents "peer replaced — session GC" from one-shot test_client/client.
 *
 * Timeout policy: **not** in hub EXEC. MCP calls `killExec(id)` / aborts the
 * request signal → we multiplex `exec_kill` → hub sends EXEC_SIGNAL SIG_KILL
 * and we **await** the done event (EXEC_EXIT), not reject immediately.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HUB_CANDIDATES = [
  process.env.RSH_HUB,
  '/workspace/cli/rsh/zig-out/bin/hub',
  resolve(__dirname, '../../../cli/rsh/zig-out/bin/hub'),
].filter(Boolean);

/** Grace after SIGNAL if hub never returns done (ms). Keep short (tests ≤5s). */
const KILL_GRACE_MS = Number(process.env.RSH_KILL_GRACE_MS || 1_500);

function findHub() {
  for (const p of HUB_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

function hubEnv() {
  const env = { ...process.env };
  if (env.SECRET === '' || env.SECRET == null) delete env.SECRET;
  return env;
}

function newId() {
  return randomBytes(6).toString('hex');
}

class RshHub {
  constructor(target) {
    this.target = target;
    this.proc = null;
    this.buf = '';
    this.pending = new Map(); // id → { resolve, reject, onChunk, killGraceTimer }
    this.ready = false;
    this.readyWaiters = [];
    this.path = findHub();
  }

  available() {
    return Boolean(this.path);
  }

  async ensure() {
    if (this.proc && !this.proc.killed) {
      if (this.ready) return;
      await new Promise((r) => this.readyWaiters.push(r));
      return;
    }
    if (!this.path) throw new Error(`rsh hub not found: ${HUB_CANDIDATES.join(', ')}`);

    this.ready = false;
    this.proc = spawn(this.path, [this.target], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: hubEnv(),
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.proc.stderr.on('data', (d) => {
      process.stderr.write(`[rsh-hub] ${d}`);
    });
    this.proc.on('exit', (code, signal) => {
      this.ready = false;
      const err = new Error(`rsh hub exited code=${code} signal=${signal}`);
      for (const [, p] of this.pending) {
        if (p.killGraceTimer) clearTimeout(p.killGraceTimer);
        p.reject?.(err);
        p.onError?.(err);
      }
      this.pending.clear();
      this.proc = null;
    });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('rsh hub ready timeout')), 8000);
      this.readyWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  #write(obj) {
    if (!this.proc?.stdin) throw new Error('rsh hub not running');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  #onStdout(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event === 'ready') {
        this.ready = true;
        for (const w of this.readyWaiters) w();
        this.readyWaiters = [];
        continue;
      }
      const id = msg.id;
      if (id == null || !this.pending.has(String(id))) continue;
      const p = this.pending.get(String(id));
      if (msg.event === 'chunk' && msg.data != null) {
        const buf = Buffer.from(String(msg.data), 'base64');
        p.onChunk?.(new Uint8Array(buf));
        continue;
      }
      if (msg.event === 'done') {
        if (p.killGraceTimer) clearTimeout(p.killGraceTimer);
        this.pending.delete(String(id));
        p.resolve?.(msg);
      }
    }
  }

  /**
   * Multiplex EXEC_SIGNAL SIG_KILL for an in-flight exec id.
   * Does not resolve/reject the pending request — caller awaits done.
   */
  killExec(id) {
    const sid = String(id);
    try {
      this.#write({ id: sid, op: 'exec_kill' });
    } catch {
      /* ignore */
    }
    const p = this.pending.get(sid);
    if (!p || p.killGraceTimer) return;
    // If hub never returns done after kill, resolve locally so MCP does not hang.
    p.killGraceTimer = setTimeout(() => {
      if (!this.pending.has(sid)) return;
      this.pending.delete(sid);
      p.resolve?.({
        id: sid,
        event: 'done',
        ok: true,
        code: 137,
        timed_out: true,
        stdout: '',
        stderr: 'rsh: kill grace expired (no EXEC_EXIT)',
      });
    }, KILL_GRACE_MS);
  }

  /**
   * @param {object} req - must include op; id assigned if missing
   * @param {{ onChunk?: (u8: Uint8Array) => void, signal?: AbortSignal }} [opts]
   *   signal abort → multiplex exec_kill (SIGNAL), then still await done.
   */
  async request(req, opts = {}) {
    await this.ensure();
    const id = String(req.id || newId());
    const payload = { ...req, id };

    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        onChunk: opts.onChunk,
        onError: reject,
        killGraceTimer: null,
      };
      this.pending.set(id, entry);

      const onAbort = () => {
        // SIGNAL only — keep pending so EXEC_EXIT / done can resolve.
        this.killExec(id);
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
        } else {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      try {
        this.#write(payload);
      } catch (err) {
        if (entry.killGraceTimer) clearTimeout(entry.killGraceTimer);
        this.pending.delete(id);
        reject(err);
      }
    }).finally(() => {
      // note: removeEventListener needs same function ref; grace timer cleared on done
    });
  }

  kill() {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.ready = false;
  }
}

/** target → hub instance */
const hubs = new Map();

export function getRshHub(target) {
  const t = target || process.env.MCP_RSH_TARGET || process.env.RSH_TARGET || '10.1.10.57:9000';
  if (!hubs.has(t)) hubs.set(t, new RshHub(t));
  return hubs.get(t);
}

export function abortAllHubs() {
  for (const h of hubs.values()) h.kill();
  hubs.clear();
}

export { findHub, newId };
export default { getRshHub, abortAllHubs, findHub };
