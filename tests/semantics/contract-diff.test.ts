import { describe, expect, it } from 'vitest';
import { diffSignatures, type Signature } from '@mc-agent/execution';

const sig = (over: Partial<Signature> = {}): Signature => ({
  blocks: new Map(),
  inventory: {},
  hp: 20,
  food: 20,
  ...over,
});

describe('causal-neighbourhood signature diff (pure)', () => {
  it('detects added/removed/changed blocks, inventory and vitals', () => {
    const before = sig({
      blocks: new Map([
        ['0,0,0', 'minecraft:stone'],
        ['2,0,0', 'minecraft:oak_log'],
      ]),
      inventory: { 'minecraft:oak_log': 4 },
      hp: 20,
    });
    const after = sig({
      blocks: new Map([
        ['1,0,0', 'minecraft:dirt'],
        ['2,0,0', 'minecraft:stone'],
      ]),
      inventory: { 'minecraft:oak_log': 5 },
      hp: 18,
    });
    const d = diffSignatures(before, after);
    expect(d.changed).toBe(true);
    expect(d.blocksRemoved).toEqual(['0,0,0']);
    expect(d.blocksAdded).toEqual(['1,0,0']);
    expect(d.blocksChanged).toEqual(['2,0,0']);
    expect(d.inventoryDelta).toEqual({ 'minecraft:oak_log': 1 });
    expect(d.hpDelta).toBe(-2);
  });

  it('reports no change for identical signatures', () => {
    const a = sig({ blocks: new Map([['0,0,0', 'minecraft:stone']]) });
    const b = sig({ blocks: new Map([['0,0,0', 'minecraft:stone']]) });
    expect(diffSignatures(a, b).changed).toBe(false);
  });
});
