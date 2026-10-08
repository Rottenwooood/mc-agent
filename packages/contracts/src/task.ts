// Task specification + capability grading (framework §4.6).

import type { Predicate, Scope } from './predicate.js';

export interface Budget {
  wallMs?: number;
  toolCalls?: number;
  blocks?: number;
  items?: Record<string, number>;
}

export interface TaskSpec {
  goal: Predicate[];
  scope: Scope;
  budget: Budget;
  stopConditions: Predicate[];
}

/**
 * Capability grading (research 07 §2 / 11 §6.3). Every capability reports what it is
 * visible/permitted for, so "is the privileged oracle necessary" can be ablated.
 */
export interface CapabilityGrading {
  planningVisible: boolean;
  verificationVisible: boolean;
  actionPermission: string;
}
