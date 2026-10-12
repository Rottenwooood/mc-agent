// L3 contract engine (framework §6): wraps a body action with a before/after causal-neighbourhood
// signature, computes the diff, and lets the action declare its own independent postcondition.
//
// Crucially it reconciles the common "the tool reported a timeout/interrupt, but the effect did
// happen" case: an effect that is present in the authoritative after-signature is accepted.

import type { ActionResult, EventCursor, NeighborhoodDiff, Vec3, WorldEvent } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { guardedRun } from '../guard.js';
import type { ActionContext, AtomicAction } from '../actions/types.js';
import { captureSignature, diffSignatures, type EffectScope, type SignatureDiff, type VerifyOutcome } from './signature.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 500;

// Time-ordered world-change feed: one cursor for the resident (a single agent). After each body
// action we read the events since the previous action, so no side effect is silent.
let changeCursor: EventCursor | undefined;
let changeBaselineReady = false;

/**
 * Establish the change-feed baseline by consuming any pre-existing event backlog. Must run BEFORE
 * an action so the first feed reports only that action's own changes (never stale history).
 */
export async function primeChanges(ctx: ActionContext): Promise<void> {
  if (changeBaselineReady) return;
  try {
    const page = await ctx.world.events(changeCursor, 512);
    changeCursor = page.cursor;
  } catch {
    /* ignore */
  }
  changeBaselineReady = true;
}

function formatEvent(e: WorldEvent): string {
  const who = e.actor ?? '?';
  const at = e.pos ? ` at ${e.pos.join(',')}` : '';
  if (e.after === 'minecraft:air' && e.before) return `${who} ${e.before} is broken${at}`;
  if ((!e.before || e.before === 'minecraft:air') && e.after) return `${who} ${e.after} is placed${at}`;
  if (e.before && e.after) return `${who} ${e.before} is changed to ${e.after}${at}`;
  return `${who} ${e.type}${at}`;
}

async function collectChanges(ctx: ActionContext): Promise<string[]> {
  try {
    const page = await ctx.world.events(changeCursor, 256);
    changeCursor = page.cursor;
    if (!changeBaselineReady || page.resetRequired) {
      changeBaselineReady = true;
      return [];
    }
    return page.events.map(formatEvent);
  } catch {
    return [];
  }
}

/** The current world-change cursor (snapshot it before a composed run). */
export function changesCursor(): EventCursor | undefined {
  return changeCursor;
}

/** Format every world event since `cursor` (used to build a composed run's one clean feed). */
export async function changesSince(ctx: ActionContext, cursor: EventCursor | undefined, max = 512): Promise<string[]> {
  try {
    const page = await ctx.world.events(cursor, max);
    return page.resetRequired ? [] : page.events.map(formatEvent);
  } catch {
    return [];
  }
}

/** Nearby dropped items — so mining is never silently decoupled from pickup. */
async function nearbyDrops(ctx: ActionContext, radius = 4): Promise<string[]> {
  try {
    const es = await ctx.world.entities(radius);
    if (isUnknown(es)) return [];
    const n = es.value.filter((e) => e.type === 'minecraft:item').length;
    return n > 0 ? [`${n} dropped item(s) nearby — use collect to pick them up`] : [];
  } catch {
    return [];
  }
}

function toNeighborhoodDiff(d: SignatureDiff): NeighborhoodDiff {
  const nd: NeighborhoodDiff = { changed: d.changed };
  if (d.blocksAdded.length > 0) nd.blocksAdded = d.blocksAdded;
  if (d.blocksRemoved.length > 0) nd.blocksRemoved = d.blocksRemoved;
  if (d.blocksChanged.length > 0) nd.blocksChanged = d.blocksChanged;
  if (Object.keys(d.inventoryDelta).length > 0) nd.inventoryDelta = d.inventoryDelta;
  return nd;
}

function reconcile(result: ActionResult, v: VerifyOutcome, d: SignatureDiff): ActionResult {
  const diff = toNeighborhoodDiff(d);
  const evidence = [...result.evidence, ...v.evidence];
  const noChange = !d.changed && Object.keys(d.inventoryDelta).length === 0;
  if (v.ok === 'fail') {
    return { ...result, effectStatus: 'fail', reason: result.reason ?? 'effect_not_observed', evidence, diff };
  }
  if (v.ok === 'no_op') {
    return { ...result, effectStatus: 'no_op', reason: null, reasonDetail: 'already satisfied (no change)', evidence, diff };
  }
  if (v.ok === 'pass') {
    // A verify "pass" is only a real pass if the world actually changed. If nothing changed
    // anywhere in scope, the postcondition held vacuously — report `no_op`, never `pass`.
    if (noChange) {
      return { ...result, effectStatus: 'no_op', reason: null, reasonDetail: 'already satisfied (no change)', evidence, diff };
    }
    const reconciled = result.effectStatus !== 'pass';
    return {
      ...result,
      effectStatus: 'pass',
      reason: reconciled ? null : result.reason,
      reasonDetail: reconciled
        ? `verified after execution${result.reasonDetail ? ` (was: ${result.reasonDetail})` : ''}`
        : result.reasonDetail,
      evidence,
      diff,
      attribution: result.attribution === 'unknown' ? 'self_temporal' : result.attribution,
    };
  }
  return { ...result, evidence, diff };
}

async function defaultScope(ctx: ActionContext): Promise<EffectScope> {
  const self = await ctx.world.selfPos();
  const c: Vec3 = self ?? [0, 0, 0];
  const box = { min: [c[0] - 2, c[1] - 2, c[2] - 2] as Vec3, max: [c[0] + 2, c[1] + 2, c[2] + 2] as Vec3 };
  // NO anchor: an unresolved target must not degrade to a self-anchor (that caused the vacuous
  // "air == air" pass). A verify without an anchor returns `unobservable`, never `pass`.
  return { box };
}

export async function executeAction(
  ctx: ActionContext,
  action: AtomicAction,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  // Control-only actions claim NO world effect: never run the effect / `pass ⇒ changed`
  // accounting, and label the verdict as a control outcome (not a world-effect pass).
  if (action.contract.controlOnly) {
    await primeChanges(ctx);
    const p0 = await ctx.world.selfPos();
    const result = await guardedRun(ctx, action, args);
    const p1 = await ctx.world.selfPos();
    const changes = await collectChanges(ctx);
    if (p0 && p1 && (p0[0] !== p1[0] || p0[1] !== p1[1] || p0[2] !== p1[2])) {
      changes.push(`A moved to ${p1.map((v) => v.toFixed(1)).join(',')}`);
    }
    changes.push(...(await nearbyDrops(ctx)));
    const { attribution: _dropped, ...rest } = result;
    return { ...rest, controlOnly: true, ...(changes.length > 0 ? { changes } : {}) };
  }

  // Reads change nothing; no signature/causal accounting needed, and no effect attribution.
  if (action.contract.effectClass === 'read') {
    const { attribution: _dropped, ...rest } = await guardedRun(ctx, action, args);
    return rest;
  }

  await primeChanges(ctx);
  const scope = (action.scope ? await action.scope(ctx, args) : null) ?? (await defaultScope(ctx));
  const before = await captureSignature(ctx, scope);
  const result = await guardedRun(ctx, action, args);
  // Effects can land just after an interrupt/timeout; give the world a moment before re-reading.
  if (result.effectStatus !== 'pass') await sleep(SETTLE_MS);
  const after = await captureSignature(ctx, scope);
  const diff = diffSignatures(before, after);

  let final: ActionResult;
  if (action.verify) {
    const v = await action.verify(ctx, args, { before, after, diff, ...(scope.anchor ? { anchor: scope.anchor } : {}) });
    final = v ? reconcile(result, v, diff) : { ...result, diff: toNeighborhoodDiff(diff) };
  } else {
    final = { ...result, diff: toNeighborhoodDiff(diff) };
  }

  // Time-ordered world-change feed (no silent side effects): events + inventory delta + a move line.
  const changes = await collectChanges(ctx);
  for (const [item, d] of Object.entries(diff.inventoryDelta)) changes.push(`A ${item} ${d > 0 ? '+' + d : d}`);
  if (before.pos && after.pos && (before.pos[0] !== after.pos[0] || before.pos[1] !== after.pos[1] || before.pos[2] !== after.pos[2])) {
    changes.push(`A moved to ${after.pos.map((v) => v.toFixed(1)).join(',')}`);
  }
  changes.push(...(await nearbyDrops(ctx)));
  return changes.length > 0 ? { ...final, changes } : final;
}
