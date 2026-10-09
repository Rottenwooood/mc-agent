import { describe, it, expect } from 'vitest';
import { SkillLibrary, DEFAULT_THRESHOLDS } from '@mc-agent/knowledge';
import type { SkillDefinitionInput } from '@mc-agent/contracts';

const def = (name: string): SkillDefinitionInput => ({ name, steps: [] });

describe('SkillLibrary: versions + admission gate', () => {
  it('defines drafts and does not activate them', () => {
    const lib = new SkillLibrary();
    const v = lib.define(def('chop'));
    expect(v.version).toBe(1);
    expect(v.method.status).toBe('draft');
    expect(lib.active('chop')).toBeUndefined();
    expect(lib.summary()[0]!.status).toBe('draft');
  });

  it('admits only after train + enough distinct val seeds pass', () => {
    const lib = new SkillLibrary();
    lib.define(def('chop'));
    lib.record('chop', 1, { seed: 't1', role: 'train', outcome: 'pass' });

    // one val seed is below the minValSeeds threshold
    lib.record('chop', 1, { seed: 'v1', role: 'val', outcome: 'pass' });
    expect(lib.evaluate('chop', 1).admit).toBe(false);

    // a second distinct val seed admits
    lib.record('chop', 1, { seed: 'v2', role: 'val', outcome: 'pass' });
    const d = lib.promote('chop', 1);
    expect(d.admit).toBe(true);
    expect(lib.active('chop')?.version).toBe(1);
    expect(lib.active('chop')?.method.status).toBe('verified');
  });

  it('rejects when the val pass rate is too low', () => {
    const lib = new SkillLibrary({ thresholds: { minValSeeds: 2, minValPassRate: 0.9, minTrainPassRate: 0.5 } });
    lib.define(def('chop'));
    lib.record('chop', 1, { seed: 't1', role: 'train', outcome: 'pass' });
    lib.record('chop', 1, { seed: 'v1', role: 'val', outcome: 'pass' });
    lib.record('chop', 1, { seed: 'v2', role: 'val', outcome: 'fail' });
    expect(lib.evaluate('chop', 1).admit).toBe(false);
  });

  it('enforces seed isolation: test outcomes never influence admission', () => {
    const lib = new SkillLibrary();
    lib.define(def('chop'));
    lib.record('chop', 1, { seed: 't1', role: 'train', outcome: 'pass' });
    // plenty of passing TEST seeds must NOT be able to satisfy the val requirement
    lib.record('chop', 1, { seed: 'x1', role: 'test', outcome: 'pass' });
    lib.record('chop', 1, { seed: 'x2', role: 'test', outcome: 'pass' });
    lib.record('chop', 1, { seed: 'x3', role: 'test', outcome: 'pass' });
    expect(lib.evaluate('chop', 1).admit).toBe(false);
    expect(lib.evaluate('chop', 1).val.attempts).toBe(0);
  });

  it('counts interventional net-effect (repairs vs regressions)', () => {
    const lib = new SkillLibrary();
    lib.define(def('repair'));
    lib.record('repair', 1, { seed: 'v1', role: 'val', outcome: 'pass', repair: true });
    lib.record('repair', 1, { seed: 'v2', role: 'val', outcome: 'fail', regression: true });
    const s = lib.version('repair', 1)!.stats;
    expect(s.repairs).toBe(1);
    expect(s.regressions).toBe(1);
  });
});

describe('SkillLibrary: rollback + persistence', () => {
  it('rolls back to the previous verified version and marks the bad one broken', () => {
    const lib = new SkillLibrary();
    lib.define(def('build'));
    lib.record('build', 1, { seed: 't1', role: 'train', outcome: 'pass' });
    lib.record('build', 1, { seed: 'v1', role: 'val', outcome: 'pass' });
    lib.record('build', 1, { seed: 'v2', role: 'val', outcome: 'pass' });
    lib.promote('build', 1);

    // a new version that also passes train/val
    lib.define(def('build'));
    lib.record('build', 2, { seed: 't1', role: 'train', outcome: 'pass' });
    lib.record('build', 2, { seed: 'v1', role: 'val', outcome: 'pass' });
    lib.record('build', 2, { seed: 'v2', role: 'val', outcome: 'pass' });
    lib.promote('build', 2);
    expect(lib.active('build')?.version).toBe(2);

    lib.rollback('build', 'held-out replay failed');
    expect(lib.active('build')?.version).toBe(1);
    expect(lib.version('build', 2)!.method.status).toBe('broken');
    expect(lib.history('build').some((h) => h.action === 'rollback')).toBe(true);
  });

  it('round-trips through JSON', () => {
    const lib = new SkillLibrary();
    lib.define(def('mine'));
    lib.record('mine', 1, { seed: 't1', role: 'train', outcome: 'pass' });
    lib.record('mine', 1, { seed: 'v1', role: 'val', outcome: 'pass' });
    lib.record('mine', 1, { seed: 'v2', role: 'val', outcome: 'pass' });
    lib.promote('mine', 1);

    const restored = SkillLibrary.fromJSON(lib.toJSON());
    expect(restored.active('mine')?.version).toBe(1);
    expect(restored.active('mine')?.method.status).toBe('verified');
    expect(restored.version('mine', 1)!.stats.byRole.val.pass).toBe(2);
  });

  it('uses sane default thresholds', () => {
    expect(DEFAULT_THRESHOLDS.minValSeeds).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_THRESHOLDS.minValPassRate).toBeGreaterThan(0);
  });
});
