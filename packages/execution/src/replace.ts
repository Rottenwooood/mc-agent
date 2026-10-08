// Core primitive: replace the block at a cell with B (B may be air). Two states only —
// a target block, or "don't care" (no call). Verdict comes from authoritative world
// evidence, not from the control receipt (framework §6).

import type { ActionResult, ControlPort, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { distance, type World } from '@mc-agent/world';
import { mk, pass, fail } from './result.js';
import type { ControlToken } from './token.js';

export interface ReplaceSpec {
  pos: Vec3;
  /** Target block id; 'minecraft:air' means clear. */
  block: string;
}

export async function replace(world: World, ctrl: ControlPort, token: ControlToken, spec: ReplaceSpec): Promise<ActionResult> {
  return token.run(async () => {
    const cur = await world.blockAt(spec.pos);
    if (isUnknown(cur)) {
      return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', controlStatus: 'needs_replan' });
    }
    if (cur.value === spec.block) {
      return pass({ evidence: [{ claim: 'already_at_target', source: 'authoritative' }], attribution: 'self_temporal' });
    }

    const self = await world.selfPos();
    if (self && distance(self, spec.pos) > 4) {
      const g = await ctrl.goto(spec.pos, { range: 2 });
      if (!g.accepted) {
        return mk({ effectStatus: 'unobservable', controlStatus: 'blocked', reason: 'precondition_failed', evidence: [{ claim: 'approach_failed', source: 'observed', value: g.note }] });
      }
    }

    if (spec.block === 'minecraft:air') {
      const d = await ctrl.dig(spec.pos);
      if (!d.accepted) {
        return fail('effect_not_observed', { controlStatus: 'needs_replan', evidence: [{ claim: 'dig_rejected', source: 'observed', value: d.note }] });
      }
    } else {
      // Place against the block below (face = up).
      const p = await ctrl.place(spec.pos, [0, 1, 0], spec.block);
      if (!p.accepted) {
        return fail('effect_not_observed', { controlStatus: 'needs_replan', evidence: [{ claim: 'place_rejected', source: 'observed', value: p.note }] });
      }
    }

    const after = await world.blockAt(spec.pos);
    if (isUnknown(after)) {
      return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence', controlStatus: 'needs_replan' });
    }
    if (after.value === spec.block) {
      return pass({
        effects: [{ subject: `block@${spec.pos.join(',')}`, predicate: 'is', before: cur.value, after: after.value }],
        evidence: [{ claim: 'block_at_target', source: 'authoritative', value: after.value }],
        attribution: 'self_temporal',
      });
    }
    return fail('effect_not_observed', {
      effects: [{ subject: `block@${spec.pos.join(',')}`, predicate: 'is', before: cur.value, after: after.value, ok: false }],
      evidence: [{ claim: 'block_at_target', source: 'authoritative', value: after.value }],
    });
  });
}
