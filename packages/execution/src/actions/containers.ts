// Container / production atomic actions.

import type { ActionResult } from '@mc-agent/contracts';
import { pass, fail } from '../result.js';
import type { AtomicAction } from './types.js';
import { contract } from './types.js';
import { invCount } from './helpers.js';
import { resolveTarget, resolveTargetOrFail, TARGET_SCHEMA } from './target.js';

const openContainer: AtomicAction = {
  contract: contract({
    name: 'open_container',
    description: 'Open the container/block at a target and leave its window open.',
    params: { type: 'object', properties: { target: TARGET_SCHEMA }, required: ['target'], additionalProperties: false },
    effectClass: 'idempotent',
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const rt = await resolveTargetOrFail(ctx, args.target as never);
      if (!rt.ok) return rt.result;
      const pos = rt.value.containerPos ?? rt.value.pos;
      if (!pos) return fail('precondition_failed', { reasonDetail: 'no position' });
      const r = await ctx.ctrl.openContainer(pos);
      return r.accepted ? pass({ attribution: 'self_temporal' }) : fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

const closeContainer: AtomicAction = {
  contract: contract({
    name: 'close_container',
    description: 'Close the currently open container/window.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    effectClass: 'idempotent',
  }),
  async run(ctx): Promise<ActionResult> {
    const r = await ctx.ctrl.closeContainer();
    return r.accepted ? pass({ attribution: 'self_temporal' }) : fail('effect_not_observed', { reasonDetail: r.note });
  },
};

const craft: AtomicAction = {
  contract: contract({
    name: 'craft',
    description: 'Craft `count` of an item (auto-uses a nearby/block crafting table). Verified on the authoritative inventory.',
    params: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'integer', default: 1 }, table: { type: 'object' } }, required: ['item'], additionalProperties: false },
    verificationMode: 'state_effect',
    effectClass: 'consumable',
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const item = String(args.item);
      const before = await invCount(ctx.world, item);
      const tableRt = args.table ? await resolveTarget(ctx, args.table as never) : null;
      const tablePos = tableRt && tableRt.ok ? tableRt.value.pos : undefined;
      const r = await ctx.ctrl.craft(item, Number(args.count ?? 1), tablePos);
      const after = await invCount(ctx.world, item);
      if (r.accepted && after > before) return pass({ resources: { inventoryDelta: { [item]: after - before } }, evidence: [{ claim: 'inv_count', source: 'authoritative', before, after }], attribution: 'self_temporal' });
      return fail('effect_not_observed', { reasonDetail: r.note, evidence: [{ claim: 'inv_count', source: 'authoritative', before, after }] });
    });
  },
};

const smelt: AtomicAction = {
  contract: contract({
    name: 'smelt',
    description: 'Smelt `count` of an item in a furnace (nearest or given), optionally with fuel. Verified on the authoritative inventory.',
    params: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'integer', default: 1 }, fuel: { type: 'string' }, furnace: { type: 'object' } }, required: ['item'], additionalProperties: false },
    verificationMode: 'state_effect',
    effectClass: 'consumable',
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const item = String(args.item);
      const before = await invCount(ctx.world, item);
      const fRt = args.furnace ? await resolveTarget(ctx, args.furnace as never) : null;
      const pos = fRt && fRt.ok ? fRt.value.pos : undefined;
      const r = await ctx.ctrl.smelt(item, Number(args.count ?? 1), { ...(args.fuel != null ? { fuel: String(args.fuel) } : {}), ...(pos ? { pos } : {}) });
      const after = await invCount(ctx.world, item);
      if (r.accepted && after > before) return pass({ resources: { inventoryDelta: { [item]: after - before } }, evidence: [{ claim: 'inv_count', source: 'authoritative', before, after }], attribution: 'self_temporal' });
      return fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

const enchant: AtomicAction = {
  contract: contract({
    name: 'enchant',
    description: 'Enchant an item at an enchantment table (nearest or given).',
    params: { type: 'object', properties: { item: { type: 'string' }, choice: { type: 'integer', default: 0 }, table: { type: 'object' } }, required: ['item'], additionalProperties: false },
    effectClass: 'consumable',
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const eRt = args.table ? await resolveTarget(ctx, args.table as never) : null;
      const pos = eRt && eRt.ok ? eRt.value.pos : undefined;
      const r = await ctx.ctrl.enchant(String(args.item), Number(args.choice ?? 0), pos);
      return r.accepted ? { ...pass({ attribution: 'self_temporal' }), effectStatus: 'ambiguous', reason: 'attribution_uncertain' } : fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

const anvilCombine: AtomicAction = {
  contract: contract({
    name: 'anvil_combine',
    description: 'Combine two items on the nearest anvil, optionally renaming.',
    params: { type: 'object', properties: { item1: { type: 'string' }, item2: { type: 'string' }, name: { type: 'string' } }, required: ['item1', 'item2'], additionalProperties: false },
    effectClass: 'consumable',
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const r = await ctx.ctrl.anvilCombine(String(args.item1), String(args.item2), args.name != null ? String(args.name) : undefined);
      return r.accepted ? { ...pass({ attribution: 'self_temporal' }), effectStatus: 'ambiguous', reason: 'attribution_uncertain' } : fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

const trade: AtomicAction = {
  contract: contract({
    name: 'trade',
    description: 'Perform a villager trade by index. Verified on the authoritative inventory delta.',
    params: { type: 'object', properties: { target: TARGET_SCHEMA, index: { type: 'integer', default: 0 }, times: { type: 'integer', default: 1 } }, required: ['target'], additionalProperties: false },
    verificationMode: 'state_effect',
    effectClass: 'consumable',
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const rt = await resolveTargetOrFail(ctx, args.target as never);
      if (!rt.ok) return rt.result;
      if (!rt.value.entityId) return fail('precondition_failed', { reasonDetail: 'target has no entity' });
      const inv0 = await ctx.world.inventory();
      const r = await ctx.ctrl.trade(rt.value.entityId, Number(args.index ?? 0), Number(args.times ?? 1));
      const inv1 = await ctx.world.inventory();
      const changed = !('unknown' in inv0) && !('unknown' in inv1) && JSON.stringify(inv0.value) !== JSON.stringify(inv1.value);
      if (r.accepted && changed) return pass({ evidence: [{ claim: 'inv_delta', source: 'authoritative' }], attribution: 'self_temporal' });
      return fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

export const containerActions: AtomicAction[] = [openContainer, closeContainer, craft, smelt, enchant, anvilCombine, trade];
