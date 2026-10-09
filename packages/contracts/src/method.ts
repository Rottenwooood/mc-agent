// Methods: the bounded composition vocabulary + provenance (framework §4.5, §7).
// A Method is the executable definition only; lifecycle (status/stats/validation) lives on the
// secondary-action version that owns it (see secondary-action.ts).

import type { JsonSchema } from './contract.js';
import type { Box, Vec3 } from './fact.js';
import type { Predicate } from './predicate.js';

/** Reference to a value produced earlier (e.g. a step result). */
export interface Ref {
  from: string;
}

export type Expr = number | string | boolean | { op: string; args: Expr[] };
export type Arg = unknown | Ref | { expr: Expr };

export type Filter =
  | string
  | { tag?: string; block?: string; anyOf?: readonly string[] };

export type SetExpr =
  | { op: 'set_difference'; a: SetExpr; b: SetExpr }
  | { op: 'component'; seed: Arg; match: Filter; neighbor?: unknown; bounded?: Box }
  | { op: 'region'; box: Arg; filter?: Filter }
  /** Every integer cell of a box (the "desired" side of a build, including air targets). */
  | { op: 'box_cells'; box: Arg }
  /** All cells of an object handle. */
  | { op: 'members'; handle: Arg }
  /** The air/water-exposed cells of an object handle. */
  | { op: 'surface'; handle: Arg }
  /** Cells of the nearest visible object matching a filter. */
  | { op: 'nearest'; match: Filter }
  /** A box relative to a visible anchor (handle or 'self'), the primary way to build. */
  | { op: 'area'; anchor: Arg; size: [number, number, number]; offset?: [number, number, number] };

export interface ActionStep {
  action: string;
  args?: Record<string, Arg>;
  save?: string;
  id?: string;
  optional?: boolean;
}

export type ControlStep =
  | { op: 'sequence'; steps: Step[] }
  | { op: 'for_each'; set: SetExpr; as: string; body: Step[] }
  | { op: 'repeat'; body: Step[]; until?: Predicate; count?: Expr; budget?: Expr }
  | { op: 'branch'; if: Predicate; then: Step[]; else?: Step[] };

export type Step = ActionStep | ControlStep;

export interface FailurePolicy {
  retry: 'safe_only';
  repair: 'local_step';
  onFail: 'hand_back';
}

export interface Provenance {
  source: 'human' | 'llm' | 'adaptation';
  created: string;
  note?: string;
}

export interface Method {
  id: string;
  version: number;
  name?: string;
  description?: string;
  params: Record<string, JsonSchema>;
  preconditions: Predicate[];
  postconditions: Predicate[];
  invariants: Predicate[];
  steps: Step[];
  failurePolicy: FailurePolicy;
  provenance: Provenance;
}

/** A resolved world coordinate (used internally; not exposed to the model as an action arg). */
export interface Cell {
  pos: Vec3;
}
