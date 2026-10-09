#!/usr/bin/env node
// Dependency-free debug visualization: a top-down map of the surface around the bot, read
// straight from the observer mod. Prints an ANSI map to the terminal and (optionally) writes a
// colored HTML grid. This is dev tooling; it never touches the agent's control loop.
//
//   node tools/view.mjs [--player Bot] [--radius 20] [--html /tmp/opencode/view.html] [--watch]
//
// NOTE: prismarine-viewer (3D) is deferred — it requires the native `canvas` module, which is
// not installable in this environment. This renderer covers the "visible" debugging need.

import { writeFileSync } from 'node:fs';

const BASE = process.env.MCAGENT_OBSERVER ?? 'http://127.0.0.1:8765';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const PLAYER = opt('player', 'Bot');
const RADIUS = Number(opt('radius', 20));
const HTML = opt('html', null);
const WATCH = args.includes('--watch');

const post = async (body) => {
  const r = await fetch(BASE + '/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('snapshot ' + r.status);
  return r.json();
};

// block id -> { ch, color (hex), ansi }
function style(id) {
  const n = id.replace('minecraft:', '');
  if (/water|bubble/.test(n)) return { ch: '~', hex: '#2b6cff', ansi: '\x1b[34m' };
  if (/lava|magma/.test(n)) return { ch: '~', hex: '#ff5a1f', ansi: '\x1b[91m' };
  if (/_leaves$|vine|moss_carpet|azalea/.test(n)) return { ch: '^', hex: '#2f9e44', ansi: '\x1b[32m' };
  if (/_log$|_wood$|stripped/.test(n)) return { ch: '|', hex: '#8a5a2b', ansi: '\x1b[33m' };
  if (/grass_block|moss_block/.test(n)) return { ch: '"', hex: '#4c9a2a', ansi: '\x1b[92m' };
  if (/dirt|podzol|mud|roots/.test(n)) return { ch: '.', hex: '#7a5230', ansi: '\x1b[33m' };
  if (/sand|gravel/.test(n)) return { ch: ':', hex: '#d8c98a', ansi: '\x1b[93m' };
  if (/_ore$/.test(n)) return { ch: '*', hex: '#22d3ee', ansi: '\x1b[96m' };
  if (/planks|bamboo|scaffolding/.test(n)) return { ch: '=', hex: '#c8a05a', ansi: '\x1b[33m' };
  if (/stone|cobble|andesite|diorite|granite|deepslate|tuff|bedrock/.test(n)) return { ch: '#', hex: '#8b8b8b', ansi: '\x1b[90m' };
  if (/snow|ice/.test(n)) return { ch: 's', hex: '#e8f4ff', ansi: '\x1b[97m' };
  return { ch: '?', hex: '#b06bd6', ansi: '\x1b[35m' };
}

async function render() {
  const self = await post({ scope: { kind: 'egocentric', r: 0 }, want: ['self'], player: PLAYER });
  const [px, py, pz] = self.self.pos;
  const cx = Math.round(px), cy = Math.round(py), cz = Math.round(pz);
  const box = { min: [cx - RADIUS, cy - 8, cz - RADIUS], max: [cx + RADIUS, cy + 8, cz + RADIUS] };
  const snap = await post({ scope: { kind: 'box', min: box.min, max: box.max }, want: ['blocks'], exposed_only: true, max_items: 60000, player: PLAYER });
  const top = new Map(); // "x,z" -> { y, block }
  for (const c of snap.blocks ?? []) {
    const k = c.pos[0] + ',' + c.pos[2];
    const cur = top.get(k);
    if (!cur || c.pos[1] > cur.y) top.set(k, { y: c.pos[1], block: c.block });
  }

  let ansi = '';
  const cells = [];
  for (let z = box.min[2]; z <= box.max[2]; z++) {
    const row = [];
    for (let x = box.min[0]; x <= box.max[0]; x++) {
      if (x === cx && z === cz) { ansi += '\x1b[1;97m@\x1b[0m'; row.push({ ch: '@', hex: '#ffffff', id: 'player' }); continue; }
      const t = top.get(x + ',' + z);
      if (!t) { ansi += ' '; row.push({ ch: ' ', hex: '#101014', id: 'air/unknown' }); continue; }
      const s = style(t.block);
      ansi += s.ansi + s.ch + '\x1b[0m';
      row.push({ ch: s.ch, hex: s.hex, id: t.block });
    }
    ansi += '\n';
    cells.push(row);
  }

  console.log(`surface map  player=(${cx},${cy},${cz})  radius=${RADIUS}  truncated=${snap.coverage?.truncated ?? false}  (north=top, west=left; @ = bot)`);
  process.stdout.write(ansi);

  if (HTML) {
    const cell = (c) => `<div class="c" style="background:${c.hex}" title="${c.id}">${c.ch === ' ' ? '' : c.ch}</div>`;
    const grid = cells.map((row) => `<div class="r">${row.map(cell).join('')}</div>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><title>mc-agent view</title>
<style>body{background:#0b0b10;color:#ddd;font:12px/1 ui-monospace,monospace;margin:12px}
.r{display:flex}.c{width:14px;height:14px;display:flex;align-items:center;justify-content:center;color:#000;font-weight:700}
h3{font-family:sans-serif;font-weight:600}</style>
<h3>mc-agent surface view — player (${cx},${cy},${cz}) r=${RADIUS}</h3>${grid}
<p>@ bot · # stone · ^ leaves · | log · . dirt · : sand · * ore · = planks · ~ water/lava · ? other</p>`;
    writeFileSync(HTML, html);
    console.log('html written:', HTML);
  }
  return snap;
}

async function main() {
  await render();
  if (WATCH) {
    setInterval(() => { render().catch((e) => console.error('view error', e.message)); }, 2000);
  }
}
main().catch((e) => { console.error('view error:', e.message); process.exit(1); });
