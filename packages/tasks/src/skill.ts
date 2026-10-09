// Run a stored skill: fetch the active version from the library, execute it with the bounded
// vocabulary, judge it by its terminal postconditions, and record the outcome (with the world
// seed/role) into the library so the promotion gate can see it.

import type { ActionResult } from '@mc-agent/contracts';
import { mk } from '@mc-agent/execution';
import type { ActionContext, AtomicAction } from '@mc-agent/execution';
import type { SkillLibrary } from '@mc-agent/knowledge';
import { runMethod, type RunMethodOptions } from './executor.js';
import { evalPredicate } from './predicate.js';

export interface RunSkillOptions extends RunMethodOptions {
  /** Run a specific version (for validating a draft) instead of the active one. */
  version?: number;
  /** Interventional net-effect tags recorded alongside the attempt. */
  repair?: boolean;
  regression?: boolean;
}

export async function runSkill(
  ctx: ActionContext,
  actions: Map<string, AtomicAction>,
  library: SkillLibrary,
  name: string,
  opts: RunSkillOptions = {},
): Promise<ActionResult> {
  const v = opts.version !== undefined ? library.version(name, opts.version) : library.active(name);
  if (!v) {
    return mk({
      effectStatus: 'unobservable',
      reason: 'precondition_failed',
      reasonDetail: `no ${opts.version !== undefined ? `version ${opts.version} of` : 'active'} skill named ${name}`,
    });
  }

  // Preconditions gate the run (a false precondition is a hard precondition_failed; unknown
  // does not block — the terminal postconditions still judge the result).
  for (const p of v.method.preconditions) {
    if ((await evalPredicate(ctx, p)) === false) {
      return mk({
        effectStatus: 'fail',
        reason: 'precondition_failed',
        reasonDetail: `skill ${name}@${v.version} precondition not met`,
      });
    }
  }

  const res = await runMethod(
    ctx,
    actions,
    { steps: v.method.steps, postconditions: v.method.postconditions, ...(v.method.name ? { name: v.method.name } : {}) },
    opts,
  );

  const outcome = res.effectStatus === 'pass' ? 'pass' : res.effectStatus === 'fail' ? 'fail' : 'unknown';
  if (ctx.seed) {
    library.record(name, v.version, {
      seed: ctx.seed.value,
      role: ctx.seed.role,
      outcome,
      ...(opts.repair ? { repair: true } : {}),
      ...(opts.regression ? { regression: true } : {}),
    });
  }

  return {
    ...res,
    data: { ...((res.data as Record<string, unknown> | null) ?? {}), skill: { name, version: v.version } },
  };
}
