import { describe, expect, it } from 'vitest';
import type { ActionContext } from '@mc-agent/execution';
import { ControlToken, actionRegistry } from '@mc-agent/execution';

const smelt = actionRegistry().get('smelt')!;
const enchant = actionRegistry().get('enchant')!;

interface Stack {
  slot: number;
  item: string;
  count: number;
}

/** A ctx whose inventory is `inv0` before the call and `after` during it. */
function ctxWith(inv0: Stack[], after: Stack[], receipt: { accepted: boolean; note?: string } = { accepted: true }, raw?: unknown): ActionContext {
  let cur = inv0;
  const make =
    (fn: () => void) =>
    async (): Promise<{ accepted: boolean; level: 'observed'; note?: string; raw?: unknown }> => {
      fn();
      return { level: 'observed', ...receipt, ...(raw !== undefined ? { raw } : {}) };
    };
  return {
    token: new ControlToken(),
    ctrl: { smelt: make(() => (cur = after)), enchant: make(() => undefined) },
    world: { inventory: async () => ({ value: cur }) },
  } as unknown as ActionContext;
}

describe('smelt verifies the OUTPUT, not the input (the old contract could never pass)', () => {
  it('passes when the smelted output appears (input consumed)', async () => {
    const r = await smelt.run(ctxWith([{ slot: 0, item: 'minecraft:raw_iron', count: 3 }], [{ slot: 0, item: 'minecraft:iron_ingot', count: 3 }]), {
      item: 'minecraft:raw_iron',
      count: 3,
    });
    expect(r.effectStatus).toBe('pass');
    expect((r.data as { produced: Record<string, number> }).produced).toEqual({ 'minecraft:iron_ingot': 3 });
  });

  it('fails when the input vanished but no output appeared', async () => {
    const r = await smelt.run(ctxWith([{ slot: 0, item: 'minecraft:raw_iron', count: 3 }], []), { item: 'minecraft:raw_iron', count: 3 });
    expect(r.effectStatus).toBe('fail');
  });
});

describe('enchant is control-only (no fabricated effect)', () => {
  it('is declared controlOnly and passes on an accepted receipt, returning the observed result', async () => {
    expect(enchant.contract.controlOnly).toBe(true);
    const raw = { item: 'minecraft:diamond_sword', enchants: ['sharpness 3'] };
    const r = await enchant.run(ctxWith([], [], { accepted: true }, raw), { item: 'minecraft:diamond_sword' });
    expect(r.effectStatus).toBe('pass');
    expect((r.data as { enchants: string[] }).enchants).toEqual(['sharpness 3']);
  });
});
