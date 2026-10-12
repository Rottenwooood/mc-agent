// Item-drop collection. Breaking a block and obtaining its drop are DIFFERENT results
// (docs/minecraft-framework.md §; the eval T1 gate checks both). The body breaks blocks
// (`set_block`/`dig`); `collect` walks the body onto the nearby item entities so the drops
// enter the inventory, then verifies the authoritative inventory delta.
//
// It composes the existing `goto` primitive (no new ControlPort method), so it works for
// every backend (mineflayer / client-mod) unchanged.

import type { ActionResult, ItemStack, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { distance } from '@mc-agent/world';
import { mk, pass } from '../result.js';
import type { AtomicAction } from './types.js';
import { contract } from './types.js';

const ITEM = 'minecraft:item';

function totalOf(inv: readonly ItemStack[]): number {
  return inv.reduce((s, i) => s + i.count, 0);
}

function deltaOf(before: readonly ItemStack[], after: readonly ItemStack[]): Record<string, number> {
  const b = new Map(before.map((i) => [i.item, i.count]));
  const a = new Map(after.map((i) => [i.item, i.count]));
  const out: Record<string, number> = {};
  for (const [item, count] of a) {
    const d = count - (b.get(item) ?? 0);
    if (d > 0) out[item] = d;
  }
  return out;
}

const collect: AtomicAction = {
  contract: contract({
    name: 'collect',
    description:
      'Pick up nearby dropped items: walk the body onto item entities within `radius` so the drops enter the inventory, and verify the inventory grew. Use after mining (breaking a block and obtaining its drop are separate results).',
    params: {
      type: 'object',
      properties: { radius: { type: 'number', default: 8 }, max: { type: 'integer', default: 24 } },
      additionalProperties: false,
    },
    verificationMode: 'state_effect',
    effectClass: 'idempotent',
    retryPolicy: 'safe_once',
    timeoutTicks: 600,
  }),
  async run(ctx, args): Promise<ActionResult> {
    const radius = Number(args.radius ?? 8);
    const max = Number(args.max ?? 24);
    return ctx.token.run(async () => {
      const inv0 = await ctx.world.inventory();
      if (isUnknown(inv0)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', reasonDetail: 'inventory not observed' });
      const before = inv0.value;
      let visited = 0;
      let lastNote: string | undefined;
      for (let round = 0; round < max; round++) {
        const ents = await ctx.world.entities(radius);
        if (isUnknown(ents)) break;
        const drops = ents.value.filter((e) => e.type === ITEM);
        if (drops.length === 0) break;
        const self = await ctx.world.selfPos();
        drops.sort((a, b) => (self ? distance(self, a.pos) - distance(self, b.pos) : 0));
        const target: Vec3 = drops[0]!.pos;
        const r = await ctx.ctrl.goto(target, { range: 1 });
        visited++;
        if (!r.accepted) {
          lastNote = r.note;
          break;
        }
      }
      const inv1 = await ctx.world.inventory();
      if (isUnknown(inv1)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', reasonDetail: 'inventory not observed' });
      const after = inv1.value;
      const delta = deltaOf(before, after);
      const gained = totalOf(after) - totalOf(before);
      const evidence = [{ claim: 'inv_count', source: 'authoritative' as const, before: totalOf(before), after: totalOf(after) }];
      if (gained > 0) {
        return pass({ resources: { inventoryDelta: delta }, evidence, attribution: 'self_temporal' });
      }
      return mk({
        effectStatus: 'fail',
        reason: 'effect_not_observed',
        reasonDetail: `no items picked up (visited ${visited} drop(s))${lastNote ? `: ${lastNote}` : ''}`,
        evidence,
      });
    });
  },
};

export const itemActions: AtomicAction[] = [collect];
