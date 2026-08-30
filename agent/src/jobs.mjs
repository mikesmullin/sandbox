/**
 * HTTP jobs for ada-hired work. One task_id per session.run on a workspace.
 * Enqueue onto the same runLock as WS chat so they never interleave mid-turn.
 * Persist task meta on workspaces.json rooms so a wait still works after MCP restart.
 */
import { randomBytes } from 'node:crypto';

const SUMMARY_CHARS = 4000;
export const JOB_GOAL_PREFIX =
  'You are a sandbox worker. Complete this brief. Do not ask the host coordinator to run tools. Do not wait for a human.\n\n';

const WORKING = new Set(['submitted', 'working']);
const TERMINAL = new Set(['completed', 'failed', 'canceled']);

const persistApi = {
  hexOf: (id) => {
    const s = String(id || '');
    const m = s.match(/^workspace-([0-9a-f]{6})$/);
    if (m) return m[1];
    if (/^[0-9a-f]{6}$/.test(s)) return s;
    return null;
  },
  setRoomMeta: () => {},
  loadState: () => ({ slots: [], rooms: {} }),
};

/** Wire workspaces.coffee persist (called from rooms.coffee). */
export function useWorkspacePersist(api = {}) {
  if (api.hexOf) persistApi.hexOf = api.hexOf;
  if (api.setRoomMeta) persistApi.setRoomMeta = api.setRoomMeta;
  if (api.loadState) persistApi.loadState = api.loadState;
}

function looksLikeProviderDump(text) {
  const t = String(text || '').trim();
  return t.startsWith('{') && /"choices"\s*:/.test(t) && /"usage"\s*:/.test(t);
}

function clip(s, n = SUMMARY_CHARS) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) : t;
}

function broadcast(room, obj) {
  if (!room?.clients) return;
  const json = JSON.stringify(obj);
  room.clients.forEach((ws) => {
    try {
      ws.send(json);
    } catch {
      /* ignore */
    }
  });
}

export function mintTaskId() {
  return `tk_${randomBytes(4).toString('hex')}`;
}

function serializable(job) {
  return {
    task_id: job.task_id,
    workspace_id: job.workspace_id,
    session_id: job.session_id || null,
    goal: job.goal,
    status: job.status,
    summary: job.summary || '',
    error: job.error || '',
    artifacts: job.artifacts || [],
    usage: job.usage || { turns: null, prompt_tokens: null },
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

export function persistJobs(room) {
  const hex = persistApi.hexOf(room?.name);
  if (!hex) return null;
  const jobs = {};
  for (const [id, job] of room.jobs || new Map()) {
    jobs[id] = serializable(job);
  }
  persistApi.setRoomMeta(hex, { jobs });
  return jobs;
}

export function loadJobsIntoRoom(room) {
  if (!room || room._jobsLoaded) return room;
  room._jobsLoaded = true;
  room.jobs ??= new Map();
  const hex = persistApi.hexOf(room.name);
  if (!hex) return room;
  const meta = persistApi.loadState().rooms[hex] || {};
  const raw = meta.jobs || {};
  let dirty = false;
  for (const [id, rec] of Object.entries(raw)) {
    if (!rec || typeof rec !== 'object' || !rec.task_id) continue;
    const job = { ...rec };
    if (WORKING.has(job.status)) {
      job.status = 'failed';
      job.error = job.error || 'interrupted (agent restart)';
      job.updated_at = new Date().toISOString();
      dirty = true;
    }
    room.jobs.set(job.task_id || id, job);
  }
  if (dirty) persistJobs(room);
  return room;
}

export function workspaceBusy(room, exceptTaskId = null) {
  if (!room) return false;
  for (const job of (room.jobs || new Map()).values()) {
    if (exceptTaskId && job.task_id === exceptTaskId) continue;
    if (WORKING.has(job.status)) return true;
  }
  if (room.waiting || room.session?.running) {
    const self = exceptTaskId ? room.jobs?.get(exceptTaskId) : null;
    if (self && WORKING.has(self.status)) return false;
    return true;
  }
  return false;
}

function enqueue(room, fn) {
  room.runLock = (room.runLock || Promise.resolve()).then(fn).catch((err) => {
    console.error(`[agent ${room.name} jobs]`, err.message || err);
  });
  return room.runLock;
}

function tokensOf(room) {
  const id = room?.session?.id;
  let meta = null;
  try {
    meta = room.harness?.sessionStore?.load(id);
  } catch {
    meta = null;
  }
  const n = Number(meta?.lastPromptTokens ?? room.tokensUsed ?? 0);
  if (Number.isFinite(n) && n > 0) return n;
  return Number(room.tokensUsed || 0) || 0;
}

function lastAssistantText(room, result) {
  if (typeof result === 'string') {
    const t = result.trim();
    if (!looksLikeProviderDump(t)) return clip(t);
  }
  if (result && typeof result === 'object') {
    if (typeof result.summary === 'string' && result.summary) return clip(result.summary);
    if (typeof result.output === 'string' && result.output) return clip(result.output);
  }
  const id = room?.session?.id;
  const store = room?.harness?.sessionStore;
  if (id && store?.listEventsFolded) {
    const events = store.listEventsFolded(id);
    let last = '';
    for (const wrap of events) {
      const p = wrap.payload;
      if (wrap.event_type !== 'context_window' || p?.role !== 'assistant') continue;
      if (p.kind === 'provider_messages_snapshot') continue;
      const text = String(p.content || '');
      if (!text || looksLikeProviderDump(text)) continue;
      last = text;
    }
    if (last) return clip(last);
  }
  return clip(String(room?.liveAssistant || ''));
}

function publicJob(room, job) {
  if (!job) return null;
  return {
    ...serializable(job),
    running: Boolean(room?.session?.running || room?.waiting),
    tokens: tokensOf(room),
  };
}

export function getJob(room, taskId) {
  if (room) loadJobsIntoRoom(room);
  const job = room?.jobs?.get(String(taskId || ''));
  if (!job) return null;
  return publicJob(room, job);
}

export function listJobs(room) {
  if (room) loadJobsIntoRoom(room);
  const out = [];
  if (!room?.jobs) return out;
  for (const job of room.jobs.values()) out.push(publicJob(room, job));
  return out;
}

async function runJob(room, job, gen) {
  if (TERMINAL.has(job.status)) return;
  if (gen != null && job.generation !== gen) return;
  job.status = 'working';
  job.session_id = room.session?.id || job.session_id;
  job.updated_at = new Date().toISOString();
  persistJobs(room);
  if (room.session?.running) {
    try {
      await room.session.abort('job supersede');
    } catch {
      /* ignore */
    }
  }
  if (gen != null && job.generation !== gen) return;
  const prevMode = room.harness?.policy?.mode;
  if (room.harness?.policy) room.harness.policy.mode = 'open';
  room.waiting = true;
  room.runStartedAt = Date.now();
  room.error = '';
  room.liveAssistant = '';
  room.liveReasoning = '';
  broadcast(room, { type: 'user', text: job.goal });
  broadcast(room, {
    type: 'status',
    phase: 'running',
    sessionId: room.session?.id,
    runStartedAt: room.runStartedAt,
    waiting: true,
  });
  let result = null;
  try {
    if (job.status === 'canceled') return;
    if (gen != null && job.generation !== gen) return;
    if (!room.session) throw new Error('no session');
    result = await room.session.run({ prompt: JOB_GOAL_PREFIX + job.goal });
  } catch (err) {
    if ((gen != null && job.generation !== gen) || job.status === 'canceled') return;
    if (
      err?.aborted ||
      /abort|user stop|interrupted|supersede/i.test(err?.message || '')
    ) {
      job.status = 'canceled';
      job.error = err.message || 'canceled';
    } else {
      job.status = 'failed';
      job.error = err?.message || String(err);
    }
    job.updated_at = new Date().toISOString();
    persistJobs(room);
    if (job.status === 'failed') broadcast(room, { type: 'error', error: job.error });
    broadcast(room, { type: 'done' });
    return;
  } finally {
    if (room.harness?.policy && prevMode != null) {
      room.harness.policy.mode = prevMode;
    }
    room.waiting = false;
    room.runStartedAt = null;
    room.liveAssistant = '';
    room.liveReasoning = '';
  }
  if (TERMINAL.has(job.status)) return;
  if (gen != null && job.generation !== gen) return;
  job.status = 'completed';
  job.summary = lastAssistantText(room, result);
  job.error = '';
  job.session_id = room.session?.id || job.session_id;
  job.usage = { turns: null, prompt_tokens: tokensOf(room) };
  job.updated_at = new Date().toISOString();
  persistJobs(room);
  broadcast(room, { type: 'done' });
}

export async function createJob(room, opts = {}) {
  if (!room) {
    throw Object.assign(new Error('workspace room missing'), { status: 500 });
  }
  loadJobsIntoRoom(room);
  const goal = String(opts.goal || '').trim();
  if (!goal) {
    throw Object.assign(new Error('goal required'), { status: 400 });
  }
  if (!room.session) {
    throw Object.assign(new Error(`workspace ${room.name} has no session`), { status: 500 });
  }
  const taskId = String(opts.task_id || opts.taskId || '').trim() || mintTaskId();
  const existing = room.jobs.get(taskId);
  if (existing && WORKING.has(existing.status)) {
    if (room.session?.running) {
      try {
        await room.session.abort('job supersede');
      } catch {
        /* ignore */
      }
    }
  } else if (workspaceBusy(room, taskId)) {
    throw Object.assign(new Error(`workspace ${room.name} is busy`), { status: 409 });
  }
  const now = new Date().toISOString();
  const job = existing || {
    task_id: taskId,
    workspace_id: room.name,
    session_id: room.session.id,
    artifacts: [],
    usage: { turns: null, prompt_tokens: null },
    created_at: now,
    generation: 0,
  };
  job.goal = goal;
  job.status = 'working';
  job.summary = '';
  job.error = '';
  job.session_id = room.session.id;
  job.updated_at = now;
  job.generation = (job.generation || 0) + 1;
  const gen = job.generation;
  room.jobs.set(taskId, job);
  persistJobs(room);
  enqueue(room, () => runJob(room, job, gen));
  return {
    task_id: taskId,
    workspace_id: room.name,
    session_id: room.session.id,
    status: 'working',
  };
}

export async function abortJob(room, taskId, reason = 'abort') {
  if (room) loadJobsIntoRoom(room);
  const job = room?.jobs?.get(String(taskId || ''));
  if (!job) {
    throw Object.assign(new Error(`job ${taskId} not found`), { status: 404 });
  }
  if (TERMINAL.has(job.status)) return publicJob(room, job);
  job.status = 'canceled';
  job.error = String(reason || 'abort');
  job.updated_at = new Date().toISOString();
  persistJobs(room);
  if (room.session) {
    try {
      await room.session.abort(job.error);
    } catch {
      /* ignore */
    }
  }
  room.waiting = false;
  room.runStartedAt = null;
  return publicJob(room, job);
}
