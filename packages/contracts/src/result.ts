// Frozen ActionResult (framework §4.3, research 13 §3).
// effectStatus (evidence/effect) and controlStatus (execution control) are independent axes.

import type { EvidenceLevel, Source } from './fact.js';

export const EFFECT_STATUSES = ['pass', 'fail', 'ambiguous', 'unobservable', 'no_op'] as const;
export type EffectStatus = (typeof EFFECT_STATUSES)[number];
// `pass`  — the intended effect is present in the authoritative evidence (the world changed).
// `no_op` — the postcondition already held and NOTHING changed (e.g. set_block to air on a cell
//           that was already air, or a target that was never the expected block). NOT a success.
// `fail`  — the intended effect is absent; `ambiguous`/`unobservable` — cannot judge.

export const CONTROL_STATUSES = [
  'completed',
  'blocked',
  'interrupted',
  'needs_replan',
  'cancelled',
  'uncertain',
] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];

export const REASONS = [
  'precondition_failed',
  'effect_not_observed',
  'insufficient_evidence',
  'attribution_uncertain',
  'timeout',
  'policy_blocked',
  'irrelevant',
] as const;
export type Reason = (typeof REASONS)[number];

export const ATTRIBUTIONS = [
  'self_confirmed',
  'self_temporal',
  'foreign',
  'unattributed',
  'unknown',
] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

export interface EffectDiff {
  subject: string;
  predicate: string;
  before?: unknown;
  after?: unknown;
  ok?: boolean;
}

export interface NeighborhoodDiff {
  changed: boolean;
  blocksAdded?: string[];
  blocksRemoved?: string[];
  blocksChanged?: string[];
  inventoryDelta?: Record<string, number>;
}

export interface ResourceDelta {
  inventoryDelta?: Record<string, number>;
  hpDelta?: number;
  foodDelta?: number;
  xpDelta?: number;
}

export interface Timing {
  startedTick?: number;
  endedTick?: number;
  elapsedMs: number;
}

export interface Evidence {
  claim: string;
  source: Source;
  level?: EvidenceLevel;
  tick?: number;
  before?: unknown;
  after?: unknown;
  value?: unknown;
}

export interface ActionResult {
  effectStatus: EffectStatus;
  controlStatus: ControlStatus;
  reason: Reason | null;
  reasonDetail?: string;
  effects: EffectDiff[];
  evidence: Evidence[];
  /** First version: at most `self_temporal` (research 14 §3). */
  attribution: Attribution;
  diff?: NeighborhoodDiff | null;
  resources?: ResourceDelta | null;
  timing?: Timing | null;
  control: 'returned';
  /** Time-ordered world changes caused since the previous tool call (no silent side effects). */
  changes?: string[];
  /**
   * True for a control-only action (look_at/wait/steer/follow/flee/chat/open/close_container):
   * it affects the body/interface but claims NO world effect. A `pass` here is a CONTROL pass,
   * never an effect pass — consumers must not treat it as evidence of a world change.
   */
  controlOnly?: boolean;
  subResults?: ActionResult[];
  /** Tool-specific payload (e.g. perception data). Not part of the judgement. */
  data?: unknown;
}
