// Movement atomic actions. Targets are semantic; coordinates are resolved internally.

import type { ActionResult, Target } from '@mc-agent/contracts';
import { distance } from '@mc-agent/world';
import { mk, pass, fail } from '../result.js';
import type { AtomicAction } from './types.js';
import { contract } from './types.js';
import { resolveTargetOrFail, TARGET_SCHEMA } from './target.js';

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
      const pos = rt.value.pos;
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
          ...(broken.length ? { effects: progress.effects, data: progress.data } : {}),
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
