import { describe, expect, it } from 'vitest';
import { actionRegistry } from '@mc-agent/execution';
import type { Signature } from '@mc-agent/execution';

const setBlock = actionRegistry().get('set_block')!;

const sig = (blocks: [string, string][]): Signature => ({
  blocks: new Map(blocks),
  inventory: {},
  hp: 20,
  food: 20,
  pos: null,
});

const win = (anchor: [number, number, number] | undefined, before: Signature, after: Signature) =>
  ({ before, after, diff: {}, ...(anchor ? { anchor } : {}) }) as never;

describe('set_block.verify judges the action-time cell (regression)', () => {
  it('passes when the anchored cell changed to the wanted value', async () => {
    const v = await setBlock.verify!({} as never, { block: 'minecraft:air' }, win([1, 2, 3], sig([['1,2,3', 'minecraft:stone']]), sig([['1,2,3', 'minecraft:air']])));
    expect(v?.ok).toBe('pass');
  });

  it('returns no_op when the anchored cell was already the wanted value', async () => {
    const v = await setBlock.verify!({} as never, { block: 'minecraft:air' }, win([1, 2, 3], sig([['1,2,3', 'minecraft:air']]), sig([['1,2,3', 'minecraft:air']])));
    expect(v?.ok).toBe('no_op');
  });

  it('returns unobservable (never pass) when there is no anchor — no degraded self-anchor', async () => {
    const v = await setBlock.verify!({} as never, { block: 'minecraft:air' }, win(undefined, sig([]), sig([])));
    expect(v?.ok).toBe('unobservable');
  });

  it('fails when the anchored cell did not become the wanted value', async () => {
    const v = await setBlock.verify!({} as never, { block: 'minecraft:air' }, win([1, 2, 3], sig([['1,2,3', 'minecraft:stone']]), sig([['1,2,3', 'minecraft:stone']])));
    expect(v?.ok).toBe('fail');
  });
});
