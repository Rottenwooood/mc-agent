'use strict';

async function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout: ' + label)), ms); });
  try { return await Promise.race([p, to]); } finally { clearTimeout(t); }
}

// Client-side inventory count by item short name (e.g. 'mangrove_log').
function countInv(bot, short) {
  return bot.inventory.items().filter((i) => i.name === short).reduce((s, i) => s + i.count, 0);
}

// Authoritative (server) inventory count by registry id (e.g. 'minecraft:mangrove_log').
function countServer(inv, itemId) {
  return inv.items.filter((it) => it.item === itemId).reduce((s, it) => s + it.count, 0);
}

module.exports = { withTimeout, countInv, countServer };
