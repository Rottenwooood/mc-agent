// Inventory atomic actions. Count-changing actions are verified on the authoritative inventory.

import type { ActionResult } from '@mc-agent/contracts';
import { pass, fail } from '../result.js';
import type { AtomicAction } from './types.js';
import { contract } from './types.js';
import { invCount } from './helpers.js';
import { resolveTarget } from './target.js';

const equip: AtomicAction = {
  contract: contract({
    name: 'equip',
    description: 'Equip an inventory item to a destination slot (hand/head/torso/legs/feet/off-hand).',
    params: { type: 'object', properties: { item: { type: 'string' }, destination: { type: 'string', default: 'hand' } }, required: ['item'], additionalProperties: false },
    effectClass: 'idempotent',
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const before = await invCount(ctx.world, String(args.item));
      const r = await ctx.ctrl.equip(String(args.item), String(args.destination ?? 'hand'));
      const after = await invCount(ctx.world, String(args.item));
      if (r.accepted && after === before) return pass({ evidence: [{ claim: 'inv_count', source: 'authoritative', before, after }], attribution: 'self_temporal' });
      return fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

const unequip: AtomicAction = {
  contract: contract({
    name: 'unequip',
    description: 'Remove the item from a destination slot back to the inventory.',
    params: { type: 'object', properties: { destination: { type: 'string', default: 'hand' } }, additionalProperties: false },
    effectClass: 'idempotent',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const r = await ctx.ctrl.unequip(String(args.destination ?? 'hand'));
    return r.accepted ? pass({ attribution: 'self_temporal' }) : fail('effect_not_observed', { reasonDetail: r.note });
  },
};

const drop: AtomicAction = {
  contract: contract({
    name: 'drop',
    description: 'Drop `count` of an item. Verified by the authoritative inventory count decreasing.',
    params: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'integer', default: 1 } }, required: ['item'], additionalProperties: false },
    verificationMode: 'state_effect',
    effectClass: 'irreversible',
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const item = String(args.item);
      const want = Number(args.count ?? 1);
      const before = await invCount(ctx.world, item);
      const r = await ctx.ctrl.drop(item, want);
      const after = await invCount(ctx.world, item);
      const delta = before - after;
      if (r.accepted && delta >= want) return pass({ resources: { inventoryDelta: { [item]: -delta } }, evidence: [{ claim: 'inv_count', source: 'authoritative', before, after }], attribution: 'self_temporal' });
      if (delta > 0) return { ...pass({ resources: { inventoryDelta: { [item]: -delta } } }), effectStatus: 'ambiguous', reason: 'effect_not_observed' };
      return fail('effect_not_observed', { reasonDetail: r.note, evidence: [{ claim: 'inv_count', source: 'authoritative', before, after }] });
    });
  },
};

const transferItem: AtomicAction = {
  contract: contract({
    name: 'transfer_item',
    description: 'Move `count` items between the inventory and a container target.',
    params: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'integer', default: 1 }, from: { type: 'string', enum: ['inventory', 'container'], default: 'inventory' }, to: { type: 'string', enum: ['inventory', 'container'], default: 'container' }, target: { type: 'object' } }, required: ['item', 'target'], additionalProperties: false },
    verificationMode: 'state_effect',
    effectClass: 'idempotent',
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const item = String(args.item);
      const rt = await resolveTarget(ctx, args.target as never);
      const pos = rt.ok ? rt.value.containerPos : undefined;
      if (!pos) return fail('precondition_failed', { reasonDetail: rt.ok ? 'no container position' : rt.reason });
      const before = await invCount(ctx.world, item);
      const r = await ctx.ctrl.transfer(item, Number(args.count ?? 1), {
        from: (String(args.from ?? 'inventory') as 'inventory' | 'container'),
        to: (String(args.to ?? 'container') as 'inventory' | 'container'),
        pos,
      });
      const after = await invCount(ctx.world, item);
      if (r.accepted && after !== before) return pass({ diff: { changed: true, inventoryDelta: { [item]: after - before } }, evidence: [{ claim: 'inv_count', source: 'authoritative', before, after }], attribution: 'self_temporal' });
      return fail('effect_not_observed', { reasonDetail: r.note, evidence: [{ claim: 'inv_count', source: 'authoritative', before, after }] });
    });
  },
};

const consume: AtomicAction = {
  contract: contract({
    name: 'consume',
    description: 'Eat / drink an item. Verified by the item count falling or the authoritative food level rising.',
    params: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'], additionalProperties: false },
    verificationMode: 'state_effect',
    effectClass: 'consumable',
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const item = String(args.item);
      const before = await invCount(ctx.world, item);
      const s0 = await ctx.world.status();
      const r = await ctx.ctrl.consume(item);
      const after = await invCount(ctx.world, item);
      const s1 = await ctx.world.status();
      const foodUp = !('unknown' in s0) && !('unknown' in s1) && s1.value.food > s0.value.food;
      if (r.accepted && (after < before || foodUp)) return pass({ resources: { inventoryDelta: { [item]: after - before } }, evidence: [{ claim: 'inv_count', source: 'authoritative', before, after }], attribution: 'self_temporal' });
      return fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

const useItem: AtomicAction = {
  contract: contract({
    name: 'use_item',
    description: 'Equip and use an item (bow, potion, bucket, pearl…), holding for release_ms.',
    params: { type: 'object', properties: { item: { type: 'string' }, release_ms: { type: 'integer', default: 1000 } }, required: ['item'], additionalProperties: false },
    verificationMode: 'continuous',
    effectClass: 'consumable',
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const item = String(args.item);
      const before = await invCount(ctx.world, item);
      const r = await ctx.ctrl.useItem(item, Number(args.release_ms ?? 1000));
      const after = await invCount(ctx.world, item);
      if (!r.accepted) return fail('effect_not_observed', { reasonDetail: r.note });
      return after < before
        ? pass({ resources: { inventoryDelta: { [item]: after - before } }, attribution: 'self_temporal' })
        : { ...pass({ attribution: 'self_temporal' }), effectStatus: 'ambiguous', reason: 'effect_not_observed' };
    });
  },
};

export const inventoryActions: AtomicAction[] = [equip, unequip, drop, transferItem, consume, useItem];
