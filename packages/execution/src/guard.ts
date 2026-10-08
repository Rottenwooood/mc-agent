// Central guarded execution: every action runs under the reflex shield and the control token.
// This is the single place reflex intercepts — it is never the action's own business.

import type { ActionResult } from '@mc-agent/contracts';
import { fail, mk } from './result.js';
import type { ActionContext, AtomicAction } from './actions/types.js';

/** Actions the shield treats as a legitimate response to a threat. */
const DEFENSIVE = new Set(['attack', 'flee', 'use_item_on', 'consume']);

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

  return ctx.token.run(async () => {
    if (!reflex) return action.run(ctx, args);

    const state: { violation: string | null } = { violation: null };
    const monitor = reflex.monitor({ defensive }, (reason) => {
      state.violation = reason;
    });
    try {
      const result = await action.run(ctx, args);
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
    } finally {
      monitor.stop();
    }
  });
}
