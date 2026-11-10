#!/usr/bin/env bun
/**
 * execd live smoke — plain bun script (NEVER inside bun test: busy-wait open
 * issue in web/docs/mcp-driver-contract.md).
 *
 * Discovery mode (mcp-driver.test.mjs skip pattern): NO sandbox is created
 * here. The script lists existing sandboxes via the orchestration API and,
 * when a READY one with an exec surface is reachable, probes its guest execd
 * directly (published execPort when available, else in-guest loopback via
 * `container exec … curl` — same guest server either way):
 *
 *   initialize → notifications/initialized → tools/list (exactly [bash, read, write])
 *   bash probes (date/$DISPLAY/repos → git identity → truncation)
 *   read+write round: write a uniquely-named file → read back (full +
 *   offset/limit window) → bash cat cross-check → bash rm (own file only)
 *
 * When nothing is reachable: prints a skip line and exits 0. Teardown deletes
 * NOTHING (the sandbox is not ours; only the smoke's own probe file is
 * removed in-guest).
 */
import { spawn } from 'node:child_process';

const API = process.env.SMOKE_API || 'http://127.0.0.1:3000';
const GUEST_MCP_PORT = 3213;
const results = [];

function ok(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  if (!condition) throw new Error(`SMOKE FAIL: ${name} ${detail}`);
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function fetchJson(url, init = {}, timeoutMs = 30000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { _raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

/** One JSON-RPC POST against the guest execd, via the best available route. */
function makeGuestDriver(detail) {
  const token = detail.token;
  const auth = `Bearer ${token}`; // fetch path: header VALUE only — the smoke's host-direct route sent the full 'Authorization: Bearer …' line as the value (wire header 'authorization: Authorization: …') → execd 401 'missing or invalid bearer token' → JSON.parse('missing…') died before any probe; live-fixed 2026-10-12 (the curl fallback's -H form was always correct)
  const authHeader = `Authorization: ${auth}`;
  if (detail.execPort) {
    const url = `http://127.0.0.1:${detail.execPort}/mcp`;
    console.log(`  route: host-direct via published execPort ${detail.execPort}`);
    return async (message) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: auth },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
  }
  // Fallback: in-guest loopback (execd binds 0.0.0.0:3213 inside the guest).
  // `container exec [<options>] <id> <args…>` — run from this worktree's CLI.
  const containerId = detail.id;
  console.log('  route: orchestration API does not publish execPort yet — in-guest loopback via container exec curl');
  return (message) => new Promise((resolve, reject) => {
    const body = JSON.stringify(message);
    const proc = spawn('container', ['exec', containerId, 'curl', '-sS', '-o', '-', '-w', '\n%{http_code}',
      '-X', 'POST', `http://127.0.0.1:${GUEST_MCP_PORT}/mcp`,
      '-H', authHeader, '-H', 'content-type: application/json',
      '--data-binary', body], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('guest curl timed out')); }, 60000);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', () => {
      clearTimeout(timer);
      const lines = out.split('\n');
      const statusLine = lines.pop(); // -w appends the HTTP status as the last line
      const payload = lines.join('\n');
      let body = null;
      try { body = payload ? JSON.parse(payload) : null; } catch { body = { _raw: payload.slice(0, 300) }; }
      resolve({ status: Number(statusLine?.trim()), body, _execErr: err });
    });
  });
}

async function main() {
  // ── discovery: an existing ready sandbox with an exec surface ─────────────
  const list = await fetchJson(`${API}/api/orchestration/sandboxes`);
  const items = Array.isArray(list.body?.sandboxes) ? list.body.sandboxes : [];
  // The token only rides DETAIL responses — fetch details for ready items in
  // order until one has an exec surface + token.
  let detail = null;
  for (const item of items.filter((s) => s?.state === 'ready')) {
    const d = await fetchJson(`${API}/api/orchestration/sandboxes/${item.id}`);
    if (d.body?.state === 'ready' && d.body?.token) { detail = d.body; break; }
  }
  if (!detail) {
    console.log('SMOKE SKIP — no ready sandbox reachable via the orchestration API; nothing to probe '
      + '(create one first: POST /api/orchestration/sandboxes). This script never creates or deletes sandboxes.');
    return;
  }
  console.log(`  probing existing sandbox ${detail.id} (state ${detail.state}, execPort ${detail.execPort ?? 'n/a'}) — NOT created or deleted here`);

  // ── guest-facing probes ───────────────────────────────────────────────────
  const rpc = await makeGuestDriver(detail);
  let id = 1;
  const init = await rpc({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'execd-smoke' } } });
  ok('guest initialize 200', init.status === 200 && init.body?.result?.serverInfo?.name === 'execd',
    `status ${init.status} serverInfo ${JSON.stringify(init.body?.result?.serverInfo)}`);
  ok('serverInfo 0.2.0', init.body?.result?.serverInfo?.version === '0.2.0');
  ok('protocolVersion 2025-03-26', init.body?.result?.protocolVersion === '2025-03-26');

  const notif = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  ok('notifications/initialized → 202 empty', notif.status === 202 && !notif.body, `status ${notif.status}`);

  const tools = await rpc({ jsonrpc: '2.0', id: id++, method: 'tools/list' });
  const toolNames = tools.body?.result?.tools?.map((t) => t.name) ?? [];
  ok('tools/list → exactly [bash, read, write]', JSON.stringify(toolNames) === JSON.stringify(['bash', 'read', 'write']),
    JSON.stringify(toolNames));

  const bashCall = async (command, extra = {}) => rpc({
    jsonrpc: '2.0', id: id++, method: 'tools/call',
    params: { name: 'bash', arguments: { command, ...extra } },
  });
  const callTool = (name, args) => rpc({
    jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args },
  });

  // ── bash probes (unchanged surface) ───────────────────────────────────────
  const probe = await bashCall('date -u && echo $DISPLAY && ls /home/desktop/repos');
  const pRes = probe.body?.result;
  ok('bash date probe answers', probe.status === 200 && pRes && pRes.isError === false,
    `status ${probe.status} isError ${pRes?.isError}`);
  ok('probe exit_code 0', pRes?.structuredContent?.exit_code === 0, `exit ${pRes?.structuredContent?.exit_code}`);
  ok('real date output', /\d{2}:\d{2}:\d{2}/.test(pRes?.structuredContent?.output ?? ''), JSON.stringify(pRes?.structuredContent?.output));
  ok('DISPLAY=:1 in guest output (session env inherited)', (pRes?.structuredContent?.output ?? '').split('\n').includes(':1'),
    JSON.stringify(pRes?.structuredContent?.output));
  ok('/home/desktop/repos reachable (no such-file error)', !(pRes?.structuredContent?.output ?? '').includes('No such file or directory'));

  const gitId = await bashCall('git config --global user.name && git config --global user.email && git config --global init.defaultBranch');
  const gOut = gitId.body?.result?.structuredContent?.output ?? '';
  ok('git identity pre-provisioned', gitId.body?.result?.structuredContent?.exit_code === 0
    && /^psicom-/.test(gOut.split('\n')[0] ?? '') && gOut.includes('psicom@localhost') && gOut.includes('main'), JSON.stringify(gOut));

  const trunc = await bashCall('seq 1 50000');
  const tRes = trunc.body?.result;
  ok('truncation probe: truncated=true + full_output_path', tRes?.structuredContent?.truncated === true && !!tRes?.structuredContent?.full_output_path,
    `truncated ${tRes?.structuredContent?.truncated} path ${tRes?.structuredContent?.full_output_path}`);
  ok('bounded view carries the elision marker', (tRes?.content?.[0]?.text ?? '').includes('chars truncated'));

  const wc = await bashCall(`wc -c < ${tRes.structuredContent.full_output_path}`);
  const fileBytes = Number((wc.body?.result?.structuredContent?.output ?? '').trim());
  ok('full output file readable in-guest, length matches', wc.body?.result?.structuredContent?.exit_code === 0
    && fileBytes === Buffer.byteLength(tRes.structuredContent.output, 'utf8'),
    `file ${fileBytes} vs output ${Buffer.byteLength(tRes.structuredContent.output, 'utf8')}`);

  // ── read+write round (execd 0.2) ──────────────────────────────────────────
  const probeFile = `/home/desktop/execd-smoke-${Date.now().toString(36)}.txt`;
  const content = 'smoke-line-1\nsmoke-line-2\nsmoke-line-3\nsmoke-line-4';
  const wRes = (await callTool('write', { path: probeFile, content })).body?.result;
  ok('write answers success', wRes?.isError === false && wRes?.content?.[0]?.text === `Successfully wrote to ${probeFile}`,
    JSON.stringify(wRes?.content?.[0]?.text));
  ok('write structured: path + bytes + created_dirs', wRes?.structuredContent?.path === probeFile
    && wRes?.structuredContent?.bytes_written === Buffer.byteLength(content, 'utf8')
    && wRes?.structuredContent?.created_dirs === false,
    JSON.stringify(wRes?.structuredContent));

  const rRes = (await callTool('read', { path: probeFile })).body?.result;
  ok('read back exact content', rRes?.isError === false && rRes?.content?.[0]?.text === content,
    JSON.stringify(rRes?.content?.[0]?.text));
  ok('read structured: path + total_lines 4 + untruncated', rRes?.structuredContent?.path === probeFile
    && rRes?.structuredContent?.total_lines === 4 && rRes?.structuredContent?.truncated === false,
    JSON.stringify(rRes?.structuredContent));

  const rWin = (await callTool('read', { path: probeFile, offset: 2, limit: 1 })).body?.result;
  ok('read offset/limit window + continuation notice', rWin?.isError === false
    && rWin?.content?.[0]?.text === 'smoke-line-2\n\n[2 more lines in file. Use offset=3 to continue.]',
    JSON.stringify(rWin?.content?.[0]?.text));

  const cat = await bashCall(`cat ${probeFile}`);
  ok('bash cross-check: cat matches the written bytes', cat.body?.result?.structuredContent?.output === content,
    JSON.stringify(cat.body?.result?.structuredContent?.output));

  const rm = await bashCall(`rm ${probeFile}`);
  ok('smoke probe file removed (own file only)', rm.body?.result?.structuredContent?.exit_code === 0);

  console.log(`\nSMOKE PASS — ${results.filter((r) => r.pass).length}/${results.length} assertions held (sandbox ${detail.id})`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`SMOKE FAILED: ${err.message}`);
    process.exit(1);
  },
);
