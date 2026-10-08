// Intent: gather N of a block into the inventory. Semantic (no coordinates exposed):
// find -> approach -> dig -> pick up -> verify against authoritative inventory.

import type { ActionResult, ControlPort, ItemStack, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import type { World } from '@mc-agent/world';
import { mk, pass, fail } from '../result.js';
import type { ControlToken } from '../token.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function count(world: World, block: string): Promise<number> {
  const inv = await world.inventory();
  if (isUnknown(inv)) return 0;
  return inv.value.filter((i: ItemStack) => i.item === block).reduce((s, i) => s + i.count, 0);
}

export interface GatherSpec {
  block: string;
  count: number;
  radius?: number;
  budgetMs?: number;
}

export async function gatherBlock(world: World, ctrl: ControlPort, token: ControlToken, spec: GatherSpec): Promise<ActionResult> {
  const radius = spec.radius ?? 48;
  const budgetMs = spec.budgetMs ?? 120000;
  const started = Date.now();
  const before = await count(world, spec.block);
  const dug: Vec3[] = [];
  const evidence: ActionResult['evidence'] = [];

  while (Date.now() - started < budgetMs) {
    const have = await count(world, spec.block);
    if (have - before >= spec.count) {
      return pass({
        evidence,
        resources: { inventoryDelta: { [spec.block]: have - before } },
        effects: dug.map((p) => ({ subject: `block@${p.join(',')}`, predicate: 'is', after: 'minecraft:air' })),
        attribution: 'self_temporal',
      });
    }

    const found = await world.findNearestBlock(spec.block, radius);
    if (isUnknown(found)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', controlStatus: 'needs_replan' });
    if (!found.value) return fail('precondition_failed', { evidence: [{ claim: 'no_target_found', source: 'authoritative', value: spec.block }] });

    const hit = found.value;
    const dugOk = await token.run(async () => {
      const g = await ctrl.goto(hit.pos, { range: 2 });
      if (!g.accepted) return false;
      const d = await ctrl.dig(hit.pos);
      if (!d.accepted) return false;
      // Walk onto the drop to collect it.
      await ctrl.goto(hit.pos, { range: 1 });
      return true;
    });

    const after = await world.blockAt(hit.pos);
    const removed = !isUnknown(after) && after.value !== spec.block;
    evidence.push({ claim: 'block_removed', source: 'authoritative', value: removed ? after.value : 'unchanged', tick: isUnknown(after) ? undefined : after.observedTick });
    if (dugOk && removed) dug.push(hit.pos);
    await sleep(300);
  }

  const have = await count(world, spec.block);
  if (have - before >= spec.count) {
    return pass({ evidence, resources: { inventoryDelta: { [spec.block]: have - before } }, attribution: 'self_temporal' });
  }
  return fail('timeout', { evidence, resources: { inventoryDelta: { [spec.block]: have - before } } });
}
