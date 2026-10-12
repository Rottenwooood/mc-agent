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
import { changesCursor, changesSince, executeAction, mk, primeChanges, type ActionContext, type AtomicAction } from '@mc-agent/execution';
import { evalExpr, resolveArg, type Vars } from './args.js';
import { evalSet } from './sets.js';
import { evalPredicate } from './predicate.js';

export interface RunEnv {
  ctx: ActionContext;
  vars: Vars;
  actions: Map<string, AtomicAction>;
  results: ActionResult[];
  trace: StepTrace[];
  budget: number;
  deadline: number;
  /** Secondary-action nesting depth (guards against unbounded recursion). */
  depth: number;
  /** Dispatch an action name to a defined secondary action; absent = atoms only. */
  callSecondary?: CallSecondary;
}

/** Per-step outcome, so credit can be assigned to the step that actually broke. */
export interface StepTrace {
  action: string;
  effectStatus: ActionResult['effectStatus'];
  reason?: ActionResult['reason'];
  /** The step's reasonDetail (truncated), so the run's summary can name the real cause. */
  detail?: string;
  ms: number;
}

export type CallSecondary = (
  ctx: ActionContext,
  actions: Map<string, AtomicAction>,
  name: string,
  args: Record<string, unknown>,
  depth: number,
) => Promise<ActionResult>;

/** Max secondary→secondary nesting depth (each level is a defined method call). */
export const MAX_SECONDARY_DEPTH = 8;

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
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step.args ?? {})) args[k] = resolveArg(v, env.vars);
  const t0 = Date.now();
  const action = env.actions.get(step.action);
  let result: ActionResult;
  if (action) {
    result = await executeAction(env.ctx, action, args);
  } else if (env.callSecondary && env.depth < MAX_SECONDARY_DEPTH) {
    // Hierarchical composition: a defined secondary action called from a method (abstraction accumulates).
    result = await env.callSecondary(env.ctx, env.actions, step.action, args, env.depth + 1);
  } else {
    result = mk({
      effectStatus: 'unobservable',
      reason: 'precondition_failed',
      reasonDetail:
        env.depth >= MAX_SECONDARY_DEPTH
          ? `secondary recursion too deep (>${MAX_SECONDARY_DEPTH}) at ${step.action}`
          : `unknown action ${step.action}`,
    });
  }
  env.results.push(result);
  env.trace.push({
    action: step.action,
    effectStatus: result.effectStatus,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.reasonDetail ? { detail: result.reasonDetail.slice(0, 120) } : {}),
    ms: Date.now() - t0,
  });
  if (step.save) env.vars[step.save] = result.data ?? result;
}

export interface RunMethodOptions {
  budget?: number;
  args?: Record<string, unknown>;
  /** Wall-clock ceiling so a composed run always returns (must stay under the MCP call cap). */
  budgetMs?: number;
  /** Secondary-action nesting depth (set by tryAction for recursion guarding). */
  depth?: number;
  /** Dispatch an action name to a defined secondary action (hierarchical composition). */
  callSecondary?: CallSecondary;
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
  await primeChanges(ctx);
  const cursor0 = changesCursor();
  const env: RunEnv = {
    ctx,
    vars: { ...(opts.args ?? {}) },
    actions,
    results: [],
    trace: [],
    budget: opts.budget ?? 4096,
    deadline: start + budgetMs,
    depth: opts.depth ?? 0,
    ...(opts.callSecondary ? { callSecondary: opts.callSecondary } : {}),
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

  // Enforce `pass ⇒ changed` for the WHOLE run: a terminal "true" only counts as pass when at
  // least one sub-result actually changed the world; otherwise the run was a no-op.
  let effectStatus: ActionResult['effectStatus'] = triToEffect(tri);
  const reason: ActionResult['reason'] = timedOut ? 'timeout' : tri === true ? null : tri === false ? 'effect_not_observed' : 'insufficient_evidence';
  let reasonDetail: string | undefined;
  if (effectStatus === 'pass' && !runChanged(env)) {
    effectStatus = 'no_op';
    reasonDetail = 'already satisfied (no change)';
  }

  // One clean time-ordered change feed for the whole composed run (no silent side effects).
  const changes = await changesSince(ctx, cursor0);
  const inv: Record<string, number> = {};
  for (const r of env.results) {
    for (const [k, v] of Object.entries(r.diff?.inventoryDelta ?? {})) inv[k] = (inv[k] ?? 0) + v;
  }
  const invDelta = Object.fromEntries(Object.entries(inv).filter(([, d]) => d !== 0));

  // Describe a non-pass run HONESTLY: the run-level reason stays, and the detail names which steps
  // did not complete AND the net change — so the verdict never contradicts the diff (a partial run
  // that did change the world says so).
  if (effectStatus !== 'pass' && effectStatus !== 'no_op') {
    const bad = env.trace.filter((t) => t.effectStatus === 'fail' || t.effectStatus === 'unobservable' || t.effectStatus === 'ambiguous');
    const parts: string[] = [];
    if (bad.length) {
      const shown = bad.slice(0, 3).map((t) => `${t.action} (${t.detail ?? t.reason ?? t.effectStatus})`);
      parts.push(`${bad.length}/${env.trace.length} steps did not complete: ${shown.join(', ')}${bad.length > 3 ? ', …' : ''}`);
    }
    const net = [...changes, ...Object.entries(invDelta).map(([k, d]) => `${k} ${d > 0 ? '+' + d : d}`)];
    if (net.length) parts.push(`net change: ${net.slice(0, 6).join(', ')}${net.length > 6 ? ` (+${net.length - 6} more)` : ''}`);
    if (parts.length) reasonDetail = parts.join(' | ');
  }

  for (const [item, d] of Object.entries(invDelta)) changes.push(`A ${item} ${d > 0 ? '+' + d : d}`);

  return mk({
    effectStatus,
    controlStatus: timedOut ? 'interrupted' : 'completed',
    reason,
    ...(reasonDetail ? { reasonDetail } : {}),
    // Expose the run's net diff so a NESTED run (secondary called from a method) propagates its
    // change to the outer run's `pass ⇒ changed` and inventory aggregation.
    diff: { changed: changes.length > 0 || Object.keys(invDelta).length > 0, ...(Object.keys(invDelta).length ? { inventoryDelta: invDelta } : {}) },
    subResults: env.results,
    attribution: 'self_temporal',
    ...(changes.length ? { changes } : {}),
    data: { steps: env.results.length, budgetLeft: env.budget, elapsedMs: Date.now() - start, timedOut, trace: env.trace, ...(blocksBroken.length ? { blocksBroken } : {}) },
  });
}

/** Did anything in the run actually change the world (blocks or inventory)? */
function runChanged(env: RunEnv): boolean {
  return env.results.some(
    (r) => r.diff?.changed === true || Object.values(r.diff?.inventoryDelta ?? {}).some((n) => n !== 0),
  );
}

// ---- static validation (run_method validate:true — no execution) ----

export interface ValidationError {
  path: string;
  message: string;
}
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  steps: number;
}

const CONTROL_OPS = new Set(['sequence', 'for_each', 'repeat', 'branch']);
const SET_OPS = new Set(['members', 'surface', 'nearest', 'area', 'component', 'region', 'box_cells', 'set_difference', 'inventory', 'container', 'entities']);
const PRED_OPS = new Set(['is', '==', '!=', '>=', '<=', '>', '<']);

function checkSet(set: unknown, path: string, errors: ValidationError[]): void {
  if (typeof set !== 'object' || set === null) return void errors.push({ path, message: 'set must be an object' });
  const s = set as Record<string, unknown>;
  const op = String(s.op ?? '');
  if (!SET_OPS.has(op)) return void errors.push({ path, message: `unknown set op ${JSON.stringify(s.op)} (one of ${[...SET_OPS].join(', ')})` });
  const need: Record<string, string[]> = {
    members: ['handle'], surface: ['handle'], container: ['handle'], nearest: ['match'],
    area: ['anchor', 'size'], box_cells: ['box'], region: ['box'], component: ['seed', 'match'],
    set_difference: ['a', 'b'],
  };
  for (const k of need[op] ?? []) if (s[k] === undefined) errors.push({ path: `${path}.${k}`, message: `${op} requires ${k}` });
  if (op === 'set_difference') {
    checkSet(s.a, `${path}.a`, errors);
    checkSet(s.b, `${path}.b`, errors);
  }
}

function checkPredicate(p: unknown, path: string, errors: ValidationError[]): void {
  if (typeof p !== 'object' || p === null) return void errors.push({ path, message: 'predicate must be an object' });
  const o = p as Record<string, unknown>;
  if (typeof o.subject !== 'string' || o.subject.length === 0) errors.push({ path: `${path}.subject`, message: 'predicate needs a subject string' });
  if (!PRED_OPS.has(String(o.predicate))) errors.push({ path: `${path}.predicate`, message: `predicate must be one of ${[...PRED_OPS].join(', ')}` });
}

function checkSteps(steps: unknown, path: string, isAction: (n: string) => boolean, errors: ValidationError[], counter: { n: number }): void {
  if (!Array.isArray(steps)) return void errors.push({ path, message: 'steps must be an array' });
  steps.forEach((raw, i) => {
    const p = `${path}[${i}]`;
    if (typeof raw !== 'object' || raw === null) return void errors.push({ path: p, message: 'step must be an object' });
    const st = raw as Record<string, unknown>;
    if (typeof st.action === 'string') {
      counter.n += 1;
      if (!isAction(st.action)) errors.push({ path: `${p}.action`, message: `unknown action ${st.action}` });
      return;
    }
    const op = String(st.op ?? '');
    if (!CONTROL_OPS.has(op)) return void errors.push({ path: p, message: `step must have "action" or a control "op" (one of ${[...CONTROL_OPS].join(', ')})` });
    if (op === 'sequence') checkSteps(st.steps, `${p}.steps`, isAction, errors, counter);
    else if (op === 'for_each') {
      checkSet(st.set, `${p}.set`, errors);
      if (typeof st.as !== 'string') errors.push({ path: `${p}.as`, message: 'for_each requires a loop var name "as"' });
      checkSteps(st.body, `${p}.body`, isAction, errors, counter);
    } else if (op === 'repeat') {
      checkSteps(st.body, `${p}.body`, isAction, errors, counter);
      if (st.until !== undefined) checkPredicate(st.until, `${p}.until`, errors);
    } else if (op === 'branch') {
      if (st.if !== undefined) checkPredicate(st.if, `${p}.if`, errors);
      else errors.push({ path: `${p}.if`, message: 'branch requires "if"' });
      checkSteps(st.then, `${p}.then`, isAction, errors, counter);
      if (st.else !== undefined) checkSteps(st.else, `${p}.else`, isAction, errors, counter);
    }
  });
}

/**
 * Structurally validate a composed method WITHOUT executing it: known action names, set ops and
 * their required fields, control-step shape, and postcondition/until/if predicates.
 */
export function validateMethod(
  method: Composable,
  opts: { actions: Map<string, AtomicAction>; isSecondary?: (name: string) => boolean },
): ValidationResult {
  const errors: ValidationError[] = [];
  const isAction = (n: string): boolean => opts.actions.has(n) || opts.isSecondary?.(n) === true;
  const counter = { n: 0 };
  checkSteps(method.steps, 'steps', isAction, errors, counter);
  (method.postconditions ?? []).forEach((p, i) => checkPredicate(p, `postconditions[${i}]`, errors));
  return { valid: errors.length === 0, errors, steps: counter.n };
}

async function terminal(ctx: ActionContext, preds: Predicate[], env: RunEnv): Promise<Tri> {
  if (preds.length === 0) {
    const anyFail = env.results.some((r) => r.effectStatus === 'fail');
    const anyUnknown = env.results.some((r) => r.effectStatus === 'unobservable' || r.effectStatus === 'ambiguous');
    return anyFail ? false : anyUnknown ? undefined : true;
  }
  return and(await Promise.all(preds.map((p) => evalPredicate(ctx, p))));
}
