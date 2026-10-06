'use strict';

// Small assertion helpers evaluated against the privileged (authoritative) observer.
// These mirror the "pre-declared, program-evaluated postcondition" idea: checks return
// structured evidence, and verdict() maps a set of checks to an effect_status.

const obs = require('./observer');
const { countServer } = require('./lib/util');

async function blockIs(x, y, z, expected) {
  const b = await obs.block(x, y, z);
  return { name: 'block_is', ok: b.block === expected, actual: b.block, expected, pos: [x, y, z] };
}

async function inventoryGte(player, itemId, n) {
  const inv = await obs.inventory(player);
  const actual = countServer(inv, itemId);
  return { name: 'inventory_gte', ok: actual >= n, actual, expected: n, item: itemId };
}

// Map checks to effect_status. All checks are authoritative here, so a non-ok check is
// a confirmed failure (not merely insufficient evidence).
function verdict(checks) {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) return { effect_status: 'pass', checks };
  return { effect_status: 'fail', reason: failed.map((c) => c.name).join(','), checks };
}

module.exports = { blockIs, inventoryGte, verdict };
