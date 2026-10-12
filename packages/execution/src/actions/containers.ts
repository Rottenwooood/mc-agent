// Container / production atomic actions.

import type { ActionResult } from '@mc-agent/contracts';
import { mk, pass, fail } from '../result.js';
import type { AtomicAction } from './types.js';
import { contract } from './types.js';
import { invCountOrNull, invSnapshot, snapshotDelta } from './helpers.js';
import { resolveTarget, resolveTargetOrFail, TARGET_SCHEMA } from './target.js';

const openContainer: AtomicAction = {
  contract: contract({
    name: 'open_container',
    description: 'Open the container/block at a target and leave its window open (control action).',
    params: { type: 'object', properties: { target: TARGET_SCHEMA }, required: ['target'], additionalProperties: false },
    effectClass: 'idempotent',
    controlOnly: true,
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
    description: 'Close the currently open container/window (control action).',
    params: { type: 'object', properties: {}, additionalProperties: false },
    effectClass: 'idempotent',
    controlOnly: true,
  }),
  async run(ctx): Promise<ActionResult> {
    const r = await ctx.ctrl.closeContainer();
    return r.accepted ? pass({ attribution: 'self_temporal' }) : fail('effect_not_observed', { reasonDetail: r.note });
  },
};

const craft: AtomicAction = {
  contract: contract({
    name: 'craft',
    description:
      'Craft `count` of an item (auto-uses a nearby/block crafting table). `count` is the desired RESULT amount; verified on the authoritative inventory (a partial craft is reported, never a pass).',
    params: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'integer', default: 1 }, table: { type: 'object' } }, required: ['item'], additionalProperties: false },
    verificationMode: 'state_effect',
    effectClass: 'consumable',
    // Multi-iteration crafting must never be abandoned mid-flight: the body budget must exceed the
    // backend's per-iteration bound (an abandoned craft corrupts the crafting window).
    timeoutTicks: 1200,
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const item = String(args.item);
      const want = Math.max(1, Number(args.count ?? 1));
      const before = await invCountOrNull(ctx.world, item);
      if (before === null) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', reasonDetail: 'inventory not observed' });
      const tableRt = args.table ? await resolveTarget(ctx, args.table as never) : null;
      const tablePos = tableRt && tableRt.ok ? tableRt.value.pos : undefined;
      const r = await ctx.ctrl.craft(item, want, tablePos);
      const after = await invCountOrNull(ctx.world, item);
      if (after === null) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', reasonDetail: 'inventory not observed' });
      const got = after - before;
      const evidence = [{ claim: 'inv_count', source: 'authoritative' as const, before, after }];
      const res = { resources: { inventoryDelta: { [item]: got } }, evidence, attribution: 'self_temporal' as const };
      if (r.accepted && got >= want) return pass(res);
      if (got > 0) {
        // Inputs were consumed but the full amount did not land: NOT a pass.
        return { ...pass(res), effectStatus: 'ambiguous', reason: 'effect_not_observed', reasonDetail: `crafted ${got}/${want}${r.note ? ` (${r.note})` : ''}` };
      }
      return fail('effect_not_observed', { reasonDetail: r.note ?? 'no output landed', evidence });
    });
  },
};

const smelt: AtomicAction = {
  contract: contract({
    name: 'smelt',
    description:
      'Smelt `count` of `item` in a furnace (nearest or given), optionally with `fuel`. `item` is the INPUT (e.g. minecraft:raw_iron, minecraft:sand); the OUTPUT is verified on the authoritative inventory (a positive inventory delta). Needs a furnace and fuel.',
    params: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'the INPUT to smelt, e.g. minecraft:raw_iron (NOT the output)' },
        count: { type: 'integer', default: 1 },
        fuel: { type: 'string', description: 'e.g. minecraft:coal (omit to use fuel already in the furnace)' },
        furnace: { type: 'object', description: 'target for the furnace (default: the nearest furnace)' },
      },
      required: ['item'],
      additionalProperties: false,
    },
    verificationMode: 'state_effect',
    effectClass: 'consumable',
    // Never abandon a live furnace window: the backend polls the output for up to ~60s.
    timeoutTicks: 1400,
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const s0 = await invSnapshot(ctx.world);
      if (!s0) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', reasonDetail: 'inventory not observed' });
      const fRt = args.furnace ? await resolveTarget(ctx, args.furnace as never) : null;
      const pos = fRt && fRt.ok ? fRt.value.pos : undefined;
      const r = await ctx.ctrl.smelt(String(args.item), Number(args.count ?? 1), {
        ...(args.fuel != null ? { fuel: String(args.fuel) } : {}),
        ...(pos ? { pos } : {}),
      });
      const s1 = await invSnapshot(ctx.world);
      if (!s1) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', reasonDetail: 'inventory not observed' });
      const delta = snapshotDelta(s0, s1);
      // `item` is the INPUT; the OUTPUT is whatever increased in the inventory.
      const produced = Object.entries(delta).filter(([, d]) => d > 0);
      const made = produced.reduce((s, [, d]) => s + d, 0);
      const want = Math.max(1, Number(args.count ?? 1));
      const evidence = [{ claim: 'inv_delta', source: 'authoritative' as const, value: Object.fromEntries(produced) }];
      const res = {
        resources: { inventoryDelta: delta },
        evidence,
        data: { produced: Object.fromEntries(produced), consumed: Object.fromEntries(Object.entries(delta).filter(([, d]) => d < 0)) },
        attribution: 'self_temporal' as const,
      };
      if (r.accepted && made >= want) return pass(res);
      if (made > 0) {
        // Part of the batch came out (the rest is still in the furnace): NOT a pass.
        return { ...pass(res), effectStatus: 'ambiguous', reason: 'effect_not_observed', reasonDetail: `smelted ${made}/${want}${r.note ? ` (${r.note})` : ''}` };
      }
      return fail('effect_not_observed', { reasonDetail: r.note ?? 'no output appeared in the inventory', resources: { inventoryDelta: delta } });
    });
  },
};

const enchant: AtomicAction = {
  contract: contract({
    name: 'enchant',
    description:
      'Enchant an item at an enchantment table (nearest or given). Control action: an enchantment is NBT the world port cannot observe, so NO effect is claimed; the client-observed result is returned in `data`.',
    params: { type: 'object', properties: { item: { type: 'string' }, choice: { type: 'integer', default: 0 }, table: { type: 'object' } }, required: ['item'], additionalProperties: false },
    effectClass: 'consumable',
    controlOnly: true,
    timeoutTicks: 400,
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const eRt = args.table ? await resolveTarget(ctx, args.table as never) : null;
      const pos = eRt && eRt.ok ? eRt.value.pos : undefined;
      const r = await ctx.ctrl.enchant(String(args.item), Number(args.choice ?? 0), pos);
      const observed = (r.raw as Record<string, unknown> | undefined) ?? null;
      return r.accepted
        ? pass({ evidence: [{ claim: 'enchant_client_observed', source: 'observed', value: observed }], ...(observed ? { data: observed } : {}) })
        : fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

const anvilCombine: AtomicAction = {
  contract: contract({
    name: 'anvil_combine',
    description:
      'Combine two items on the nearest anvil, optionally renaming. Control action: the repaired/renamed result is NBT the world port cannot observe, so NO effect is claimed; the client-observed result is returned in `data`.',
    params: { type: 'object', properties: { item1: { type: 'string' }, item2: { type: 'string' }, name: { type: 'string' } }, required: ['item1', 'item2'], additionalProperties: false },
    effectClass: 'consumable',
    controlOnly: true,
    timeoutTicks: 400,
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const r = await ctx.ctrl.anvilCombine(String(args.item1), String(args.item2), args.name != null ? String(args.name) : undefined);
      const observed = (r.raw as Record<string, unknown> | undefined) ?? null;
      return r.accepted
        ? pass({ evidence: [{ claim: 'anvil_client_observed', source: 'observed', value: observed }], ...(observed ? { data: observed } : {}) })
        : fail('effect_not_observed', { reasonDetail: r.note });
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
    timeoutTicks: 900,
  }),
  async run(ctx, args): Promise<ActionResult> {
    return ctx.token.run(async () => {
      const rt = await resolveTargetOrFail(ctx, args.target as never);
      if (!rt.ok) return rt.result;
      if (!rt.value.entityId) return fail('precondition_failed', { reasonDetail: 'target has no entity' });
      const s0 = await invSnapshot(ctx.world);
      if (!s0) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', reasonDetail: 'inventory not observed' });
      const r = await ctx.ctrl.trade(rt.value.entityId, Number(args.index ?? 0), Number(args.times ?? 1));
      const s1 = await invSnapshot(ctx.world);
      if (!s1) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', reasonDetail: 'inventory not observed' });
      const delta = snapshotDelta(s0, s1);
      if (r.accepted && Object.keys(delta).length > 0) {
        return pass({ resources: { inventoryDelta: delta }, evidence: [{ claim: 'inv_delta', source: 'authoritative', value: delta }], attribution: 'self_temporal' });
      }
      return fail('effect_not_observed', { reasonDetail: r.note ?? 'no inventory change', resources: { inventoryDelta: delta } });
    });
  },
};

export const containerActions: AtomicAction[] = [openContainer, closeContainer, craft, smelt, enchant, anvilCombine, trade];
