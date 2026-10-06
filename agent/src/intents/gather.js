'use strict';

// Intent: gather (chop / mine) N of a block type in survival.
// Target finding uses the privileged observer; digging + pickup are local (Mineflayer).
// Verification is done by the caller against authoritative server state.

const { goals } = require('mineflayer-pathfinder');
const { withTimeout, countInv } = require('../lib/util');

async function moveNear(bot, x, y, z, r, ms) {
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(x, y, z, r)), ms, 'goto');
  } catch (e) { /* best effort; dig loop will retry */ }
}

/**
 * @returns {{dug:number[][], clientCount:number, attempts:number}}
 */
async function chopTree(bot, obs, mcData, { user, block, count }) {
  const short = block.split(':')[1];
  const id = mcData.blocksByName[short] && mcData.blocksByName[short].id;
  if (id == null) throw new Error('unknown block ' + block);

  const near = await obs.nearest(user, block, 48);
  if (near.found) {
    await moveNear(bot, near.pos[0], near.pos[1], near.pos[2], 2, 20000);
  }

  const dug = [];
  let attempts = 0;
  while (dug.length < count && attempts < 40) {
    attempts += 1;
    const blk = bot.findBlock({ matching: id, maxDistance: 24 });
    if (!blk) break;
    try {
      if (bot.entity.position.distanceTo(blk.position) > 3.5) {
        await moveNear(bot, blk.position.x, blk.position.y, blk.position.z, 2, 12000);
      }
      await bot.lookAt(blk.position.offset(0.5, 0.5, 0.5), true);
      await withTimeout(bot.dig(blk), 8000, 'dig');
      dug.push([blk.position.x, blk.position.y, blk.position.z]);
    } catch (e) { /* retry */ }
  }

  // pick up drops
  let tries = 0;
  while (tries++ < 30 && countInv(bot, short) < count) {
    const item = bot.nearestEntity((e) => e && e.name === 'item');
    if (!item) { await bot.waitForTicks(10); continue; }
    await moveNear(bot, item.position.x, item.position.y, item.position.z, 1, 8000);
    await bot.waitForTicks(5);
  }

  return { dug, clientCount: countInv(bot, short), attempts };
}

module.exports = { chopTree, moveNear };
