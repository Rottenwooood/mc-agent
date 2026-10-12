import { describe, expect, it } from 'vitest';
import type { ActionContext } from '@mc-agent/execution';
import { ControlToken, actionRegistry } from '@mc-agent/execution';

const craft = actionRegistry().get('craft')!;

/** A ctx whose inventory flips from `before` to `after` when craft runs. */
function ctxWith(before: number, after: number, accepted = true): ActionContext {
  let n = before;
  return {
    token: new ControlToken(),
    ctrl: { craft: async () => { n = after; return { accepted, level: 'observed', note: `crafted ${after}` }; } },
    world: { inventory: async () => ({ value: [{ slot: 0, item: 'minecraft:stick', count: n }] }) },
  } as unknown as ActionContext;
}

describe('craft semantics (partial craft is never a pass)', () => {
  it('passes when the full amount landed', async () => {
    const r = await craft.run(ctxWith(0, 4), { item: 'minecraft:stick', count: 4 });
    expect(r.effectStatus).toBe('pass');
  });

  it('is ambiguous when only part of the requested amount landed (inputs eaten)', async () => {
    const r = await craft.run(ctxWith(0, 8), { item: 'minecraft:stick', count: 12 });
    expect(r.effectStatus).toBe('ambiguous');
    expect(r.reason).toBe('effect_not_observed');
    expect(r.reasonDetail).toContain('crafted 8/12');
  });

  it('fails when nothing landed', async () => {
    const r = await craft.run(ctxWith(0, 0, false), { item: 'minecraft:stick', count: 4 });
    expect(r.effectStatus).toBe('fail');
  });
});
