// Bounded-vocabulary executor (framework §7). Executes declared data only — never
// model-generated code. Sets are recomputed fresh (target-conditioned), and a whole-method
// terminal postcondition judges the run.

import type {
  ActionStep,
  ActionResult,
  ControlStep,
  Predicate,
  Step,
  Tri,
} from '@mc-agent/contracts';
import { and, triToEffect } from '@mc-agent/contracts';
import { executeAction, mk, type ActionContext, type AtomicAction } from '@mc-agent/execution';
import { evalExpr, resolveArg, type Vars } from './args.js';
import { evalSet } from './sets.js';
import { evalPredicate } from './predicate.js';

export interface RunEnv {
  ctx: ActionContext;
  vars: Vars;
  actions: Map<string, AtomicAction>;
  results: ActionResult[];
  budget: number;
  deadline: number;
}

/** A composable declared by the agent: bounded steps + optional terminal postconditions. */
export interface Composable {
  steps: Step[];
  postconditions?: Predicate[];
  name?: string;
}

const isActionStep = (s: Step): s is ActionStep => 'action' in s;

export async function runStep(step: Step, env: RunEnv): Promise<void> {
  if (env.budget-- <= 0 || Date.now() > env.deadline) return;
  if (isActionStep(step)) return runAction(step, env);
  return runControl(step as ControlStep, env);
}

async function runControl(c: ControlStep, env: RunEnv): Promise<void> {
  switch (c.op) {
    case 'sequence':
      for (const s of c.steps) {
        await runStep(s, env);
        if (env.budget <= 0) break;
      }
      return;
    case 'for_each': {
      const cells = await evalSet(env.ctx, c.set, env.vars);
      for (const cell of cells) {
        env.vars[c.as] = cell;
        for (const s of c.body) {
          await runStep(s, env);
          if (env.budget <= 0) break;
        }
        if (env.budget <= 0) break;
      }
      return;
    }
    case 'repeat': {
      const max = c.count !== undefined ? Math.max(0, Math.floor(Number(evalExpr(c.count, env.vars)))) : 32;
      for (let i = 0; i < max; i++) {
        for (const s of c.body) {
          await runStep(s, env);
          if (env.budget <= 0) break;
        }
        if (c.until && (await evalPredicate(env.ctx, c.until)) === true) break;
        if (env.budget <= 0) break;
      }
      return;
    }
    case 'branch': {
      const cond = c.if ? await evalPredicate(env.ctx, c.if) : undefined;
      const steps = cond === true ? c.then : cond === false ? (c.else ?? []) : [];
      for (const s of steps) {
        await runStep(s, env);
        if (env.budget <= 0) break;
      }
      return;
    }
  }
}

async function runAction(step: ActionStep, env: RunEnv): Promise<void> {
  const action = env.actions.get(step.action);
  if (!action) {
    env.results.push(
      mk({ effectStatus: 'unobservable', reason: 'precondition_failed', reasonDetail: `unknown action ${step.action}` }),
    );
    return;
  }
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step.args ?? {})) args[k] = resolveArg(v, env.vars);
  const result = await executeAction(env.ctx, action, args);
  env.results.push(result);
  if (step.save) env.vars[step.save] = result.data ?? result;
}

export interface RunMethodOptions {
  budget?: number;
  args?: Record<string, unknown>;
  /** Wall-clock ceiling so a composed run always returns (must stay under the MCP call cap). */
  budgetMs?: number;
}

/** Execute a declared method over the atomic action library; judge the whole run by its postconditions. */
export async function runMethod(
  ctx: ActionContext,
  actions: Map<string, AtomicAction>,
  method: Composable,
  opts: RunMethodOptions = {},
): Promise<ActionResult> {
  const start = Date.now();
  const budgetMs = opts.budgetMs ?? 90000;
  const env: RunEnv = {
    ctx,
    vars: { ...(opts.args ?? {}) },
    actions,
    results: [],
    budget: opts.budget ?? 4096,
    deadline: start + budgetMs,
  };
  for (const step of method.steps) {
    await runStep(step, env);
    if (env.budget <= 0 || Date.now() > env.deadline) break;
  }
  const timedOut = Date.now() > env.deadline;
  const tri: Tri = timedOut ? undefined : await terminal(ctx, method.postconditions ?? [], env);
  const blocksBroken = [
    ...new Set(
      env.results.flatMap((r) => ((r.data as { blocksBroken?: string[] } | undefined)?.blocksBroken) ?? []),
    ),
  ];
  return mk({
    effectStatus: triToEffect(tri),
    controlStatus: timedOut ? 'interrupted' : 'completed',
    reason: timedOut ? 'timeout' : tri === true ? null : tri === false ? 'effect_not_observed' : 'insufficient_evidence',
    subResults: env.results,
    attribution: 'self_temporal',
    data: { steps: env.results.length, budgetLeft: env.budget, elapsedMs: Date.now() - start, timedOut, ...(blocksBroken.length ? { blocksBroken } : {}) },
  });
}

async function terminal(ctx: ActionContext, preds: Predicate[], env: RunEnv): Promise<Tri> {
  if (preds.length === 0) {
    const anyFail = env.results.some((r) => r.effectStatus === 'fail');
    const anyUnknown = env.results.some((r) => r.effectStatus === 'unobservable' || r.effectStatus === 'ambiguous');
    return anyFail ? false : anyUnknown ? undefined : true;
  }
  return and(await Promise.all(preds.map((p) => evalPredicate(ctx, p))));
}
