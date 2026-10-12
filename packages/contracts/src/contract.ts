// ActionContract — every L1 action declares its own judgement (framework §4.4, research 13 §2).

import type { Predicate, Scope } from './predicate.js';

export const EFFECT_CLASSES = ['read', 'idempotent', 'consumable', 'irreversible'] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

export const VERIFICATION_MODES = ['state_effect', 'observation', 'task_terminal', 'continuous'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

export const SAFE_STOPS = ['none', 'release_control', 'finish_landing', 'recall'] as const;
export type SafeStop = (typeof SAFE_STOPS)[number];

export const RETRY_POLICIES = ['no', 'safe_once'] as const;
export type RetryPolicy = (typeof RETRY_POLICIES)[number];

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  description?: string;
  default?: unknown;
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface Interruptible {
  prepare: boolean;
  execute: boolean;
  settle: boolean;
}

export interface ActionContract {
  name: string;
  params: JsonSchema;
  description: string;
  preconditions: Predicate[];
  verificationMode: VerificationMode;
  /** For `state_effect` actions this is mandatory; callers may add but not remove. */
  postconditions: Predicate[];
  invariants: Predicate[];
  effectClass: EffectClass;
  /**
   * Control-only action: affects the body/interface (look_at, wait, steer, follow, flee, chat,
   * open/close_container) but claims NO world effect. Its `pass`/`fail` judges the CONTROL, not
   * the world — the engine never runs the effect/`pass ⇒ changed` accounting for it.
   */
  controlOnly?: boolean;
  interruptible: Interruptible;
  safeStop: SafeStop;
  timeoutTicks: number;
  causalScope: Scope;
  retryPolicy: RetryPolicy;
  repairHint: string[];
}
