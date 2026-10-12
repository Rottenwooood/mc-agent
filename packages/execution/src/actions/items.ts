// Item-drop collection. Breaking a block and obtaining its drop are DIFFERENT results
// (docs/minecraft-framework.md §; the eval T1 gate checks both). The body breaks blocks
// (`set_block`/`dig`); `collect` walks the body onto the nearby item entities so the drops
// enter the inventory, then verifies the authoritative inventory delta.
//
// It composes the existing `goto` primitive (no new ControlPort method), so it works for
// every backend (mineflayer / client-mod) unchanged.

import type { ActionResult, ItemStack, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { distance, key } from '@mc-agent/world';
import { mk, pass } from '../result.js';
import type { AtomicAction } from './types.js';
import { contract } from './types.js';

const ITEM = 'minecraft:item';
/** Within this distance a drop is reached by a DIRECT walk, not by the pathfinder (a drop over
 *  water / behind a wall has no path, but is still a couple of steps away). */
const NEAR = 2.5;
/** Walk at most this many times the pickup radius before giving up on a drop. */
const MAX_VISIT = 24;

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
      'Pick up nearby dropped items: reach each item entity within `radius` (a direct walk for a close drop, else pathfinding) and verify the inventory grew. Use after mining (breaking a block and obtaining its drop are separate results). Drops that cannot be reached are skipped and reported, not fatal.',
    params: {
      type: 'object',
      properties: { radius: { type: 'number', default: 8 }, max: { type: 'integer', default: MAX_VISIT } },
      additionalProperties: false,
    },
    verificationMode: 'state_effect',
    effectClass: 'idempotent',
    retryPolicy: 'safe_once',
    timeoutTicks: 900,
  }),
  async run(ctx, args): Promise<ActionResult> {
    const radius = Number(args.radius ?? 8);
    const max = Number(args.max ?? MAX_VISIT);
    return ctx.token.run(async () => {
      const inv0 = await ctx.world.inventory();
      if (isUnknown(inv0)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', reasonDetail: 'inventory not observed' });
      const before = inv0.value;
      const unreachable: string[] = [];
      const dead = new Set<string>();

      // Direct, pathfinder-free nudge toward a close drop (look at it, walk forward a beat).
      const stepToward = async (target: Vec3): Promise<boolean> => {
        for (let k = 0; k < 5; k++) {
          const self = await ctx.world.selfPos();
          if (!self) return false;
          if (distance(self, target) <= 1.2) return true;
          await ctx.ctrl.lookAt(target);
          await ctx.ctrl.steer(['forward'], 250);
        }
        return false;
      };

      for (let round = 0; round < max; round++) {
        const ents = await ctx.world.entities(radius);
        if (isUnknown(ents)) break;
        const drops = ents.value.filter((e) => e.type === ITEM && !dead.has(key(e.pos)));
        if (drops.length === 0) break;
        const self = await ctx.world.selfPos();
        drops.sort((a, b) => (self ? distance(self, a.pos) - distance(self, b.pos) : 0));
        const target = drops[0]!.pos;
        const d = self ? distance(self, target) : Number.POSITIVE_INFINITY;

        let ok = d <= NEAR ? await stepToward(target) : false;
        if (!ok) {
          const r = await ctx.ctrl.goto(target, { range: 1 });
          ok = r.accepted;
          if (!ok && d <= NEAR) ok = await stepToward(target); // last-ditch direct approach
          if (!ok) {
            unreachable.push(r.note ?? 'unreachable');
            dead.add(key(target));
          }
        }
      }

      const inv1 = await ctx.world.inventory();
      if (isUnknown(inv1)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', reasonDetail: 'inventory not observed' });
      const after = inv1.value;
      const delta = deltaOf(before, after);
      const gained = totalOf(after) - totalOf(before);
      const evidence = [{ claim: 'inv_count', source: 'authoritative' as const, before: totalOf(before), after: totalOf(after) }];
      const tail = unreachable.length ? `; ${unreachable.length} drop(s) unreachable (first: ${unreachable[0]})` : '';
      if (gained > 0) {
        return pass({ resources: { inventoryDelta: delta }, evidence, attribution: 'self_temporal', ...(tail ? { reasonDetail: `picked some up${tail}` } : {}) });
      }
      return mk({
        effectStatus: 'fail',
        reason: 'effect_not_observed',
        reasonDetail: unreachable.length ? `no items picked up; ${unreachable.length} drop(s) unreachable (first: ${unreachable[0]})` : 'no items picked up (no drops in range)',
        evidence,
      });
    });
  },
};

export const itemActions: AtomicAction[] = [collect];
