import { describe, expect, it } from 'vitest';
import { assessThreat, DEFAULT_REFLEX } from '@mc-agent/execution';
import type { EntityFact, SelfState, Vec3 } from '@mc-agent/contracts';

const self = (health = 20): SelfState => ({
  pos: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  health,
  food: 20,
  dimension: 'minecraft:overworld',
  onGround: true,
});

const ent = (id: string, pos: Vec3, flags: Partial<Pick<EntityFact, 'hostile' | 'projectile'>> = {}): EntityFact => ({
  id,
  type: 'minecraft:test',
  pos,
  ...flags,
});

describe('reflex threat assessment (pure)', () => {
  it('is clear with no threats', () => {
    expect(assessThreat([], self(), DEFAULT_REFLEX).danger).toBe(false);
  });

  it('flags a nearby hostile and ignores a distant one', () => {
    expect(assessThreat([ent('1', [3, 0, 0], { hostile: true })], self(), DEFAULT_REFLEX).reasons).toContain('hostile_nearby');
    expect(assessThreat([ent('2', [30, 0, 0], { hostile: true })], self(), DEFAULT_REFLEX).danger).toBe(false);
  });

  it('flags a nearby projectile', () => {
    expect(assessThreat([ent('p', [5, 0, 0], { projectile: true })], self(), DEFAULT_REFLEX).reasons).toContain('projectile_nearby');
  });

  it('flags critical health regardless of entities', () => {
    expect(assessThreat([], self(4), DEFAULT_REFLEX).reasons).toContain('critical_health');
  });
});
