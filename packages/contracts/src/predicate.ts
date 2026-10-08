// Predicates and three-valued (Kleene) logic (framework §4.2, research 13 §1).
// unknown propagates as `undefined` and must never be coerced to false.

import type { Box } from './fact.js';

/** true | false | undefined (unknown). */
export type Tri = true | false | undefined;

export function and(xs: readonly Tri[]): Tri {
  if (xs.some((x) => x === false)) return false;
  return xs.every((x) => x === true) ? true : undefined;
}

export function or(xs: readonly Tri[]): Tri {
  if (xs.some((x) => x === true)) return true;
  return xs.every((x) => x === false) ? false : undefined;
}

export function not(x: Tri): Tri {
  return x === undefined ? undefined : !x;
}

/** Map a three-valued result onto an effect status (all-true→pass, false→fail, unknown→unobservable). */
export function triToEffect(x: Tri): 'pass' | 'fail' | 'unobservable' {
  if (x === true) return 'pass';
  if (x === false) return 'fail';
  return 'unobservable';
}

export interface Scope {
  kind: 'voxel' | 'box' | 'radius' | 'egocentric';
  radius?: number;
  box?: Box;
}

/**
 * A declared predicate over the world. `subject` uses the addressing grammar
 * (block@x,y,z / inv:<item> / self.hp / entity#<id> / region:<box> ...).
 */
export interface Predicate {
  subject: string;
  predicate: string;
  value?: unknown;
  scope?: Scope;
  notBeforeTick?: number;
  minConfidence?: number;
  attribution?: 'self' | 'any';
}

/** Result of evaluating a single predicate. `ok === undefined` means unknown. */
export interface PredicateResult {
  subject: string;
  predicate: string;
  expected?: unknown;
  actual?: unknown;
  ok: Tri;
  error?: string;
}
