// ActionResult builders. Every action returns the frozen shape; effect and control status
// stay independent axes.

import type { ActionResult, EffectStatus, ControlStatus, Reason, Attribution, Evidence, EffectDiff } from '@mc-agent/contracts';

export interface ResultParts {
  effectStatus: EffectStatus;
  controlStatus?: ControlStatus;
  reason?: Reason | null;
  effects?: EffectDiff[];
  evidence?: Evidence[];
  attribution?: Attribution;
  diff?: ActionResult['diff'];
  resources?: ActionResult['resources'];
  timing?: ActionResult['timing'];
  data?: unknown;
  subResults?: ActionResult[];
}

export function mk(p: ResultParts): ActionResult {
  const r: ActionResult = {
    effectStatus: p.effectStatus,
    controlStatus: p.controlStatus ?? 'completed',
    reason: p.reason ?? null,
    effects: p.effects ?? [],
    evidence: p.evidence ?? [],
    attribution: p.attribution ?? 'unknown',
    diff: p.diff ?? null,
    resources: p.resources ?? null,
    timing: p.timing ?? null,
    control: 'returned',
  };
  if (p.data !== undefined) r.data = p.data;
  if (p.subResults !== undefined) r.subResults = p.subResults;
  return r;
}

export function pass(p: Omit<ResultParts, 'effectStatus'> = {}): ActionResult {
  return mk({ effectStatus: 'pass', ...p });
}

export function fail(reason: Reason, p: Omit<ResultParts, 'effectStatus' | 'reason'> = {}): ActionResult {
  return mk({ effectStatus: 'fail', reason, ...p });
}
