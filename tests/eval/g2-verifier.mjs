#!/usr/bin/env node
// G2 independent verifier. Reads the server-authoritative observer directly (never the
// system's own verdicts). Two independent checks (a mine and a build) plus a repair check
// that requires an *external* removal (actor != player) followed by a player re-placement.
//
//   collect  --box x1,y1,z1,x2,y2,z2 --player Bot [--ore id] [--item id]
//   verify-mine  --box ... --ore <id> --expected-ore N --item <id> --before-item-count M [--player Bot]
//   verify-build --box ... --block <id>
//   verify-repair --pos x,y,z --block <id> --epoch E --since S [--player Bot]
//
// Exit: 0 = pass, 2 = fail, 64 = usage.

const BASE = process.env.MCAGENT_OBSERVER ?? 'http://127.0.0.1:8765';
const TOKEN = process.env.MCAGENT_OBSERVER_TOKEN;
const headers = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};

const getJson = async (p) => {
  const r = await fetch(BASE + p, { headers });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};
const postJson = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};

const parseBox = (s) => {
  const [x1, y1, z1, x2, y2, z2] = s.split(',').map(Number);
  return { min: [Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2)], max: [Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2)] };
};
const parseVec = (s) => s.split(',').map(Number);

const queryBlocks = async (box) => {
  const r = await postJson('/snapshot', { scope: { kind: 'box', min: box.min, max: box.max }, want: ['blocks'], max_items: 8192 });
  return r.blocks ?? [];
};
const blockAt = async (pos) => {
  const cells = await queryBlocks({ min: pos, max: pos });
  return cells.length ? cells[0].block : 'minecraft:air';
};
const itemCount = async (player, item) => {
  const s = await postJson('/snapshot', { scope: { kind: 'egocentric', r: 0 }, want: ['inventory'], player });
  return (s.inventory ?? []).filter((i) => i.item === item).reduce((a, b) => a + b.count, 0);
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
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 ? args[i + 1] : d;
};
const health = await getJson('/health');

if (cmd === 'collect') {
  const box = parseBox(opt('box'));
  const player = opt('player', 'Bot');
  const ore = opt('ore', 'minecraft:coal_ore');
  const item = opt('item', 'minecraft:coal');
  const cells = await queryBlocks(box);
  console.log(
    JSON.stringify({
      epoch: health.event_epoch,
      seq: health.event_seq,
      boxBlocks: cells.length,
      oreCount: cells.filter((c) => c.block === ore).length,
      itemCount: await itemCount(player, item),
    }),
  );
} else if (cmd === 'verify-mine') {
  const box = parseBox(opt('box'));
  const ore = opt('ore', 'minecraft:coal_ore');
  const item = opt('item', 'minecraft:coal');
  const player = opt('player', 'Bot');
  const expected = Number(opt('expected-ore', '0'));
  const before = Number(opt('before-item-count', '0'));
  const cells = await queryBlocks(box);
  const oreLeft = cells.filter((c) => c.block === ore).length;
  const after = await itemCount(player, item);
  const delta = after - before;
  const pass = oreLeft === 0 && delta >= expected && expected > 0;
  console.log(JSON.stringify({ pass, ore_left: oreLeft, expected_ore: expected, item_delta: delta, item_after: after }, null, 2));
  process.exit(pass ? 0 : 2);
} else if (cmd === 'verify-build') {
  const box = parseBox(opt('box'));
  const block = opt('block', 'minecraft:mangrove_planks');
  const vol = (box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) * (box.max[2] - box.min[2] + 1);
  const cells = await queryBlocks(box);
  const wrong = cells.filter((c) => c.block !== block);
  const pass = cells.length === vol && wrong.length === 0;
  console.log(JSON.stringify({ pass, volume: vol, present: cells.length, wrong: wrong.slice(0, 8) }, null, 2));
  process.exit(pass ? 0 : 2);
} else if (cmd === 'verify-repair') {
  const pos = parseVec(opt('pos'));
  const block = opt('block', 'minecraft:mangrove_planks');
  const player = opt('player', 'Bot');
  const epoch = Number(opt('epoch'));
  const since = Number(opt('since'));
  const finalBlock = await blockAt(pos);
  const { reset, events } = await allEvents(epoch, since);
  const at = events.filter((e) => e.pos && e.pos[0] === pos[0] && e.pos[1] === pos[1] && e.pos[2] === pos[2]);
  const externalRemoval = at.find((e) => e.actor !== player && e.after === 'minecraft:air' && e.before === block);
  const playerReplace = externalRemoval
    ? at.find((e) => e.seq > externalRemoval.seq && e.actor === player && e.after === block)
    : undefined;
  const pass = !reset && finalBlock === block && !!externalRemoval && !!playerReplace;
  console.log(
    JSON.stringify(
      {
        pass,
        final_block: finalBlock,
        external_removal_seq: externalRemoval?.seq ?? null,
        player_replace_seq: playerReplace?.seq ?? null,
        events_at_pos: at,
      },
      null,
      2,
    ),
  );
  process.exit(pass ? 0 : 2);
} else {
  console.error('usage: g2-verifier.mjs collect|verify-mine|verify-build|verify-repair ...');
  process.exit(64);
}
