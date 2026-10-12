// Argument binding for the bounded vocabulary: literals, references to earlier bound values,
// and small bounded arithmetic. No arbitrary code — data only.

import type { Expr } from '@mc-agent/contracts';

export type Vars = Record<string, unknown>;

/** Deeply resolve a step argument: `{from:name}` reads a bound variable; `{from:name,field}`
 *  projects one field of an element; `{expr}` evaluates. */
export function resolveArg(arg: unknown, vars: Vars): unknown {
  if (arg === null || arg === undefined) return arg;
  if (Array.isArray(arg)) return arg.map((a) => resolveArg(a, vars));
  if (typeof arg === 'object') {
    const o = arg as Record<string, unknown>;
    if (typeof o.from === 'string' && Object.keys(o).every((k) => k === 'from' || k === 'field')) {
      const base = vars[o.from];
      return o.field === undefined ? base : projectField(base, String(o.field));
    }
    if ('expr' in o) return evalExpr(o.expr as Expr, vars);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = resolveArg(v, vars);
    return out;
  }
  return arg;
}

/** Project a field of an element: cell coords via x|y|z (or 0..2), record fields by name. */
export function projectField(base: unknown, field: string): unknown {
  if (base === null || base === undefined) return undefined;
  if (Array.isArray(base) && base.length === 3) {
    const i = field === 'x' ? 0 : field === 'y' ? 1 : field === 'z' ? 2 : Number(field);
    return Number.isInteger(i) && i >= 0 && i < 3 ? base[i] : undefined;
  }
  if (typeof base === 'object') return (base as Record<string, unknown>)[field];
  return undefined;
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
