import { describe, expect, it } from 'vitest';
import type { ActionResult } from '@mc-agent/contracts';
import { ControlToken, contract, mk } from '@mc-agent/execution';
import type { ActionContext, AtomicAction } from '@mc-agent/execution';
import { runMethod } from '@mc-agent/tasks';

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
