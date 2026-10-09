// Secondary actions (二级动作): agent-created, versioned, CALLABLE compositions over the
// bounded vocabulary. The system enforces the lifecycle (draft→active→superseded/broken/retired);
// the agent only proposes transitions. Online only — no offline train/val split.

import type { JsonSchema } from './contract.js';
import type { Method, Step } from './method.js';
import type { Predicate } from './predicate.js';

export const SECONDARY_ACTION_STATUSES = ['draft', 'active', 'superseded', 'broken', 'retired'] as const;
export type SecondaryActionStatus = (typeof SECONDARY_ACTION_STATUSES)[number];

export const ATTEMPT_OUTCOMES = ['pass', 'fail', 'unknown'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** One recorded execution of a secondary action (feeds the activation gate). */
export interface SecondaryActionAttempt {
  outcome: AttemptOutcome;
  at?: string;
  /** Interventional net-effect: did it repair a broken state, or regress it? */
  repair?: boolean;
  regression?: boolean;
}

export interface SecondaryActionStats {
  uses: number;
  pass: number;
  fail: number;
  unknown: number;
  /** Sliding window of the most recent outcomes (bounded, oldest first). */
  recent: AttemptOutcome[];
  repairs: number;
  regressions: number;
  lastUsedAt: string | null;
}

export interface SecondaryActionVersion {
  version: number;
  /** The executable composition (bounded vocabulary) + contract. */
  method: Method;
  status: SecondaryActionStatus;
  stats: SecondaryActionStats;
}

export interface SecondaryActionHistoryEntry {
  at: string;
  action: 'define' | 'activate' | 'rollback' | 'retire';
  version: number;
  reason?: string;
}

/** A system-set flag: the active version should be rolled back (regression / failure streak). */
export interface RollbackRequired {
  version: number;
  reason: string;
  at: string;
}

export interface SecondaryActionRecord {
  name: string;
  description: string;
  activeVersion: number | null;
  versions: SecondaryActionVersion[];
  history: SecondaryActionHistoryEntry[];
  rollbackRequired?: RollbackRequired;
}

/** Online activation thresholds (evidence from real use only). */
export interface ActivationThresholds {
  minUses: number;
  minPassRate: number;
  recentWindow: number;
  minRecentPassRate: number;
}

export interface ActivationDecision {
  activate: boolean;
  version: number;
  reason: string;
  stats: SecondaryActionStats;
}

export interface SecondaryActionDefinitionInput {
  name: string;
  description?: string;
  params?: Record<string, JsonSchema>;
  preconditions?: Predicate[];
  postconditions?: Predicate[];
  invariants?: Predicate[];
  steps: Step[];
}
