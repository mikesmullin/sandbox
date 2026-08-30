import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ws from '../src/workspaces.coffee'

const prevDir = process.env.WS_IDS_DIR
let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-label-'))
  process.env.WS_IDS_DIR = dir
  ws.saveState({ slots: ['e9467a', 'aaaaaa'], rooms: {} })
})

afterEach(() => {
  if (prevDir == null) delete process.env.WS_IDS_DIR
  else process.env.WS_IDS_DIR = prevDir
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('workspace label', () => {
  test('normalizeLabel trims, collapses, and caps length', () => {
    expect(ws.normalizeLabel(null)).toBe('')
    expect(ws.normalizeLabel('  research   docs  ')).toBe('research docs')
    expect(ws.normalizeLabel('a\nb\tc')).toBe('a b c')
    const long = 'x'.repeat(ws.LABEL_MAX + 12)
    expect(ws.normalizeLabel(long)).toBe('x'.repeat(ws.LABEL_MAX))
  })

  test('writeWorkspaceLabel persists for that workspace id', () => {
    const out = ws.writeWorkspaceLabel('workspace-e9467a', '  scrape invoices  ')
    expect(out).toEqual({ id: 'workspace-e9467a', label: 'scrape invoices' })
    expect(ws.loadState().rooms.e9467a.label).toBe('scrape invoices')
    const raw = JSON.parse(readFileSync(join(dir, 'workspaces.json'), 'utf8'))
    expect(raw.rooms.e9467a.label).toBe('scrape invoices')
  })

  test('writeWorkspaceLabel can change and then clear', () => {
    ws.writeWorkspaceLabel('e9467a', 'first')
    ws.writeWorkspaceLabel('workspace-e9467a', 'second pass')
    expect(ws.loadState().rooms.e9467a.label).toBe('second pass')
    const cleared = ws.writeWorkspaceLabel('workspace-e9467a', '   ')
    expect(cleared.label).toBeNull()
    expect(ws.loadState().rooms.e9467a.label).toBeUndefined()
  })

  test('writeWorkspaceLabel does not clobber other room meta', () => {
    ws.setRoomMeta('e9467a', { sessionId: 'sess-1', targetId: 'tid-9' })
    ws.writeWorkspaceLabel('workspace-e9467a', 'keep meta')
    const meta = ws.loadState().rooms.e9467a
    expect(meta).toEqual({
      sessionId: 'sess-1',
      targetId: 'tid-9',
      label: 'keep meta',
    })
  })

  test('writeWorkspaceLabel 404s unknown ids and leaves siblings alone', () => {
    ws.writeWorkspaceLabel('workspace-aaaaaa', 'other')
    try {
      ws.writeWorkspaceLabel('workspace-ffffff', 'nope')
      throw new Error('expected 404')
    } catch (err) {
      expect(err.status).toBe(404)
    }
    expect(ws.loadState().rooms.aaaaaa.label).toBe('other')
    expect(ws.loadState().rooms.ffffff).toBeUndefined()
  })
})
