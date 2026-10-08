import { describe, expect, it } from 'vitest';
import { distance, nearestCell } from '@mc-agent/world';

describe('world geometry (pure)', () => {
  it('distance is euclidean', () => {
    expect(distance([0, 0, 0], [3, 4, 0])).toBe(5);
  });

  it('nearestCell picks the closest and returns null when empty', () => {
    const cells = [
      { pos: [10, 0, 0] as [number, number, number], block: 'a' },
      { pos: [2, 0, 0] as [number, number, number], block: 'b' },
      { pos: [5, 0, 0] as [number, number, number], block: 'c' },
    ];
    const best = nearestCell(cells, [0, 0, 0]);
    expect(best?.block).toBe('b');
    expect(best?.distance).toBe(2);
    expect(nearestCell([], [0, 0, 0])).toBeNull();
  });
});
