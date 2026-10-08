// Argument binding for the bounded vocabulary: literals, references to earlier bound values,
// and small bounded arithmetic. No arbitrary code — data only.

import type { Expr } from '@mc-agent/contracts';

export type Vars = Record<string, unknown>;

/** Deeply resolve a step argument: `{from:name}` reads a bound variable; `{expr}` evaluates. */
export function resolveArg(arg: unknown, vars: Vars): unknown {
  if (arg === null || arg === undefined) return arg;
  if (Array.isArray(arg)) return arg.map((a) => resolveArg(a, vars));
  if (typeof arg === 'object') {
    const o = arg as Record<string, unknown>;
    if (typeof o.from === 'string' && Object.keys(o).length === 1) return vars[o.from];
    if ('expr' in o) return evalExpr(o.expr as Expr, vars);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = resolveArg(v, vars);
    return out;
  }
  return arg;
}

export function evalExpr(e: Expr, vars: Vars): number | string | boolean {
  if (typeof e !== 'object' || e === null) return e as number | string | boolean;
  const op = (e as { op?: string }).op;
  const raw = (e as { args?: Expr[] }).args ?? [];
  const args = raw.map((a) => evalExpr(a, vars));
  const nums = args.map((a) => Number(a));
  switch (op) {
    case '+':
      return nums.reduce((a, b) => a + b, 0);
    case '*':
      return nums.reduce((a, b) => a * b, 1);
    case '-':
      return nums.reduce((a, b, i) => (i === 0 ? a : a - b), 0);
    case '/':
      return nums.reduce((a, b, i) => (i === 0 ? a : b === 0 ? Number.NaN : a / b), 0);
    case 'min':
      return nums.length ? Math.min(...nums) : Number.NaN;
    case 'max':
      return nums.length ? Math.max(...nums) : Number.NaN;
    default:
      return Number.NaN;
  }
}
