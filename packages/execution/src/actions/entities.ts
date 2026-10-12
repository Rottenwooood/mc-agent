// Entity / combat atomic actions.

import type { ActionResult, Target } from '@mc-agent/contracts';
import { mk, fail } from '../result.js';
import type { AtomicAction } from './types.js';
import { contract } from './types.js';
import { resolveTargetOrFail, TARGET_SCHEMA } from './target.js';

const attack: AtomicAction = {
  contract: contract({
    name: 'attack',
    description: 'Melee-attack a target entity for a bounded duration, optionally equipping a weapon.',
    params: { type: 'object', properties: { target: TARGET_SCHEMA, weapon: { type: 'string' }, durationMs: { type: 'integer', default: 5000 } }, required: ['target'], additionalProperties: false },
    verificationMode: 'task_terminal',
    effectClass: 'consumable',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const target = args.target as Target;
    return ctx.token.run(async () => {
      const rt = await resolveTargetOrFail(ctx, target);
      if (!rt.ok) return rt.result;
      if (!rt.value.entityId) return fail('precondition_failed', { reasonDetail: 'target has no entity' });
      const opts = { durationMs: Number(args.durationMs ?? 5000), ...(args.weapon != null ? { weapon: String(args.weapon) } : {}) };
      const r = await ctx.ctrl.attack(rt.value.entityId, opts);
      return r.accepted
        ? mk({ effectStatus: 'pass', evidence: [{ claim: 'attacked', source: 'observed' }], attribution: 'self_temporal' })
        : fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

const interactEntity: AtomicAction = {
  contract: contract({
    name: 'interact_entity',
    description: 'Right-click a target entity (feed, shear, milk, mount, trade UI).',
    params: { type: 'object', properties: { target: TARGET_SCHEMA, item: { type: 'string' } }, required: ['target'], additionalProperties: false },
    effectClass: 'consumable',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const target = args.target as Target;
    return ctx.token.run(async () => {
      const rt = await resolveTargetOrFail(ctx, target);
      if (!rt.ok) return rt.result;
      if (!rt.value.entityId) return fail('precondition_failed', { reasonDetail: 'target has no entity' });
      const r = await ctx.ctrl.interactEntity(rt.value.entityId, args.item != null ? String(args.item) : undefined);
      return r.accepted
        ? mk({ effectStatus: 'ambiguous', reason: 'attribution_uncertain', evidence: [{ claim: 'interacted', source: 'observed' }], attribution: 'self_temporal' })
        : fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

const useItemOn: AtomicAction = {
  contract: contract({
    name: 'use_item_on',
    description: 'Equip an item and use it on a target entity or block (bone meal, bucket, flint & steel).',
    params: { type: 'object', properties: { item: { type: 'string' }, target: TARGET_SCHEMA }, required: ['item', 'target'], additionalProperties: false },
    effectClass: 'consumable',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const target = args.target as Target;
    return ctx.token.run(async () => {
      const rt = await resolveTargetOrFail(ctx, target);
      if (!rt.ok) return rt.result;
      if (!rt.value.entityId && !rt.value.pos) return fail('precondition_failed', { reasonDetail: 'target has no entity or position' });
      const t: { pos?: [number, number, number]; entityId?: string } = {};
      if (rt.value.entityId) t.entityId = rt.value.entityId;
      else if (rt.value.pos) t.pos = rt.value.pos;
      else return fail('precondition_failed', { reasonDetail: 'no target position/entity' });
      const r = await ctx.ctrl.useItemOn(String(args.item), t);
      return r.accepted
        ? mk({ effectStatus: 'ambiguous', reason: 'attribution_uncertain', evidence: [{ claim: 'used_item', source: 'observed' }], attribution: 'self_temporal' })
        : fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

export const entityActions: AtomicAction[] = [attack, interactEntity, useItemOn];
