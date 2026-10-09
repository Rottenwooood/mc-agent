#!/usr/bin/env node
// M5 benchmark runner (agent-driven via MCP, no hardcoded steps).
//
// For each case (task × fixed seed):
//   1. reset-world(seed)                      — hard world isolation
//   2. start the resident (agent body)
//   3. apply the task fixture (fake-player setup)
//   4. drive the agent with a real LLM over MCP: headless `opencode run` (goal only)
//   5. judge with the task's INDEPENDENT verifier (reads the observer directly)
//   6. write an episode record
// The runner encodes NO task steps and NO success rule.
//
//   node tests/eval/runner.mjs [--tasks T1,T3] [--seeds 5001,5002] [--model opencode-go/deepseek-v4.1-flash]
//                              [--agent Full-Auto] [--out /tmp/opencode/bench]

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BASE = process.env.MCAGENT_OBSERVER ?? 'http://127.0.0.1:8765';
const SOCK = '/tmp/opencode/mc-agent.sock';
const MF = 'packages/adapters/mineflayer';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const TASKS = String(opt('tasks', 'T1,T3')).split(',').map((s) => s.trim());
const SEEDS = String(opt('seeds', readFileSync(path.join(ROOT, 'scenarios/seeds.txt'), 'utf8').split('\n')[0])).split(',').map((s) => s.trim());
const MODEL = opt('model', 'opencode-go/deepseek-v4.1-flash');
const AGENT = opt('agent', 'Full-Auto');
const OUT = opt('out', '/tmp/opencode/bench');

const sh = (cmd, a) => spawnSync(cmd, a, { cwd: ROOT, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (body) => (await fetch(BASE + '/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const health = async () => (await fetch(BASE + '/health')).json();

let resident = null;
function startResident() {
  resident = spawn('node', ['apps/agent/dist/main-resident.js'], {
    cwd: ROOT,
    env: { ...process.env, MCAGENT_ACTIONS: path.join(OUT, 'actions.json'), MCAGENT_SKILLS: path.join(OUT, 'skills.json') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  resident.stderr?.on('data', (d) => writeFileSync(path.join(OUT, 'resident.log'), String(d), { flag: 'a' }));
}
function stopResident() { if (resident) { resident.kill('SIGTERM'); resident = null; } try { rmSync(SOCK, { force: true }); } catch {} }
function waitForSocket(t = 120000) {
  return new Promise((res, rej) => { const dl = Date.now() + t; const a = () => { const s = net.connect(SOCK); s.once('connect', () => { s.destroy(); res(); }); s.once('error', () => { s.destroy(); Date.now() > dl ? rej(new Error('socket')) : setTimeout(a, 800); }); }; a(); });
}
function mcpCall(name, a = {}, ms = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['apps/agent/dist/main-bridge.js'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = ''; const byId = new Map(); const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    child.stdout.on('data', (d) => { buf += d.toString(); const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) if (l.trim()) { let m; try { m = JSON.parse(l); } catch { continue; } if (m.id && byId.has(m.id)) byId.get(m.id)(m); } });
    const wait = (id) => new Promise((r) => byId.set(id, r));
    const t = setTimeout(() => { child.kill(); reject(new Error('mcp timeout')); }, ms);
    (async () => {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bench', version: '0' } } });
      await wait(1); send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: a } });
      const r = await wait(2); clearTimeout(t); child.kill();
      const text = r?.result?.content?.map((x) => x.text).join('\n'); try { resolve(JSON.parse(text)); } catch { resolve({ raw: text }); }
    })().catch(reject);
  });
}
async function botPos() { const s = await mcpCall('get_self_status', {}, 15000); return s.data.pos; }

/** Start the resident and wait for its socket, retrying on a transient bot-connect failure. */
async function startResidentReady() {
  for (let attempt = 0; attempt < 3; attempt++) {
    stopResident();
    startResident();
    try {
      await waitForSocket(90000);
      await sleep(3000);
      await botPos();
      return;
    } catch {
      console.log(`  (resident not ready, retry ${attempt + 1}/3)`);
      await sleep(5000);
    }
  }
  throw new Error('resident did not come up after retries');
}

async function applyFixture(task) {
  const [bx, by, bz] = await botPos();
  const x = Math.floor(bx), y = Math.floor(by), z = Math.floor(bz);
  if (task.fixture.kind === 'tree') {
    sh('node', ['tools/setup-bot.mjs', MF, 'fixture-at', String(x + 2), String(y), String(z), String(task.fixture.logs ?? 3)]);
    return {};
  } else if (task.fixture.kind === 'build_site') {
    sh('node', ['tools/setup-bot.mjs', MF, 'cmd', `give Bot minecraft:mangrove_planks ${task.fixture.planks ?? 8}`]);
    const mx = x + 2, my = y, mz = z;
    sh('node', ['tools/setup-bot.mjs', MF, 'cmd', `setblock ${mx} ${my} ${mz} minecraft:glowstone`]);
    // target: the 2x2 ground area directly south of the marker
    return { box: [mx, my - 1, mz + 1, mx + 1, my - 1, mz + 2] };
  } else {
    throw new Error('unknown fixture ' + task.fixture.kind);
  }
}

async function collectBaseline(task, fixtureInfo) {
  const h = await health();
  if (task.verifier === 't1') {
    const inv = await post({ scope: { kind: 'egocentric', r: 0 }, want: ['inventory'], player: 'Bot' });
    const logs = new Set(((await (await fetch(BASE + '/tags')).json()).blocks['minecraft:logs']) ?? []);
    const before = (inv.inventory ?? []).filter((i) => logs.has(i.item)).reduce((a, b) => a + b.count, 0);
    return { epoch: h.event_epoch, seq: h.event_seq, beforeLogCount: before };
  }
  if (task.verifier === 't3') {
    return { box: fixtureInfo.box };
  }
  return {};
}

function runVerifier(task, base, episode) {
  const v = task.verifier;
  let r;
  if (v === 't1') r = sh('node', ['tests/eval/verifiers/t1.mjs', '--epoch', String(base.epoch), '--since', String(base.seq), '--before-log-count', String(base.beforeLogCount), '--player', 'Bot', '--min', '3']);
  else if (v === 't3') r = sh('node', ['tests/eval/verifiers/t3.mjs', '--box', base.box.join(','), '--block', 'minecraft:mangrove_planks']);
  else throw new Error('unknown verifier ' + v);
  episode.verifierExit = r.status;
  episode.pass = r.status === 0;
}

function driveAgent(task, transcriptPath, budgetMs) {
  return new Promise((resolve) => {
    const child = spawn('opencode', ['run', '--model', MODEL, '--agent', AGENT, '--auto', '--format', 'json', task.goal], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true, out }); }, budgetMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ timedOut: false, code, out }); });
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const episodes = [];
  const startWall = Date.now();
  for (const taskId of TASKS) {
    const task = JSON.parse(readFileSync(path.join(ROOT, 'scenarios/tasks', taskId + '.json'), 'utf8'));
    for (const seed of SEEDS) {
      const ep = { task: task.id, seed, model: MODEL, startedAt: new Date().toISOString() };
      const t0 = Date.now();
      console.log(`\n=== ${task.id} @ seed ${seed} ===`);
      stopResident();
      sh('tools/reset-world.sh', [String(seed)]);
      await sleep(10000); // let the fresh server become ready to accept the bot
      await startResidentReady();
      const fixtureInfo = await applyFixture(task);
      const base = await collectBaseline(task, fixtureInfo);
      ep.baseline = base;
      const transcriptPath = path.join(OUT, `transcript-${task.id}-${seed}.jsonl`);
      const r = await driveAgent(task, transcriptPath, task.budgetMs ?? 300000);
      writeFileSync(transcriptPath, r.out);
      ep.timedOut = r.timedOut;
      ep.exitCode = r.code ?? null;
      ep.toolCalls = (r.out.match(/"type"\s*:\s*"tool"/g) ?? []).length;
      ep.wallMs = Date.now() - t0;
      ep.bytes = r.out.length;
      runVerifier(task, base, ep);
      ep.endedAt = new Date().toISOString();
      console.log(`  -> verifier ${ep.pass ? 'PASS' : 'FAIL'} (exit ${ep.verifierExit}), wall ${(ep.wallMs / 1000).toFixed(0)}s, tool events ${ep.toolCalls}`);
      episodes.push(ep);
    }
  }
  stopResident();
  const summary = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    seeds: SEEDS,
    tasks: TASKS,
    cases: episodes.length,
    completed: episodes.filter((e) => e.pass).length,
    completionRate: episodes.length ? episodes.filter((e) => e.pass).length / episodes.length : 0,
    timedOut: episodes.filter((e) => e.timedOut).length,
    episodes,
    wallMs: Date.now() - startWall,
  };
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(summary, null, 2));
  console.log('\n=== GF summary ===');
  console.log(JSON.stringify({ cases: summary.cases, completed: summary.completed, completionRate: summary.completionRate, timedOut: summary.timedOut }, null, 2));
  console.log('report:', path.join(OUT, 'report.json'));
}

main().catch((e) => { console.error('runner failed:', e?.stack || e); stopResident(); process.exit(1); });
