// L3 contract engine (framework §6): wraps a body action with a before/after causal-neighbourhood
// signature, computes the diff, and lets the action declare its own independent postcondition.
//
// Crucially it reconciles the common "the tool reported a timeout/interrupt, but the effect did
// happen" case: an effect that is present in the authoritative after-signature is accepted.

import type { ActionResult, NeighborhoodDiff, Vec3 } from '@mc-agent/contracts';
import { guardedRun } from '../guard.js';
import type { ActionContext, AtomicAction } from '../actions/types.js';
import { captureSignature, diffSignatures, type EffectScope, type SignatureDiff, type VerifyOutcome } from './signature.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 500;

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
  return self ? { box, anchor: self } : { box };
}

export async function executeAction(
  ctx: ActionContext,
  action: AtomicAction,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  // Reads change nothing; no signature/causal accounting needed.
  if (action.contract.effectClass === 'read') return guardedRun(ctx, action, args);

  const scope = (action.scope ? await action.scope(ctx, args) : null) ?? (await defaultScope(ctx));
  const before = await captureSignature(ctx, scope);
  const result = await guardedRun(ctx, action, args);
  // Effects can land just after an interrupt/timeout; give the world a moment before re-reading.
  if (result.effectStatus !== 'pass') await sleep(SETTLE_MS);
  const after = await captureSignature(ctx, scope);
  const diff = diffSignatures(before, after);

  if (action.verify) {
    const v = await action.verify(ctx, args, { before, after, diff, ...(scope.anchor ? { anchor: scope.anchor } : {}) });
    if (v) return reconcile(result, v, diff);
  }
  return { ...result, diff: toNeighborhoodDiff(diff) };
}
