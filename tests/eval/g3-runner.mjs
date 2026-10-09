#!/usr/bin/env node
// G3 runner: mechanically orchestrates the seed-isolated admission gate for a skill the AGENT
// authored. It only (a) resets the world to a seed, (b) places a deterministic fixture,
// (c) invokes the agent's tools over the MCP bridge (define_skill / run_skill / promote_skill /
// rollback_skill), and (d) records the library. It encodes NO task steps and NO success rule —
// the skill content is the agent's; the verdicts come from the skill's own postconditions and
// the library gate; the final judgement is the independent verifier.
//
//   node tests/eval/g3-runner.mjs

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LIB = process.env.MCAGENT_SKILLS ?? '/tmp/opencode/g3-skills.json';
const SOCK = '/tmp/opencode/mc-agent.sock';
const MF = 'packages/adapters/mineflayer';

const sh = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let resident = null;

function startResident(seed, role) {
  const env = { ...process.env, MCAGENT_SKILLS: LIB };
  if (seed) {
    env.MCAGENT_SEED = String(seed);
    env.MCAGENT_SEED_ROLE = role;
  }
  resident = spawn('node', ['apps/agent/dist/main-resident.js'], { cwd: ROOT, env, stdio: 'ignore' });
}

function stopResident() {
  if (resident) {
    resident.kill('SIGTERM');
    resident = null;
  }
  try { rmSync(SOCK, { force: true }); } catch { /* ignore */ }
}

function waitForSocket(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const s = net.connect(SOCK);
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error('resident socket not up'));
        else setTimeout(attempt, 1000);
      });
    };
    attempt();
  });
}

function resetWorld(seed) {
  stopResident();
  const r = sh('tools/reset-world.sh', [String(seed)]);
  if (r.status !== 0) throw new Error(`reset-world ${seed} failed`);
}

async function fixture(n) {
  const st = await mcpCall('get_self_status', {}, 15000);
  const [bx, by, bz] = st.data.pos;
  const x = Math.floor(bx) + 1;
  const y = Math.floor(by);
  const z = Math.floor(bz);
  const r = sh('node', ['tools/setup-bot.mjs', MF, 'fixture-at', String(x), String(y), String(z), String(n)]);
  if (r.status !== 0) throw new Error(`fixture ${n} failed`);
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
      for (const l of lines) if (l.trim()) {
        let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.id && byId.has(m.id)) byId.get(m.id)(m);
      }
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
    try {
      const r = await mcpCall('get_self_status', {}, 8000);
      if (r?.effectStatus === 'pass') return r;
    } catch { /* not ready */ }
    await sleep(2000);
  }
  throw new Error('resident not ready');
}

const v1 = JSON.parse(readFileSync(path.join(ROOT, 'scenarios/skills/get_wood.v1.json'), 'utf8'));
const v2 = JSON.parse(readFileSync(path.join(ROOT, 'scenarios/skills/get_wood.v2.json'), 'utf8'));

const report = { skill: v1.name, phases: [] };
const log = (o) => { report.phases.push(o); console.log(JSON.stringify(o)); };

async function withAgent(fn) {
  stopResident();
  startResident();
  await waitReady();
  try { return await fn(); } finally { stopResident(); }
}

async function withSeed(seed, role, fn) {
  resetWorld(seed);
  startResident(seed, role);
  await waitReady();
  try { return await fn(); } finally { stopResident(); }
}

async function main() {
  if (existsSync(LIB)) rmSync(LIB);

  // 1. agent defines two versions
  await withAgent(async () => {
    log({ phase: 'define-v1', result: await mcpCall('define_skill', v1) });
    log({ phase: 'define-v2', result: await mcpCall('define_skill', v2) });
  });

  // 2. train + val: record both versions (fresh fixture before each run)
  for (const [seed, role] of [[1001, 'train'], [2001, 'val'], [2002, 'val']]) {
    await withSeed(seed, role, async () => {
      await fixture(2);
      log({ phase: 'run', seed, role, version: 1, result: await mcpCall('run_skill', { name: v1.name, version: 1 }) });
      await fixture(2);
      log({ phase: 'run', seed, role, version: 2, result: await mcpCall('run_skill', { name: v2.name, version: 2 }) });
    });
  }

  // 3. promote v1 (gate: train+val only)
  await withAgent(async () => {
    log({ phase: 'promote-v1', result: await mcpCall('promote_skill', { name: v1.name, version: 1 }) });
  });

  // 4. held-out replay of the admitted skill on the test seed
  await withSeed(9001, 'test', async () => {
    await fixture(1);
    log({ phase: 'replay-v1', seed: 9001, result: await mcpCall('run_skill', { name: v1.name }) });
  });

  // 5. promote the overfit v2 (passes train+val), then it fails the held-out seed
  await withAgent(async () => {
    log({ phase: 'promote-v2', result: await mcpCall('promote_skill', { name: v1.name, version: 2 }) });
  });
  await withSeed(9001, 'test', async () => {
    await fixture(1);
    log({ phase: 'replay-v2', seed: 9001, result: await mcpCall('run_skill', { name: v1.name }) });
  });

  // 6. roll back the bad version
  await withAgent(async () => {
    log({ phase: 'rollback-v2', result: await mcpCall('rollback_skill', { name: v1.name, reason: 'v2 fails held-out test seed 9001' }) });
  });

  console.log('G3-RUNNER-DONE');
}

main().catch((e) => { console.error('G3 runner failed:', e?.stack || e); process.exit(1); });
