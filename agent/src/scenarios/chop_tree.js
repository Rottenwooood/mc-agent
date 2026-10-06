'use strict';

// Scenario: chop_tree — survival, no cheats.
// Control: Mineflayer. Target finding + verification: privileged read-only observer (Fabric mod).
//
// This is the first end-to-end vertical slice: one intent, executed locally, verified
// against authoritative server state (not the bot's own optimistic view).

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const mcDataFactory = require('minecraft-data');
const obs = require('../observer');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const USER = process.env.MC_USER || 'Bot';
const VERSION = process.env.MC_VERSION || '1.20.1';
const LOG = process.env.CHOP_BLOCK || 'minecraft:mangrove_log';
const WANT = parseInt(process.env.CHOP_COUNT || '3', 10);

const log = (...a) => console.log('[chop]', ...a);

async function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout: ' + label)), ms); });
  try { return await Promise.race([p, to]); } finally { clearTimeout(t); }
}

const bot = mineflayer.createBot({
  host: HOST, port: PORT, username: USER, version: VERSION,
  auth: 'offline', disableChatSigning: true,
});

bot.on('kicked', (r) => log('kicked', JSON.stringify(r)));
bot.on('error', (e) => log('error', e && e.message));
bot.once('spawn', () => main().catch((e) => { log('FATAL', (e && e.stack) || e); process.exit(2); }));

async function main() {
  const mcData = mcDataFactory(bot.version);
  bot.loadPlugin(pathfinder);
  const moves = new Movements(bot, mcData);
  moves.canDig = true;
  moves.allowSprinting = true;
  moves.allowParkour = false;
  bot.pathfinder.setMovements(moves);

  await bot.waitForTicks(20);

  const me0 = await obs.self(USER);
  log('observer self:', JSON.stringify(me0));
  const health = await obs.health();
  const sinceSeq = health.event_seq || 0;

  const short = LOG.split(':')[1];
  const logId = mcData.blocksByName[short] && mcData.blocksByName[short].id;
  if (logId == null) throw new Error('unknown block ' + LOG);

  // 1) authoritative target from the privileged observer
  const near = await obs.nearest(USER, LOG, 48);
  log('nearest:', JSON.stringify(near));
  if (!near.found) { return report('fail', 'no_target'); }

  // 2) walk near (Mineflayer pathfinder as the base movement graph)
  try {
    await withTimeout(
      bot.pathfinder.goto(new goals.GoalNear(near.pos[0], near.pos[1], near.pos[2], 2)),
      20000, 'goto-target');
  } catch (e) { log('goto target failed:', e.message); }

  // 3) dig up to WANT logs (local, no LLM in the loop)
  const dug = [];
  let attempts = 0;
  while (dug.length < WANT && attempts < 40) {
    attempts++;
    const blk = bot.findBlock({ matching: logId, maxDistance: 24 });
    if (!blk) { log('no more logs in range'); break; }
    try {
      if (bot.entity.position.distanceTo(blk.position) > 3.5) {
        await withTimeout(
          bot.pathfinder.goto(new goals.GoalNear(blk.position.x, blk.position.y, blk.position.z, 2)),
          12000, 'goto-block');
      }
      await bot.lookAt(blk.position.offset(0.5, 0.5, 0.5), true);
      await withTimeout(bot.dig(blk), 8000, 'dig');
      dug.push([blk.position.x, blk.position.y, blk.position.z]);
      log('dug', JSON.stringify(dug[dug.length - 1]));
    } catch (e) { log('dig attempt failed:', e.message); }
  }

  // 3b) pick up the drops (survival: the player must walk over item entities)
  await collectDrops(short, WANT);

  // 4) verify against authoritative server state (independent of the bot's own view)
  const checks = [];
  for (const [x, y, z] of dug) {
    const b = await obs.block(x, y, z);
    checks.push({ pos: [x, y, z], now: b.block, ok: b.block === 'minecraft:air' });
  }
  const invCount = await countInv(short);
  const evs = await obs.events(sinceSeq, 256);
  const mineEvents = evs.events.filter((e) => e.actor === USER && e.before === LOG);

  const targetOk = checks.length > 0 && checks.every((c) => c.ok);
  const invOk = dug.length > 0 && invCount >= Math.min(WANT, dug.length);
  const effect_status = (targetOk && invOk) ? 'pass' : (dug.length === 0 ? 'fail' : 'ambiguous');

  return report(effect_status, effect_status === 'pass' ? 'chop ok' : 'partial', {
    dug_count: dug.length,
    inventory_count: invCount,
    block_checks: checks,
    observer_events: mineEvents.map((e) => ({ pos: e.pos, tick: e.tick, actor: e.actor })),
    baseline_event_seq: sinceSeq,
  });
}

async function countInv(short) {
  return bot.inventory.items().filter((i) => i.name === short).reduce((s, i) => s + i.count, 0);
}

async function collectDrops(short, want) {
  let tries = 0;
  while (tries++ < 30) {
    if ((await countInv(short)) >= want) return;
    const item = bot.nearestEntity((e) => e && e.name === 'item');
    if (!item) { await bot.waitForTicks(10); continue; }
    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1)),
        8000, 'goto-item');
    } catch (e) { /* keep trying */ }
    await bot.waitForTicks(5);
  }
}

function report(effect_status, note, evidence) {
  const out = {
    intent: 'chop_tree', target: LOG, want: WANT,
    effect_status, control_status: 'completed', note,
    evidence: evidence || null,
  };
  console.log('RESULT ' + JSON.stringify(out));
  setTimeout(() => {
    try { bot.quit('done'); } catch (e) { /* ignore */ }
    process.exit(effect_status === 'pass' ? 0 : 1);
  }, 500);
}
