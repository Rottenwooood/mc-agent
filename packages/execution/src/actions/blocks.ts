// Block atomic actions. Core primitive = set_block (replace semantics); no coordinate
// parameters — the model passes a semantic Target.

import type { ActionResult, ControlReceipt, Target, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { distance, key } from '@mc-agent/world';
import { mk, pass, fail } from '../result.js';
import type { ActionContext, AtomicAction } from './types.js';
import { contract } from './types.js';
import { resolveTarget } from './target.js';

const AIR = 'minecraft:air';
/** Interaction reach — keep consistent with scan_blocks' `touchable` (perception REACH). */
const REACH = 4.5;

/** Turn a control receipt's progress (blocks broken while tunnelling) into effects/evidence. */
function progressBits(r: ControlReceipt): {
  broken: string[];
  effects: { subject: string; predicate: string; value: unknown }[];
  evidence: { claim: string; source: string; value?: unknown }[];
} {
  const broken = ((r.raw as { blocksBroken?: string[] } | undefined)?.blocksBroken) ?? [];
  return {
    broken,
    effects: broken.map((b) => ({ subject: `block@${b}`, predicate: 'is', value: AIR })),
    evidence: broken.map((b) => ({ claim: 'block_removed', source: 'authoritative', value: b })),
  };
}

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
        breakThrough: { type: 'boolean', default: true, description: 'When digging, break intervening blocks to reach the target (tunnelling). Set false to only dig a directly reachable block.' },
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
    const breakThrough = args.breakThrough !== false;
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
        // Only walk when the target is OUT of interaction reach. Navigating at `> 4` walked for
        // targets scan_blocks already calls `touchable` (<= REACH), and the pathfinder could wedge
        // on a GoalNear that is unsatisfiable when the block is embedded in terrain. If the walk
        // fails but the bot ended up within reach anyway, fall through and dig.
        if (self && distance(self, pos) > REACH) {
          const g = await ctx.ctrl.goto(pos, { range: 3, allowModify, timeoutMs: 8000 });
          const self2 = await ctx.world.selfPos();
          const inReach = !!self2 && distance(self2, pos) <= REACH;
          if (!g.accepted && !inReach) {
            return mk({
              effectStatus: 'unobservable',
              controlStatus: 'blocked',
              reason: 'precondition_failed',
              reasonDetail: `navigation failed: ${g.note}`,
            });
          }
        }
      }

      const broken: string[] = [];
      const digOnce = async (p: Vec3) => {
        const d = await ctx.ctrl.dig(p, { breakThrough });
        for (const b of progressBits(d).broken) {
          if (!broken.includes(b)) broken.push(b);
        }
        return d;
      };
      const progress = () => ({
        ...(broken.length > 0
          ? {
              effects: broken.map((b) => ({ subject: `block@${b}`, predicate: 'is', value: AIR })),
              evidence: broken.map((b) => ({ claim: 'block_removed', source: 'authoritative' as const, value: b })),
              data: { blocksBroken: broken },
            }
          : {}),
      });

      if (block === AIR) {
        const d = await digOnce(pos);
        if (!d.accepted) {
          return mk({ effectStatus: 'fail', reason: 'effect_not_observed', reasonDetail: d.note, controlStatus: 'needs_replan', ...progress() });
        }
      } else {
        if (before.value !== AIR) {
          const d = await digOnce(pos);
          if (!d.accepted) {
            return mk({ effectStatus: 'fail', reason: 'effect_not_observed', reasonDetail: d.note, controlStatus: 'needs_replan', ...progress() });
          }
        }
        const face = explicitFace ?? (await findPlaceFace(ctx, pos));
        if (!face) return fail('precondition_failed', { reasonDetail: 'no reference face to place against', ...progress() });
        const p = await ctx.ctrl.place(pos, face, block);
        if (!p.accepted) return fail('effect_not_observed', { reasonDetail: p.note, controlStatus: 'needs_replan', ...progress() });
      }

      const after = await ctx.world.blockAt(pos);
      if (isUnknown(after)) {
        return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', controlStatus: 'needs_replan', ...progress() });
      }
      if (after.value === block) {
        return pass({
          effects: [{ subject: `block@${pos.join(',')}`, predicate: 'is', before: before.value, after: after.value }],
          evidence: [{ claim: 'block_at_target', source: 'authoritative', value: after.value }],
          attribution: 'self_temporal',
          ...progress(),
        });
      }
      return fail('effect_not_observed', {
        effects: [{ subject: `block@${pos.join(',')}`, predicate: 'is', before: before.value, after: after.value, ok: false }],
        evidence: [{ claim: 'block_at_target', source: 'authoritative', value: after.value }],
        ...progress(),
      });
    });
  },
  async scope(ctx, args) {
    const rt = await resolveTarget(ctx, args.target as Target);
    if (!rt.ok || !rt.value.pos) return null;
    const pos = rt.value.pos;
    return {
      box: { min: [pos[0] - 1, pos[1] - 1, pos[2] - 1] as Vec3, max: [pos[0] + 1, pos[1] + 1, pos[2] + 1] as Vec3 },
      anchor: pos,
    };
  },
  async verify(ctx, args, win) {
    const pos = win.anchor;
    if (!pos) return null;
    const want = String(args.block);
    const before = win.before.blocks.get(key(pos)) ?? AIR;
    const after = win.after.blocks.get(key(pos)) ?? AIR;
    return {
      ok: after === want ? 'pass' : 'fail',
      evidence: [{ claim: 'block_at_target', source: 'authoritative', before, after, value: after }],
    };
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
