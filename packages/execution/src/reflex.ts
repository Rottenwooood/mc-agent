// L1 Reflex / Shield (framework §6, research 04): the only layer allowed to intercept.
// It assesses threats from authoritative self state + entity facts and (a) denies an action
// before it starts, or (b) interrupts it at poll granularity while running.

import type { EntityFact, SelfState, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { distance, type World } from '@mc-agent/world';

export interface ReflexConfig {
  /** Hostile closer than this (blocks) is a threat. */
  hostileRadius: number;
  /** Projectile closer than this (blocks) is a threat. */
  projectileRadius: number;
  /** Health at or below this is critical. */
  criticalHealth: number;
  /** Monitoring period while an action runs. */
  pollMs: number;
}

export const DEFAULT_REFLEX: ReflexConfig = {
  hostileRadius: 6,
  projectileRadius: 8,
  criticalHealth: 6,
  pollMs: 500,
};

export interface Threat {
  danger: boolean;
  reasons: string[];
  nearestHostile: number | null;
  nearestProjectile: number | null;
}

function nearestOf(entities: readonly EntityFact[], from: Vec3): number | null {
  let best: number | null = null;
  for (const e of entities) {
    const d = distance(from, e.pos);
    if (best === null || d < best) best = d;
  }
  return best;
}

export function assessThreat(entities: readonly EntityFact[], self: SelfState, cfg: ReflexConfig): Threat {
  const nearestHostile = nearestOf(entities.filter((e) => e.hostile === true), self.pos);
  const nearestProjectile = nearestOf(entities.filter((e) => e.projectile === true), self.pos);
  const reasons: string[] = [];
  if (self.health <= cfg.criticalHealth) reasons.push('critical_health');
  if (nearestHostile !== null && nearestHostile <= cfg.hostileRadius) reasons.push('hostile_nearby');
  if (nearestProjectile !== null && nearestProjectile <= cfg.projectileRadius) reasons.push('projectile_nearby');
  return { danger: reasons.length > 0, reasons, nearestHostile, nearestProjectile };
}

export interface PrecheckResult {
  allow: boolean;
  reason?: string;
  threat?: Threat | null;
}

export class ReflexShield {
  constructor(
    private readonly world: World,
    private readonly cfg: ReflexConfig = DEFAULT_REFLEX,
  ) {}

  private async assess(): Promise<Threat | null> {
    const self = await this.world.status();
    if (isUnknown(self)) return null;
    const radius = Math.max(this.cfg.hostileRadius, this.cfg.projectileRadius) + 24;
    const ents = await this.world.entities(radius);
    if (isUnknown(ents)) return null;
    return assessThreat(ents.value, self.value, this.cfg);
  }

  /** Intercept before an action starts. Reads are always allowed; defensive actions may engage. */
  async precheck(opts: { effectClass: string; defensive: boolean }): Promise<PrecheckResult> {
    if (opts.effectClass === 'read') return { allow: true, threat: null };
    const threat = await this.assess();
    if (!threat) return { allow: true, threat: null };
    if (opts.defensive) {
      return threat.reasons.includes('critical_health')
        ? { allow: false, reason: 'critical_health', threat }
        : { allow: true, threat };
    }
    const blocker = threat.reasons.find((r) => r === 'critical_health' || r === 'projectile_nearby' || r === 'hostile_nearby');
    return blocker ? { allow: false, reason: blocker, threat } : { allow: true, threat };
  }

  /** Poll while an action runs; call `onViolation` on any broken safety invariant. */
  monitor(opts: { defensive: boolean }, onViolation: (reason: string, threat: Threat) => void): { stop(): void } {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return; // never overlap world polls; they compete with the action's own reads
      busy = true;
      void (async () => {
        try {
          const threat = await this.assess();
          if (!threat) return;
          const violation = threat.reasons.find((r) => {
            if (r === 'critical_health') return true;
            if (opts.defensive) return false;
            return r === 'projectile_nearby' || r === 'hostile_nearby';
          });
          if (violation) onViolation(violation, threat);
        } catch {
          /* monitoring must never throw */
        } finally {
          busy = false;
        }
      })();
    }, this.cfg.pollMs);
    return { stop: () => clearInterval(timer) };
  }
}
