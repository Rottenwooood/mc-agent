#!/usr/bin/env node
// Independent T3 verifier: every cell of the target box holds the target block (voxel set
// difference = empty). Reads the server-authoritative observer directly.
//
//   node t3.mjs --box x1,y1,z1,x2,y2,z2 --block minecraft:mangrove_planks
// Exit: 0 = pass, 2 = fail, 64 = usage.

const BASE = process.env.MCAGENT_OBSERVER ?? 'http://127.0.0.1:8765';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const box = opt('box', null);
const block = opt('block', 'minecraft:mangrove_planks');
if (!box) { console.error('usage: t3.mjs --box x1,y1,z1,x2,y2,z2 --block <id>'); process.exit(64); }
const [x1, y1, z1, x2, y2, z2] = box.split(',').map(Number);
const min = [Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2)];
const max = [Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2)];
const vol = (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1);

const r = await fetch(BASE + '/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: { kind: 'box', min, max }, want: ['blocks'], max_items: 8192 }) });
const snap = await r.json();
const cells = snap.blocks ?? [];
const wrong = cells.filter((c) => c.block !== block);
const pass = cells.length === vol && wrong.length === 0;
console.log(JSON.stringify({ pass, task: 'T3', volume: vol, present: cells.length, wrong: wrong.slice(0, 8), box: { min, max }, block }, null, 2));
process.exit(pass ? 0 : 2);
