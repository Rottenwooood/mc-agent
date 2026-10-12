// Run a secondary action: fetch a version (active, or a specific one for validation), execute
// it with the bounded vocabulary, judge it by its terminal postconditions, and record the
// online outcome (with net-effect) into the library so the activation gate can see it.
//
// This is the "校验口": it runs any version — active (normal use) or a draft (validation/upgrade).
// Once an action is active it is also exposed as a first-class tool (dynamic registration).

import type { ActionResult } from '@mc-agent/contracts';
import { mk } from '@mc-agent/execution';
import type { ActionContext, AtomicAction } from '@mc-agent/execution';
import type { ActionLibrary } from '@mc-agent/knowledge';
import { runMethod, type RunMethodOptions } from './executor.js';
import { evalPredicate } from './predicate.js';

export interface TryActionOptions extends RunMethodOptions {
  /** Run a specific version (to validate a draft) instead of the active one. */
  version?: number;
  /** Interventional net-effect tags recorded alongside the attempt. */
  repair?: boolean;
  regression?: boolean;
}

export async function tryAction(
  ctx: ActionContext,
  actions: Map<string, AtomicAction>,
  library: ActionLibrary,
  name: string,
  opts: TryActionOptions = {},
): Promise<ActionResult> {
  const v = opts.version !== undefined ? library.version(name, opts.version) : library.active(name);
  if (!v) {
    return mk({
      effectStatus: 'unobservable',
      reason: 'precondition_failed',
      reasonDetail: `no ${opts.version !== undefined ? `version ${opts.version} of` : 'active'} action named ${name}`,
    });
  }

  // Preconditions gate the run (false is a hard precondition_failed; unknown does not block).
  for (const p of v.method.preconditions) {
    if ((await evalPredicate(ctx, p)) === false) {
      return mk({
        effectStatus: 'fail',
        reason: 'precondition_failed',
        reasonDetail: `action ${name}@${v.version} precondition not met`,
      });
    }
  }

  const res = await runMethod(
    ctx,
    actions,
    { steps: v.method.steps, postconditions: v.method.postconditions, ...(v.method.name ? { name: v.method.name } : {}) },
    {
      ...(opts.args ? { args: opts.args } : {}),
      ...(opts.budget ? { budget: opts.budget } : {}),
      ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}),
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
      // Hierarchical composition: a step may call another ACTIVE secondary action.
      callSecondary: (c, acts, nm, a, d) => tryAction(c, acts, library, nm, { args: a, depth: d }),
    },
  );

  const outcome = res.effectStatus === 'pass' ? 'pass' : res.effectStatus === 'fail' ? 'fail' : 'unknown';
  library.record(name, v.version, {
    outcome,
    ...(opts.repair ? { repair: true } : {}),
    ...(opts.regression ? { regression: true } : {}),
  });

  return {
    ...res,
    data: { ...((res.data as Record<string, unknown> | null) ?? {}), action: { name, version: v.version } },
  };
}
