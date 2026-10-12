import { describe, expect, it } from 'vitest';
import type { ActionResult } from '@mc-agent/contracts';
import { ControlToken, contract, mk } from '@mc-agent/execution';
import type { ActionContext, AtomicAction } from '@mc-agent/execution';
import { runMethod, validateMethod, type CallSecondary } from '@mc-agent/tasks';

/** A ctx whose world observation is trivial: no events, no entities, self at the origin. */
function fakeCtx(): ActionContext {
  return {
    world: {
      selfPos: async () => [0, 0, 0],
      events: async () => ({ cursor: { epoch: 0, seq: 0 }, hasMore: false, events: [] }),
      entities: async () => ({ value: [] }),
    },
    ctrl: { stopMotion: async () => undefined },
    token: new ControlToken(),
  } as unknown as ActionContext;
}

function fake(name: string, result: ActionResult, controlOnly = false): AtomicAction {
  return {
    contract: contract({
      name,
      description: name,
      params: { type: 'object' },
      effectClass: controlOnly ? 'idempotent' : 'read',
      ...(controlOnly ? { controlOnly: true } : {}),
    }),
    run: async () => result,
  };
}

const noChange = mk({ effectStatus: 'pass', diff: { changed: false } });
const changed = mk({ effectStatus: 'pass', diff: { changed: true, blocksRemoved: ['1,2,3'] } });

describe('run_method terminal semantics', () => {
  it('downgrades a vacuous terminal pass to no_op when nothing changed', async () => {
    const actions = new Map([['nop', fake('nop', noChange)]]);
    const r = await runMethod(fakeCtx(), actions, { steps: [{ action: 'nop' }] });
    expect(r.effectStatus).toBe('no_op');
    expect(r.reason).toBeNull();
  });

  it('keeps pass when the run actually changed the world', async () => {
    const actions = new Map([['dig', fake('dig', changed)]]);
    const r = await runMethod(fakeCtx(), actions, { steps: [{ action: 'dig' }] });
    expect(r.effectStatus).toBe('pass');
  });

  it('marks a control-only action and never counts it as a world change', async () => {
    const actions = new Map([['ctrl', fake('ctrl', mk({ effectStatus: 'pass' }), true)]]);
    const r = await runMethod(fakeCtx(), actions, { steps: [{ action: 'ctrl' }] });
    expect(r.effectStatus).toBe('no_op'); // control-only pass is not an effect, so no change
    expect(r.subResults?.[0]?.controlOnly).toBe(true);
  });
});

describe('run_method hierarchy + trace', () => {
  it('returns a per-step trace (credit assignment)', async () => {
    const actions = new Map([['a', fake('a', noChange)], ['b', fake('b', changed)]]);
    const r = await runMethod(fakeCtx(), actions, { steps: [{ action: 'a' }, { action: 'b' }] });
    const trace = (r.data as { trace: { action: string; effectStatus: string }[] }).trace;
    expect(trace.map((t) => t.action)).toEqual(['a', 'b']);
    expect(trace.map((t) => t.effectStatus)).toEqual(['pass', 'pass']);
  });

  it('dispatches an unknown action step to a defined secondary action', async () => {
    const calls: { name: string; depth: number }[] = [];
    const actions = new Map([['dig', fake('dig', changed)]]);
    const r = await runMethod(
      fakeCtx(),
      actions,
      { steps: [{ action: 'tree_chop', args: { n: 3 } }] },
      { callSecondary: async (_c, _a, name, _args, depth) => { calls.push({ name, depth }); return changed; } },
    );
    expect(calls).toEqual([{ name: 'tree_chop', depth: 1 }]);
    expect(r.effectStatus).toBe('pass');
    expect((r.data as { trace: { action: string }[] }).trace[0]?.action).toBe('tree_chop');
  });

  it('guards against unbounded secondary recursion', async () => {
    const actions = new Map([['x', fake('x', noChange)]]);
    const recur: CallSecondary = (c, acts, _name, _args, depth) =>
      runMethod(c, acts, { steps: [{ action: 'loop' }] }, { depth, callSecondary: recur });
    const r = await runMethod(fakeCtx(), actions, { steps: [{ action: 'loop' }] }, { callSecondary: recur });
    expect(r.effectStatus).not.toBe('pass'); // the depth guard yields a structured unobservable
  });
});

describe('run_method static validation (no execution)', () => {
  const actions = new Map([['set_block', fake('set_block', noChange)], ['drop', fake('drop', noChange)]]);
  const asSteps = (s: unknown[]): Parameters<typeof validateMethod>[0]['steps'] => s as Parameters<typeof validateMethod>[0]['steps'];

  it('accepts a well-formed method using the inventory domain + projection', () => {
    const v = validateMethod(
      {
        steps: asSteps([
          {
            op: 'for_each',
            set: { op: 'inventory' },
            as: 's',
            body: [{ action: 'drop', args: { item: { from: 's', field: 'item' }, count: { from: 's', field: 'count' } } }],
          },
        ]),
      },
      { actions },
    );
    expect(v).toEqual({ valid: true, errors: [], steps: 1 });
  });

  it('reports unknown actions, missing control fields and bad set ops', () => {
    const v = validateMethod(
      { steps: asSteps([
        { action: 'nope' },
        { op: 'for_each', set: { op: 'inventory' }, body: [] },
        { op: 'sequence' },
        { op: 'for_each', set: { op: 'members' }, as: 'c', body: [] },
      ]) },
      { actions },
    );
    expect(v.valid).toBe(false);
    expect(v.errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(['steps[0].action', 'steps[1].as', 'steps[2].steps', 'steps[3].set.handle']),
    );
  });

  it('accepts a secondary action name when the library knows it', () => {
    const v = validateMethod({ steps: asSteps([{ action: 'tree_chop' }]) }, { actions, isSecondary: (n) => n === 'tree_chop' });
    expect(v.valid).toBe(true);
  });
});
