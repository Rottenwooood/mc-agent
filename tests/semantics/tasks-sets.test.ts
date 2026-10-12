import { describe, expect, it } from 'vitest';
import { ControlToken, contract, mk } from '@mc-agent/execution';
import type { ActionContext, AtomicAction } from '@mc-agent/execution';
import { projectField, resolveArg, runMethod } from '@mc-agent/tasks';

function ctxWithInventory(inv: { slot: number; item: string; count: number }[]): ActionContext {
  return {
    world: {
      inventory: async () => ({ value: inv }),
      selfPos: async () => [0, 0, 0],
      entities: async () => ({ value: [] }),
      events: async () => ({ cursor: { epoch: 0, seq: 0 }, hasMore: false, events: [] }),
    },
    ctrl: { stopMotion: async () => undefined },
    token: new ControlToken(),
  } as unknown as ActionContext;
}

describe('field projection (pure)', () => {
  it('projects cell coords by x|y|z or index', () => {
    expect(projectField([10, 64, -3], 'x')).toBe(10);
    expect(projectField([10, 64, -3], 'y')).toBe(64);
    expect(projectField([10, 64, -3], 'z')).toBe(-3);
    expect(projectField([10, 64, -3], '1')).toBe(64);
  });

  it('projects record fields, and {from,field} through resolveArg', () => {
    expect(projectField({ item: 'minecraft:coal', count: 4 }, 'count')).toBe(4);
    const vars = { s: { item: 'minecraft:coal', count: 4 } };
    expect(resolveArg({ from: 's', field: 'item' }, vars)).toBe('minecraft:coal');
    expect(resolveArg({ from: 's' }, vars)).toEqual({ item: 'minecraft:coal', count: 4 });
  });
});

describe('inventory domain + element projection in a run', () => {
  it('drives an atom per inventory slot with {from,field}', async () => {
    const seen: { item: unknown; count: unknown }[] = [];
    const sink: AtomicAction = {
      contract: contract({ name: 'sink', description: 'sink', params: { type: 'object' }, effectClass: 'read' }),
      run: async (_c, args) => {
        seen.push({ item: args.item, count: args.count });
        return mk({ effectStatus: 'pass' });
      },
    };
    const ctx = ctxWithInventory([
      { slot: 0, item: 'minecraft:coal', count: 4 },
      { slot: 1, item: 'minecraft:cobblestone', count: 12 },
    ]);
    const r = await runMethod(ctx, new Map([['sink', sink]]), {
      steps: [
        {
          op: 'for_each',
          set: { op: 'inventory' },
          as: 's',
          body: [{ action: 'sink', args: { item: { from: 's', field: 'item' }, count: { from: 's', field: 'count' } } }],
        },
      ],
    });
    expect(seen).toEqual([
      { item: 'minecraft:coal', count: 4 },
      { item: 'minecraft:cobblestone', count: 12 },
    ]);
    // The run itself changed nothing -> no_op (pass ⇒ changed).
    expect(r.effectStatus).toBe('no_op');
  });
});
