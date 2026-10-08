import { describe, expect, it } from 'vitest';
import { evalExpr, resolveArg } from '@mc-agent/tasks';

describe('bounded vocabulary args (pure)', () => {
  it('resolves references deeply inside argument objects', () => {
    const vars = { cell: [1, 2, 3], item: 'minecraft:oak_planks' };
    expect(resolveArg({ from: 'cell' }, vars)).toEqual([1, 2, 3]);
    expect(resolveArg({ target: { kind: 'cell', pos: { from: 'cell' } } }, vars)).toEqual({
      target: { kind: 'cell', pos: [1, 2, 3] },
    });
    expect(resolveArg({ block: { from: 'item' }, navigate: false }, vars)).toEqual({
      block: 'minecraft:oak_planks',
      navigate: false,
    });
  });

  it('evaluates bounded arithmetic only', () => {
    expect(evalExpr({ op: '+', args: [2, 3] }, {})).toBe(5);
    expect(evalExpr({ op: '*', args: [2, 3, 4] }, {})).toBe(24);
    expect(evalExpr({ op: 'max', args: [1, 9, 3] }, {})).toBe(9);
    expect(evalExpr(7, {})).toBe(7);
  });
});
