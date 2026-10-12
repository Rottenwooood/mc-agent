// Movement atomic actions. Targets are semantic; coordinates are resolved internally.

import type { ActionResult, Target, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { distance } from '@mc-agent/world';
import { mk, pass, fail } from '../result.js';
import type { ActionContext, AtomicAction } from './types.js';
import { contract } from './types.js';
import { resolveTargetOrFail, TARGET_SCHEMA } from './target.js';

/** Nearest STANDABLE cell (feet position with support) within a small box around `pos`. */
async function nearestStandable(ctx: ActionContext, pos: Vec3, radius = 4): Promise<Vec3 | null> {
  const box = {
    min: [pos[0] - radius, pos[1] - 2, pos[2] - radius] as Vec3,
    max: [pos[0] + radius, pos[1] + 2, pos[2] + radius] as Vec3,
  };
  const ss = await ctx.world.standableSurfaces(box);
  if (isUnknown(ss) || ss.value.length === 0) return null;
  let best = ss.value[0]!;
  let bd = Number.POSITIVE_INFINITY;
  for (const c of ss.value) {
    const d = (c[0] - pos[0]) ** 2 + (c[1] - pos[1]) ** 2 + (c[2] - pos[2]) ** 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

const goTo: AtomicAction = {
  contract: contract({
    name: 'go_to',
    description: 'Pathfind to within `range` blocks of a target. Verified against the authoritative self position.',
    params: {
      type: 'object',
      properties: {
        target: TARGET_SCHEMA,
        range: { type: 'number', default: 1 },
        allowModify: { type: 'boolean', default: false },
        timeoutMs: { type: 'integer', default: 15000, description: 'Movement budget; raise it for long terrain-modifying (allowModify) trips.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    verificationMode: 'task_terminal',
    effectClass: 'idempotent',
    retryPolicy: 'safe_once',
    timeoutTicks: 1800,
  }),
  async run(ctx, args): Promise<ActionResult> {
    const target = args.target as Target;
    const range = Number(args.range ?? 1);
    const allowModify = args.allowModify === true;
    const timeoutMs = Number(args.timeoutMs ?? 15000);
    return ctx.token.run(async () => {
      const rt = await resolveTargetOrFail(ctx, target);
      if (!rt.ok) return rt.result;
      if (!rt.value.pos) return fail('precondition_failed', { reasonDetail: 'target has no position' });
      // A pure coordinate is often a block you cannot stand in (dirt/ore). go_to means "get
      // near", so snap a cell target to the nearest STANDABLE cell and report the real goal.
      let pos = rt.value.pos;
      let snappedFrom: Vec3 | undefined;
      if ((target as { kind?: string }).kind === 'cell') {
        const s = await nearestStandable(ctx, pos, 4);
        if (s && (s[0] !== pos[0] || s[1] !== pos[1] || s[2] !== pos[2])) {
          snappedFrom = pos;
          pos = s;
        }
      }
      const r = await ctx.ctrl.goto(pos, { range, allowModify, timeoutMs });
      const broken = ((r.raw as { blocksBroken?: string[] } | undefined)?.blocksBroken) ?? [];
      const progress = broken.length
        ? {
            effects: broken.map((b) => ({ subject: `block@${b}`, predicate: 'is', value: 'minecraft:air' })),
            evidence: broken.map((b) => ({ claim: 'block_removed', source: 'authoritative' as const, value: b })),
            data: { blocksBroken: broken },
          }
        : {};
      const self = await ctx.world.selfPos();
      const arrived = !!self && distance(self, pos) <= range + 0.75;
      if (arrived) {
        return pass({
          evidence: [{ claim: 'self_pos', source: 'authoritative', value: self }, ...(progress.evidence ?? [])],
          ...(broken.length ? { effects: progress.effects } : {}),
          data: { target: pos, ...(snappedFrom ? { snappedFrom } : {}), ...(broken.length ? { blocksBroken: broken } : {}) },
          attribution: 'self_temporal',
        });
      }
      if (!r.accepted) {
        return mk({ effectStatus: 'unobservable', controlStatus: 'needs_replan', reason: 'precondition_failed', reasonDetail: r.note, ...progress });
      }
      return fail('effect_not_observed', { evidence: [{ claim: 'self_pos', source: 'authoritative', value: self }, ...(progress.evidence ?? [])], ...progress });
    });
  },
};

const lookAt: AtomicAction = {
  contract: contract({
    name: 'look_at',
    description: 'Turn the view toward a target.',
    params: { type: 'object', properties: { target: TARGET_SCHEMA }, required: ['target'], additionalProperties: false },
    effectClass: 'idempotent',
    controlOnly: true,
  }),
  async run(ctx, args): Promise<ActionResult> {
    const target = args.target as Target;
    return ctx.token.run(async () => {
      const rt = await resolveTargetOrFail(ctx, target);
      if (!rt.ok) return rt.result;
      if (!rt.value.pos) return fail('precondition_failed', { reasonDetail: 'target has no position' });
      const r = await ctx.ctrl.lookAt(rt.value.pos);
      return r.accepted ? pass({ attribution: 'self_temporal' }) : fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

const wait: AtomicAction = {
  contract: contract({
    name: 'wait',
    description: 'Wait a number of game ticks (20/s) — a control action, no world effect.',
    params: { type: 'object', properties: { ticks: { type: 'integer', default: 20 } }, additionalProperties: false },
    effectClass: 'idempotent',
    controlOnly: true,
  }),
  async run(ctx, args): Promise<ActionResult> {
    const r = await ctx.ctrl.wait(Number(args.ticks ?? 20));
    return r.accepted ? pass({ evidence: [{ claim: 'waited', source: 'observed' }] }) : fail('effect_not_observed', { reasonDetail: r.note });
  },
};

const follow: AtomicAction = {
  contract: contract({
    name: 'follow',
    description: 'Follow a target entity for a bounded duration, keeping within `distance` (control action).',
    params: { type: 'object', properties: { target: TARGET_SCHEMA, distance: { type: 'number', default: 3 }, durationMs: { type: 'integer', default: 5000 } }, required: ['target'], additionalProperties: false },
    effectClass: 'idempotent',
    controlOnly: true,
    verificationMode: 'task_terminal',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const target = args.target as Target;
    return ctx.token.run(async () => {
      const rt = await resolveTargetOrFail(ctx, target);
      if (!rt.ok) return rt.result;
      if (!rt.value.entityId) return fail('precondition_failed', { reasonDetail: 'target has no entity' });
      const r = await ctx.ctrl.follow(rt.value.entityId, Number(args.distance ?? 3), Number(args.durationMs ?? 5000));
      return r.accepted ? mk({ effectStatus: 'pass', evidence: [{ claim: 'followed', source: 'observed' }], attribution: 'self_temporal' }) : fail('effect_not_observed', { reasonDetail: r.note });
    });
  },
};

const flee: AtomicAction = {
  contract: contract({
    name: 'flee',
    description: 'Move away from a target entity to at least `distance` blocks (control action).',
    params: { type: 'object', properties: { target: TARGET_SCHEMA, distance: { type: 'number', default: 12 } }, required: ['target'], additionalProperties: false },
    effectClass: 'idempotent',
    controlOnly: true,
    verificationMode: 'task_terminal',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const target = args.target as Target;
    return ctx.token.run(async () => {
      const rt = await resolveTargetOrFail(ctx, target);
      if (!rt.ok) return rt.result;
      if (!rt.value.entityId) return fail('precondition_failed', { reasonDetail: 'target has no entity' });
      const r = await ctx.ctrl.flee(rt.value.entityId, Number(args.distance ?? 12));
      return r.accepted ? mk({ effectStatus: 'pass', evidence: [{ claim: 'fled', source: 'observed' }], attribution: 'self_temporal' }) : mk({ effectStatus: 'ambiguous', reason: 'effect_not_observed', reasonDetail: r.note, attribution: 'self_temporal' });
    });
  },
};

const steer: AtomicAction = {
  contract: contract({
    name: 'steer',
    description: 'Low-level steering escape hatch: hold raw movement controls for a duration (control action).',
    params: { type: 'object', properties: { controls: { type: 'array', items: { type: 'string' } }, durationMs: { type: 'integer', default: 500 } }, required: ['controls'], additionalProperties: false },
    effectClass: 'idempotent',
    controlOnly: true,
  }),
  async run(ctx, args): Promise<ActionResult> {
    const controls = Array.isArray(args.controls) ? (args.controls as string[]) : [];
    const r = await ctx.ctrl.steer(controls, Number(args.durationMs ?? 500));
    return r.accepted ? pass({ evidence: [{ claim: 'steered', source: 'observed', value: controls }] }) : fail('effect_not_observed', { reasonDetail: r.note });
  },
};

export const movementActions: AtomicAction[] = [goTo, follow, flee, lookAt, wait, steer];
