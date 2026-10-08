// Block atomic actions. Core primitive = set_block (replace semantics); no coordinate
// parameters — the model passes a semantic Target.

import type { ActionResult, Target, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { distance } from '@mc-agent/world';
import { mk, pass, fail } from '../result.js';
import type { ActionContext, AtomicAction } from './types.js';
import { contract } from './types.js';
import { resolveTarget } from './target.js';

const AIR = 'minecraft:air';

/** Find an adjacent solid face to place against (real reference, not a hardcoded direction). */
async function findPlaceFace(ctx: ActionContext, pos: Vec3): Promise<Vec3 | null> {
  const box = {
    min: [pos[0] - 1, pos[1] - 1, pos[2] - 1] as Vec3,
    max: [pos[0] + 1, pos[1] + 1, pos[2] + 1] as Vec3,
  };
  const r = await ctx.world.query(box);
  if (isUnknown(r)) return null;
  for (const c of r.value) {
    if (c.block === AIR) continue;
    const dx = pos[0] - c.pos[0];
    const dy = pos[1] - c.pos[1];
    const dz = pos[2] - c.pos[2];
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1) return [dx, dy, dz];
  }
  return null;
}

const setBlock: AtomicAction = {
  contract: contract({
    name: 'set_block',
    description:
      'Replace the block at a target with B (B may be air). If already B it is skipped; if the target is air it is placed; otherwise the old block is broken and B placed; B=air means break. Navigation to the target is implicit unless disabled.',
    params: {
      type: 'object',
      properties: {
        target: { type: 'object', description: 'Target (block/cell/…)' },
        block: { type: 'string', description: 'Target block id, e.g. minecraft:oak_planks or minecraft:air' },
        navigate: { type: 'boolean', default: true },
        allowModify: { type: 'boolean', default: false, description: 'Allow pathfinder to modify terrain (scaffolding)' },
        face: { type: 'array', items: { type: 'integer' }, description: 'Explicit place face (optional)' },
      },
      required: ['target', 'block'],
      additionalProperties: false,
    },
    verificationMode: 'state_effect',
    effectClass: 'consumable',
    retryPolicy: 'no',
    repairHint: ['retarget', 'reposition'],
    timeoutTicks: 1100,
    postconditions: [{ subject: 'block@target', predicate: 'is', value: 'B' }],
  }),
  async run(ctx, args): Promise<ActionResult> {
    const target = args.target as Target;
    const block = String(args.block);
    const navigate = args.navigate !== false;
    const allowModify = args.allowModify === true;
    const explicitFace = Array.isArray(args.face) ? (args.face as Vec3) : null;

    return ctx.token.run(async () => {
      const rt = await resolveTarget(ctx, target);
      if (!rt.ok || !rt.value.pos) {
        return fail('precondition_failed', { reasonDetail: rt.ok ? 'target has no position' : rt.reason });
      }
      const pos = rt.value.pos;
      const before = await ctx.world.blockAt(pos);
      if (isUnknown(before)) {
        return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', controlStatus: 'needs_replan' });
      }
      if (before.value === block) {
        return pass({ evidence: [{ claim: 'already_at_target', source: 'authoritative' }], attribution: 'self_temporal' });
      }

      if (navigate) {
        const self = await ctx.world.selfPos();
        if (self && distance(self, pos) > 4) {
          const g = await ctx.ctrl.goto(pos, { range: 2, allowModify });
          if (!g.accepted) {
            return mk({ effectStatus: 'unobservable', controlStatus: 'blocked', reason: 'precondition_failed', reasonDetail: g.note });
          }
        }
      }

      if (block === AIR) {
        const d = await ctx.ctrl.dig(pos);
        if (!d.accepted) return fail('effect_not_observed', { reasonDetail: d.note, controlStatus: 'needs_replan' });
      } else {
        if (before.value !== AIR) {
          const d = await ctx.ctrl.dig(pos);
          if (!d.accepted) return fail('effect_not_observed', { reasonDetail: d.note, controlStatus: 'needs_replan' });
        }
        const face = explicitFace ?? (await findPlaceFace(ctx, pos));
        if (!face) return fail('precondition_failed', { reasonDetail: 'no reference face to place against' });
        const p = await ctx.ctrl.place(pos, face, block);
        if (!p.accepted) return fail('effect_not_observed', { reasonDetail: p.note, controlStatus: 'needs_replan' });
      }

      const after = await ctx.world.blockAt(pos);
      if (isUnknown(after)) {
        return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', controlStatus: 'needs_replan' });
      }
      if (after.value === block) {
        return pass({
          effects: [{ subject: `block@${pos.join(',')}`, predicate: 'is', before: before.value, after: after.value }],
          evidence: [{ claim: 'block_at_target', source: 'authoritative', value: after.value }],
          attribution: 'self_temporal',
        });
      }
      return fail('effect_not_observed', {
        effects: [{ subject: `block@${pos.join(',')}`, predicate: 'is', before: before.value, after: after.value, ok: false }],
        evidence: [{ claim: 'block_at_target', source: 'authoritative', value: after.value }],
      });
    });
  },
};

const useBlock: AtomicAction = {
  contract: contract({
    name: 'use_block',
    description: 'Right-click a block at a target (open a container, toggle a door/lever, etc.).',
    params: { type: 'object', properties: { target: { type: 'object' } }, required: ['target'], additionalProperties: false },
    verificationMode: 'observation',
    effectClass: 'idempotent',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const target = args.target as Target;
    return ctx.token.run(async () => {
      const rt = await resolveTarget(ctx, target);
      if (!rt.ok || !rt.value.pos) return fail('precondition_failed', { reasonDetail: rt.ok ? 'no position' : rt.reason });
      const r = await ctx.ctrl.use(rt.value.pos);
      return r.accepted
        ? mk({ effectStatus: 'pass', evidence: [{ claim: 'activated', source: 'observed' }], attribution: 'self_temporal' })
        : fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

export const blockActions: AtomicAction[] = [setBlock, useBlock];
