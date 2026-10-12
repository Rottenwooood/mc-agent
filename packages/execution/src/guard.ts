// Central guarded execution: every body-owning action runs under the reflex shield and the
// control token, with a hard timeout so a stuck operation can never hold the body forever.
//
// Reads do not own the body: they observe concurrently and never wait on the token.

import type { ActionResult } from '@mc-agent/contracts';
import { fail, mk } from './result.js';
import type { ActionContext, AtomicAction } from './actions/types.js';

/** Actions the shield treats as a legitimate response to a threat. */
const DEFENSIVE = new Set(['attack', 'flee', 'use_item_on', 'consume']);

/** Extra time on top of the contract's declared budget before we forcibly stop. */
const TIMEOUT_MARGIN_MS = 5000;
/** Absolute ceiling for any single action. */
const MAX_ACTION_MS = 90000;

class ActionTimeout extends Error {
  constructor() {
    super('action timeout');
    this.name = 'ActionTimeout';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ActionTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function guardedRun(
  ctx: ActionContext,
  action: AtomicAction,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const contract = action.contract;
  const defensive = DEFENSIVE.has(contract.name);
  const reflex = ctx.reflex;

  if (reflex) {
    const pre = await reflex.precheck({ effectClass: contract.effectClass, defensive });
    if (!pre.allow) {
      return fail('policy_blocked', {
        controlStatus: 'blocked',
        reasonDetail: `reflex: ${pre.reason}`,
        evidence: [{ claim: 'reflex_precheck', source: 'authoritative', value: { reason: pre.reason, threat: pre.threat } }],
        attribution: 'self_temporal',
      });
    }
  }

  // Reads observe the world; they never own the body and never wait for the token.
  if (contract.effectClass === 'read') {
    return action.run(ctx, args);
  }

  return ctx.token.run(async () => {
    const state: { violation: string | null } = { violation: null };
    const monitor = reflex
      ? reflex.monitor({ defensive }, (reason) => {
          state.violation = reason;
        })
      : null;
    const timeoutMs = Math.min(MAX_ACTION_MS, Math.max(1000, contract.timeoutTicks * 50) + TIMEOUT_MARGIN_MS);
    try {
      let result: ActionResult;
      try {
        result = await withTimeout(Promise.resolve(action.run(ctx, args)), timeoutMs);
      } catch (inner) {
        if (inner instanceof ActionTimeout) throw inner;
        // Never surface a raw JS exception to the model — return a structured, self-correcting error.
        return mk({
          effectStatus: 'fail',
          controlStatus: 'needs_replan',
          reason: 'precondition_failed',
          reasonDetail: `${contract.name} threw: ${String((inner as Error)?.message ?? inner)}`,
          data: { tool: contract.name },
        });
      }
      if (state.violation) {
        await ctx.ctrl.stopMotion();
        return mk({
          effectStatus: 'unobservable',
          controlStatus: 'interrupted',
          reason: 'policy_blocked',
          reasonDetail: `reflex interrupt: ${state.violation}`,
          evidence: [{ claim: 'reflex_interrupt', source: 'authoritative', value: { reason: state.violation } }],
          attribution: 'self_temporal',
        });
      }
      return result;
    } catch (e) {
      if (e instanceof ActionTimeout) {
        await ctx.ctrl.stopMotion();
        return mk({
          effectStatus: 'unobservable',
          controlStatus: 'interrupted',
          reason: 'timeout',
          reasonDetail: `${contract.name} exceeded ${timeoutMs}ms`,
          attribution: 'self_temporal',
        });
      }
      throw e;
    } finally {
      monitor?.stop();
    }
  });
}
