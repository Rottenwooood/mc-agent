import { describe, it, expect } from 'vitest';
import { ActionLibrary, SkillLibrary, DEFAULT_THRESHOLDS } from '@mc-agent/knowledge';
import type { SecondaryActionDefinitionInput } from '@mc-agent/contracts';

const def = (name: string): SecondaryActionDefinitionInput => ({ name, steps: [] });
const pass = { outcome: 'pass' as const };
const fail = { outcome: 'fail' as const };

describe('ActionLibrary: online activation gate', () => {
  it('defines drafts and does not activate them', () => {
    const lib = new ActionLibrary();
    const v = lib.define(def('get_wood'));
    expect(v.version).toBe(1);
    expect(v.status).toBe('draft');
    expect(lib.active('get_wood')).toBeUndefined();
  });

  it('activates only after enough real uses with a good pass rate', () => {
    const lib = new ActionLibrary();
    lib.define(def('get_wood'));
    lib.record('get_wood', 1, pass);
    expect(lib.evaluate('get_wood', 1).activate).toBe(false); // uses < minUses
    lib.record('get_wood', 1, pass);
    lib.record('get_wood', 1, pass);
    const d = lib.activate('get_wood', 1);
    expect(d.activate).toBe(true);
    expect(lib.active('get_wood')?.version).toBe(1);
    expect(lib.active('get_wood')?.status).toBe('active');
  });

  it('rejects a low pass rate', () => {
    const lib = new ActionLibrary({ thresholds: { minUses: 3, minPassRate: 0.9, recentWindow: 5, minRecentPassRate: 0.5 } });
    lib.define(def('x'));
    lib.record('x', 1, pass);
    lib.record('x', 1, fail);
    lib.record('x', 1, fail);
    expect(lib.evaluate('x', 1).activate).toBe(false);
  });

  it('rejects a recent-window degradation even with a good lifetime rate', () => {
    const lib = new ActionLibrary();
    lib.define(def('y'));
    for (let i = 0; i < 5; i++) lib.record('y', 1, pass);
    // recent window now degrades
    lib.record('y', 1, fail);
    lib.record('y', 1, fail);
    lib.record('y', 1, fail);
    expect(lib.evaluate('y', 1).activate).toBe(false);
  });

  it('counts interventional net-effect and blocks net-negative versions', () => {
    const lib = new ActionLibrary();
    lib.define(def('repair'));
    lib.record('repair', 1, { ...pass, repair: true });
    lib.record('repair', 1, { ...pass });
    lib.record('repair', 1, { ...fail, regression: true });
    const s = lib.version('repair', 1)!.stats;
    expect(s.repairs).toBe(1);
    expect(s.regressions).toBe(1);
    expect(lib.evaluate('repair', 1).activate).toBe(true); // 1 regression <= 1 repair
    lib.record('repair', 1, { ...fail, regression: true });
    expect(lib.evaluate('repair', 1).activate).toBe(false); // now net-negative
  });
});

describe('ActionLibrary: rollback lifecycle', () => {
  const activate = (lib: ActionLibrary, name: string, version: number) => {
    for (let i = 0; i < 3; i++) lib.record(name, version, pass);
    lib.activate(name, version);
  };

  it('supersedes the previous active and rolls back to it', () => {
    const lib = new ActionLibrary();
    lib.define(def('build'));
    activate(lib, 'build', 1);
    lib.define(def('build'));
    activate(lib, 'build', 2);
    expect(lib.active('build')?.version).toBe(2);
    expect(lib.version('build', 1)!.status).toBe('superseded');

    lib.rollback('build', 'held-out regression');
    expect(lib.active('build')?.version).toBe(1);
    expect(lib.version('build', 2)!.status).toBe('broken');
  });

  it('marks rollbackRequired on a regression or two consecutive failures of the active version', () => {
    const lib = new ActionLibrary();
    lib.define(def('mine'));
    activate(lib, 'mine', 1);
    lib.record('mine', 1, { ...fail, regression: true });
    expect(lib.get('mine')!.rollbackRequired?.version).toBe(1);

    // cleared by rollback
    lib.rollback('mine', 'regression');
    expect(lib.get('mine')!.rollbackRequired).toBeUndefined();

    // consecutive failures also trigger it
    lib.define(def('mine'));
    activate(lib, 'mine', 2);
    lib.record('mine', 2, fail);
    lib.record('mine', 2, fail);
    expect(lib.get('mine')!.rollbackRequired?.reason).toContain('consecutive');
  });

  it('round-trips through JSON', () => {
    const lib = new ActionLibrary();
    lib.define(def('get_wood'));
    activate(lib, 'get_wood', 1);
    const restored = ActionLibrary.fromJSON(lib.toJSON());
    expect(restored.active('get_wood')?.version).toBe(1);
    expect(restored.active('get_wood')?.status).toBe('active');
  });

  it('uses sane defaults', () => {
    expect(DEFAULT_THRESHOLDS.minUses).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_THRESHOLDS.minPassRate).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.recentWindow).toBeGreaterThanOrEqual(3);
  });
});

describe('SkillLibrary: text notes (not callable)', () => {
  it('writes, retrieves and searches notes', () => {
    const lib = new SkillLibrary();
    lib.write({ name: 'mining', description: 'how to mine', tags: ['resource'], text: 'always bring a pickaxe' });
    lib.write({ name: 'safety', tags: ['danger'], text: 'never dig straight down' });
    expect(lib.get('mining')?.text).toContain('pickaxe');
    expect(lib.search('pickaxe').map((n) => n.name)).toEqual(['mining']);
    expect(lib.search('danger').map((n) => n.name)).toEqual(['safety']);
    expect(lib.list().length).toBe(2);
    expect(lib.remove('safety')).toBe(true);
    expect(lib.list().length).toBe(1);
  });

  it('round-trips through JSON', () => {
    const lib = new SkillLibrary();
    lib.write({ name: 'a', text: 'note' });
    const restored = SkillLibrary.fromJSON(lib.toJSON());
    expect(restored.get('a')?.text).toBe('note');
  });
});
