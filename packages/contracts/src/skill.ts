// Skill library contracts (framework §7, research 07 §3, research 10 §4).
// A skill is a named, versioned, validated Method; the library is the single source of truth.
// The promotion gate enforces train/val/test seed isolation: test seeds never influence admission.

import type { JsonSchema } from './contract.js';
import type { Method, MethodStatus, Step } from './method.js';
import type { Predicate } from './predicate.js';

/** Hard seed roles. `test` is report-only and must never drive selection. */
export const SEED_ROLES = ['train', 'val', 'test'] as const;
export type SeedRole = (typeof SEED_ROLES)[number];

export const ATTEMPT_OUTCOMES = ['pass', 'fail', 'unknown'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Where a skill run happened and how it turned out (feeds the gate). */
export interface SkillAttempt {
  seed: string;
  role: SeedRole;
  outcome: AttemptOutcome;
  at?: string;
  /** Interventional net-effect: did running the skill repair a broken state, or regress it? */
  repair?: boolean;
  regression?: boolean;
}

export interface RoleStats {
  attempts: number;
  pass: number;
  fail: number;
  unknown: number;
}

export interface SkillVersionStats {
  attempts: number;
  pass: number;
  fail: number;
  unknown: number;
  byRole: Record<SeedRole, RoleStats>;
  /** Latest outcome per `${role}:${seed}` (used for the distinct-seed gate). */
  seedOutcome: Record<string, AttemptOutcome>;
  repairs: number;
  regressions: number;
  lastAt: string | null;
}

export interface SkillValidation {
  trainSeeds: string[];
  valSeeds: string[];
  passed: boolean;
  at: string;
}

export interface SkillVersion {
  version: number;
  /** The executable method (steps + preconditions + postconditions + invariants). */
  method: Method;
  stats: SkillVersionStats;
  validation: SkillValidation | null;
}

export interface SkillHistoryEntry {
  at: string;
  action: 'define' | 'admit' | 'rollback' | 'retire';
  version: number;
  reason?: string;
}

export interface SkillRecord {
  name: string;
  description: string;
  activeVersion: number | null;
  versions: SkillVersion[];
  history: SkillHistoryEntry[];
}

/** Admission thresholds (over distinct seeds, not attempts). */
export interface PromotionThresholds {
  minValSeeds: number;
  minTrainPassRate: number;
  minValPassRate: number;
}

export interface PromotionDecision {
  admit: boolean;
  version: number;
  reason: string;
  train: RoleStats;
  val: RoleStats;
}

/** The agent's declared skill (bounded vocabulary only; no arbitrary code). */
export interface SkillDefinitionInput {
  name: string;
  description?: string;
  params?: Record<string, JsonSchema>;
  preconditions?: Predicate[];
  postconditions?: Predicate[];
  invariants?: Predicate[];
  steps: Step[];
}

export type { MethodStatus };
