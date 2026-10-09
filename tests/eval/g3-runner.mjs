#!/usr/bin/env node
// G3 runner (online secondary-action lifecycle). The AGENT authors the actions; the runner only
// (a) places a deterministic fixture, (b) invokes the agent's tools over the MCP bridge
// (define_action / try_action / activate_action / rollback_action), and (c) records the library.
// No seeds, no offline split. Verdicts come from the actions' own postconditions + the online gate.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LIB = process.env.MCAGENT_ACTIONS ?? '/tmp/opencode/g3-actions.json';
const SOCK = '/tmp/opencode/mc-agent.sock';
const MF = 'packages/adapters/mineflayer';

const sh = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let resident = null;

function startResident() {
  resident = spawn('node', ['apps/agent/dist/main-resident.js'], { cwd: ROOT, env: { ...process.env, MCAGENT_ACTIONS: LIB }, stdio: 'ignore' });
}
function stopResident() {
  if (resident) { resident.kill('SIGTERM'); resident = null; }
  try { rmSync(SOCK, { force: true }); } catch { /* ignore */ }
}
function waitForSocket(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const s = net.connect(SOCK);
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => { s.destroy(); Date.now() > deadline ? reject(new Error('socket not up')) : setTimeout(attempt, 1000); });
    };
    attempt();
  });
}
function mcpCall(name, args = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['apps/agent/dist/main-bridge.js'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const byId = new Map();
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) { let m; try { m = JSON.parse(l); } catch { continue; } if (m.id && byId.has(m.id)) byId.get(m.id)(m); }
    });
    const wait = (id) => new Promise((r) => byId.set(id, r));
    const t = setTimeout(() => { child.kill(); reject(new Error(`mcp ${name} timeout`)); }, timeoutMs);
    (async () => {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'g3', version: '0' } } });
      await wait(1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
      const res = await wait(2);
      clearTimeout(t);
      child.kill();
      const text = res?.result?.content?.map((x) => x.text).join('\n');
      if (!text) return reject(new Error(`mcp ${name} error: ${JSON.stringify(res?.error ?? res)}`));
      try { resolve(JSON.parse(text)); } catch { resolve({ raw: text }); }
    })().catch(reject);
  });
}
async function waitReady() {
  await waitForSocket();
  for (let i = 0; i < 60; i++) {
    try { const r = await mcpCall('get_self_status', {}, 8000); if (r?.effectStatus === 'pass') return; } catch { /* */ }
    await sleep(2000);
  }
  throw new Error('resident not ready');
}
async function fixture(n) {
  const st = await mcpCall('get_self_status', {}, 15000);
  const [bx, by, bz] = st.data.pos;
  const r = sh('node', ['tools/setup-bot.mjs', MF, 'fixture-at', String(Math.floor(bx) + 1), String(Math.floor(by)), String(Math.floor(bz)), String(n)]);
  if (r.status !== 0) throw new Error(`fixture ${n} failed`);
}

/** Runner-side fixture: clear the bot's inventory (create a clean situation). */
function clearBot() {
  const r = sh('node', ['tools/setup-bot.mjs', MF, 'cmd', 'clear Bot']);
  if (r.status !== 0) throw new Error('clear Bot failed');
}

const v1 = JSON.parse(readFileSync(path.join(ROOT, 'scenarios/actions/get_wood.v1.json'), 'utf8'));
const v2 = JSON.parse(readFileSync(path.join(ROOT, 'scenarios/actions/get_wood.v2.json'), 'utf8'));

const log = (o) => console.log(JSON.stringify(o));
async function withAgent(fn) {
  stopResident();
  startResident();
  await waitReady();
  try { return await fn(); } finally { stopResident(); }
}

async function main() {
  if (existsSync(LIB)) rmSync(LIB);

  await withAgent(async () => {
    log({ phase: 'define-v1', result: await mcpCall('define_action', v1) });
    log({ phase: 'define-v2', result: await mcpCall('define_action', v2) });

    // Gate evidence for v1: 3 real uses on a 1-log fixture.
    for (let i = 0; i < 3; i++) {
      await fixture(1);
      log({ phase: 'try-v1', i, result: await mcpCall('try_action', { name: v1.name, version: 1 }) });
    }
    // Gate evidence for v2: 3 real uses on a 2-log fixture (it requires >=2).
    for (let i = 0; i < 3; i++) {
      await fixture(2);
      log({ phase: 'try-v2', i, result: await mcpCall('try_action', { name: v2.name, version: 2 }) });
    }

    log({ phase: 'activate-v1', result: await mcpCall('activate_action', { name: v1.name, version: 1 }) });
    log({ phase: 'activate-v2', result: await mcpCall('activate_action', { name: v1.name, version: 2 }) });

    // v2 regresses on the smaller situation: empty inventory + a 1-log fixture -> it cannot
    // reach its >=2 postcondition. Two consecutive failures trip the system's rollback flag.
    clearBot();
    await fixture(1);
    log({ phase: 'try-v2-regress-1', result: await mcpCall('try_action', { name: v1.name }) });
    clearBot();
    await fixture(1);
    log({ phase: 'try-v2-regress-2', result: await mcpCall('try_action', { name: v1.name }) });

    log({ phase: 'list', result: await mcpCall('list_actions', {}) });
    log({ phase: 'rollback-v2', result: await mcpCall('rollback_action', { name: v1.name, reason: 'active v2 failed twice on the smaller fixture' }) });

    // skill (text) layer demo
    log({ phase: 'write-skill', result: await mcpCall('write_skill', { name: 'chopping', description: 'how to chop reliably', tags: ['resource'], text: 'Stand adjacent; break the whole connected object via members(handle); wait to collect drops.' }) });
    log({ phase: 'read-skill', result: await mcpCall('read_skill', { name: 'chopping' }) });
  });

  console.log('G3-RUNNER-DONE');
}
main().catch((e) => { console.error('G3 runner failed:', e?.stack || e); process.exit(1); });
