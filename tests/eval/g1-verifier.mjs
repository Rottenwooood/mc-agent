#!/usr/bin/env node
// G1 independent verifier. Reads the server-authoritative observer directly and never
// reuses any system predicate/result. It proves a real action happened (a log block was
// broken by the player) AND a real pickup happened (inventory log count increased).
//
//   node g1-verifier.mjs collect [--player Bot]
//   node g1-verifier.mjs verify --epoch E --since S --before-log-count N [--player Bot]
//
// Exit codes: 0 = pass, 2 = fail, 64 = usage error.

const BASE = process.env.MCAGENT_OBSERVER ?? 'http://127.0.0.1:8765';
const TOKEN = process.env.MCAGENT_OBSERVER_TOKEN;
const headers = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};

const getJson = async (p) => {
  const r = await fetch(BASE + p, { headers });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};
const postJson = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};

const logsSet = async () => new Set((await getJson('/tags')).blocks['minecraft:logs'] ?? []);

const logCount = async (player) => {
  const s = await postJson('/snapshot', { scope: { kind: 'egocentric', r: 0 }, want: ['inventory'], player });
  const logs = await logsSet();
  return (s.inventory ?? []).filter((i) => logs.has(i.item)).reduce((a, b) => a + b.count, 0);
};

const allEvents = async (epoch, since) => {
  const out = [];
  let seq = since;
  for (let i = 0; i < 100; i++) {
    const p = await getJson(`/events?epoch=${epoch}&seq=${seq}&max=2048`);
    if (p.reset_required) return { reset: true, events: out };
    out.push(...p.events);
    seq = p.cursor.seq;
    if (!p.has_more) break;
  }
  return { reset: false, events: out };
};

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};

if (cmd === 'collect') {
  const player = opt('player', 'Bot');
  const h = await getJson('/health');
  console.log(JSON.stringify({ epoch: h.event_epoch, seq: h.event_seq, logCount: await logCount(player), player }));
} else if (cmd === 'verify') {
  const player = opt('player', 'Bot');
  const epoch = Number(opt('epoch'));
  const since = Number(opt('since'));
  const before = Number(opt('before-log-count'));
  const h = await getJson('/health');
  const after = await logCount(player);
  const logs = await logsSet();
  const { reset, events } = await allEvents(epoch, since);
  const removals = events.filter(
    (e) => e.actor === player && logs.has(e.before) && e.after === 'minecraft:air' && e.seq > since,
  );
  const inventoryDelta = after - before;
  const pass = !reset && removals.length >= 1 && inventoryDelta >= 1;
  console.log(
    JSON.stringify(
      {
        pass,
        reset_required: reset,
        log_removals_by_player: removals.length,
        removals: removals.slice(0, 5),
        before_log_count: before,
        after_log_count: after,
        inventory_delta: inventoryDelta,
        epoch: h.event_epoch,
      },
      null,
      2,
    ),
  );
  process.exit(pass ? 0 : 2);
} else {
  console.error('usage: g1-verifier.mjs collect|verify ...');
  process.exit(64);
}
