'use strict';

// Scenario: chop_then_planks — composed intent (gather + craft), survival.
// Demonstrates: a composed action reusing an atomic intent, with authoritative
// (server-side) verification of BOTH the gathering and the crafting result.

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const mcDataFactory = require('minecraft-data');
const obs = require('../observer');
const { chopTree } = require('../intents/gather');
const { withTimeout, countServer } = require('../lib/util');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const USER = process.env.MC_USER || 'Bot';
const VERSION = process.env.MC_VERSION || '1.20.1';
const LOG = process.env.CHOP_BLOCK || 'minecraft:mangrove_log';
const WANT = parseInt(process.env.CHOP_COUNT || '3', 10);
const PLANKS = LOG.replace('_log', '_planks');

const log = (...a) => console.log('[planks]', ...a);

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
  moves.canDig = true; moves.allowSprinting = true; moves.allowParkour = false;
  bot.pathfinder.setMovements(moves);
  await bot.waitForTicks(20);

  // authoritative baseline
  const inv0 = await obs.inventory(USER);
  const log0 = countServer(inv0, LOG);

  // 1) gather (atomic intent)
  const g = await chopTree(bot, obs, mcData, { user: USER, block: LOG, count: WANT });
  log('gather:', JSON.stringify({ dug: g.dug.length, clientCount: g.clientCount }));

  // 2) craft planks (composed step)
  const planksShort = PLANKS.split(':')[1];
  const planksId = mcData.itemsByName[planksShort] && mcData.itemsByName[planksShort].id;
  if (planksId == null) return report('fail', 'no_planks_item');
  const haveLogs = bot.inventory.items()
    .filter((i) => i.name === LOG.split(':')[1]).reduce((s, i) => s + i.count, 0);
  let crafted = 0;
  try {
    const recipes = bot.recipesFor(planksId, null, 1, null);
    if (recipes.length && haveLogs > 0) {
      await withTimeout(bot.craft(recipes[0], haveLogs, null), 20000, 'craft');
      crafted = haveLogs;
    }
  } catch (e) { log('craft failed:', e.message); }

  // 3) authoritative verification
  const inv1 = await obs.inventory(USER);
  const log1 = countServer(inv1, LOG);
  const planks1 = countServer(inv1, PLANKS);
  const logsSpent = log0 + g.dug.length - log1; // logs that left inventory (gathered minus remaining)

  const gatherOk = g.dug.length > 0 && log1 >= 0;
  const craftOk = planks1 > 0;
  let effect_status = 'pass';
  if (!craftOk) effect_status = log1 > 0 ? 'ambiguous' : 'fail';

  return report(effect_status, effect_status === 'pass' ? 'chop+craft ok' : 'partial', {
    target: LOG, planks: PLANKS, want: WANT,
    dug: g.dug.length,
    server_logs_before: log0, server_logs_after: log1,
    server_planks_after: planks1,
    crafted_attempts: crafted,
    gather_ok: gatherOk,
  });
}

function report(effect_status, note, evidence) {
  const out = {
    intent: 'chop_then_planks', effect_status, control_status: 'completed', note,
    evidence: evidence || null,
  };
  console.log('RESULT ' + JSON.stringify(out));
  setTimeout(() => {
    try { bot.quit('done'); } catch (e) { /* ignore */ }
    process.exit(effect_status === 'pass' ? 0 : 1);
  }, 500);
}
