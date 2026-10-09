#!/usr/bin/env node
// Independent T1 verifier: at least N log blocks were broken by the player (actor=player) AND the
// player's log inventory grew by at least N. Reads the server-authoritative observer directly and
// never reuses any system predicate/verdict.
//
//   node t1.mjs --epoch E --since S --before-log-count M --player Bot [--min 3]
// Exit: 0 = pass, 2 = fail, 64 = usage.

const BASE = process.env.MCAGENT_OBSERVER ?? 'http://127.0.0.1:8765';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const getJson = async (p) => { const r = await fetch(BASE + p); if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); };
const postJson = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); };

const player = opt('player', 'Bot');
const epoch = Number(opt('epoch'));
const since = Number(opt('since'));
const before = Number(opt('before-log-count', '0'));
const min = Number(opt('min', '3'));
if (Number.isNaN(epoch) || Number.isNaN(since)) { console.error('usage: t1.mjs --epoch E --since S --before-log-count M --player Bot [--min N]'); process.exit(64); }

const logs = new Set(((await getJson('/tags')).blocks['minecraft:logs']) ?? []);
const inv = await postJson('/snapshot', { scope: { kind: 'egocentric', r: 0 }, want: ['inventory'], player });
const after = (inv.inventory ?? []).filter((i) => logs.has(i.item)).reduce((a, b) => a + b.count, 0);

const events = [];
let seq = since;
for (let i = 0; i < 100; i++) {
  const p = await getJson(`/events?epoch=${epoch}&seq=${seq}&max=2048`);
  if (p.reset_required) { events.length = 0; break; }
  events.push(...p.events);
  seq = p.cursor.seq;
  if (!p.has_more) break;
}
const removals = events.filter((e) => e.actor === player && logs.has(e.before) && e.after === 'minecraft:air' && e.seq > since);
const delta = after - before;
const pass = removals.length >= min && delta >= min;
console.log(JSON.stringify({ pass, task: 'T1', log_removals_by_player: removals.length, min, before_log_count: before, after_log_count: after, inventory_delta: delta, removals: removals.slice(0, 6) }, null, 2));
process.exit(pass ? 0 : 2);
