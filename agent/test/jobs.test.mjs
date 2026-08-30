import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createJob,
  getJob,
  listJobs,
  abortJob,
  workspaceBusy,
  mintTaskId,
} from '../src/jobs.mjs';

const idsDir = join(tmpdir(), `angela-jobs-test-${process.pid}`);

describe('in-pod jobs', () => {

  function fakeRoom(overrides = {}) {
    const room = {
      name: 'workspace-aaaaaa',
      jail: join(idsDir, 'jail'),
      model: 'test',
      clients: new Set(),
      runLock: Promise.resolve(),
      jobs: new Map(),
      waiting: false,
      runStartedAt: null,
      tokensUsed: 0,
      error: '',
      liveAssistant: '',
      liveReasoning: '',
      harness: { policy: { mode: 'ask' }, sessionStore: null },
      session: {
        id: 'sess-1',
        running: false,
        _abort: false,
        lastPrompt: null,
        async run({ prompt }) {
          this._abort = false;
          this.running = true;
          this.lastPrompt = prompt;
          await Bun.sleep(40);
          if (this._abort) {
            this.running = false;
            const e = new Error('aborted');
            e.aborted = true;
            throw e;
          }
          this.running = false;
          return 'pong';
        },
        async abort() {
          this._abort = true;
          this.running = false;
        },
      },
      ...overrides,
    };
    return room;
  }

  test('mintTaskId is tk_ + hex', () => {
    expect(mintTaskId()).toMatch(/^tk_[0-9a-f]{8}$/);
  });

  test('createJob returns immediately while running', async () => {
    const room = fakeRoom();
    const t0 = Date.now();
    const created = await createJob(room, { goal: 'reply with pong' });
    expect(Date.now() - t0).toBeLessThan(30);
    expect(created.status).toBe('working');
    expect(created.task_id).toMatch(/^tk_/);
    expect(created.workspace_id).toBe('workspace-aaaaaa');
    await Bun.sleep(10);
    const live = getJob(room, created.task_id);
    expect(live.status).toBe('working');
    expect(room.session.running || live.running).toBe(true);
    await room.runLock;
    const done = getJob(room, created.task_id);
    expect(done.status).toBe('completed');
    expect(done.summary).toContain('pong');
    expect(room.session.lastPrompt).toMatch(/sandbox worker/i);
    expect(room.session.lastPrompt).toContain('reply with pong');
    expect(room.harness.policy.mode).toBe('ask');
  });

  test('abort marks canceled', async () => {
    const room = fakeRoom();
    const created = await createJob(room, { goal: 'long' });
    await Bun.sleep(10);
    const aborted = await abortJob(room, created.task_id, 'parent changed plan');
    expect(aborted.status).toBe('canceled');
    await room.runLock;
    expect(getJob(room, created.task_id).status).toBe('canceled');
  });

  test('busy workspace refuses a second new job', async () => {
    const room = fakeRoom();
    await createJob(room, { goal: 'one' });
    await Bun.sleep(5);
    expect(workspaceBusy(room)).toBe(true);
    let err;
    try {
      await createJob(room, { goal: 'two' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.status).toBe(409);
    expect(String(err.message)).toMatch(/busy/i);
    await abortJob(room, [...room.jobs.keys()][0]);
    await room.runLock;
  });

  test('same task_id steers instead of 409', async () => {
    const room = fakeRoom();
    const first = await createJob(room, { goal: 'one', task_id: 'tk_steer1' });
    await Bun.sleep(5);
    const second = await createJob(room, { goal: 'two', task_id: 'tk_steer1' });
    expect(second.task_id).toBe(first.task_id);
    expect(second.status).toBe('working');
    await room.runLock;
    expect(room.session.lastPrompt).toContain('two');
  });

  test('unknown abort is 404', async () => {
    const room = fakeRoom();
    let err;
    try {
      await abortJob(room, 'tk_missing');
    } catch (e) {
      err = e;
    }
    expect(err?.status).toBe(404);
  });

  test('listJobs returns created jobs', async () => {
    const room = fakeRoom();
    const created = await createJob(room, { goal: 'x' });
    const listed = listJobs(room);
    expect(listed.some((j) => j.task_id === created.task_id)).toBe(true);
    await abortJob(room, created.task_id);
    await room.runLock;
  });

  test('empty goal is 400', async () => {
    const room = fakeRoom();
    let err;
    try {
      await createJob(room, { goal: '  ' });
    } catch (e) {
      err = e;
    }
    expect(err?.status).toBe(400);
  });
});
