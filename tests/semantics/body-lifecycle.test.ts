import { describe, expect, it } from 'vitest';
import type { BodyState } from '@mc-agent/contracts';
import { actionRegistry } from '@mc-agent/execution';

const join = actionRegistry().get('join_server')!;
const leave = actionRegistry().get('leave_server')!;

function ctxWith(over: { state: BodyState; calls?: string[]; connectThrows?: boolean }): never {
  const calls = over.calls ?? [];
  return {
    ctrl: {
      bodyState: async () => over.state,
      connect: async () => {
        calls.push('connect');
        if (over.connectThrows) throw new Error('connection refused');
      },
      disconnect: async () => {
        calls.push('disconnect');
      },
    },
  } as never;
}

describe('join_server / leave_server (body lifecycle)', () => {
  it('joins and reports the new state when disconnected', async () => {
    const calls: string[] = [];
    let state: BodyState = { connected: false, controllable: true, server: '127.0.0.1:25565', username: 'Bot' };
    const ctx = {
      ctrl: {
        bodyState: async () => state,
        connect: async () => {
          calls.push('connect');
          state = { ...state, connected: true };
        },
        disconnect: async () => {
          calls.push('disconnect');
        },
      },
    } as never;
    const r = await join.run(ctx, {});
    expect(r.effectStatus).toBe('pass');
    expect(calls).toEqual(['connect']);
    expect((r.data as BodyState).connected).toBe(true);
  });

  it('no_op when already connected', async () => {
    const r = await join.run(ctxWith({ state: { connected: true, controllable: true } }), {});
    expect(r.effectStatus).toBe('no_op');
  });

  it('leaves when connected', async () => {
    const calls: string[] = [];
    const r = await leave.run(ctxWith({ state: { connected: true, controllable: true }, calls }), {});
    expect(r.effectStatus).toBe('pass');
    expect(calls).toEqual(['disconnect']);
  });

  it('no_op when not connected', async () => {
    const r = await leave.run(ctxWith({ state: { connected: false, controllable: true } }), {});
    expect(r.effectStatus).toBe('no_op');
  });

  it('fails precondition_failed when the backend does not control join/leave', async () => {
    const ctx = ctxWith({ state: { connected: true, controllable: false, server: 'client-mod' } });
    expect((await join.run(ctx, {})).reason).toBe('precondition_failed');
    expect((await leave.run(ctxWith({ state: { connected: true, controllable: false } }), {})).reason).toBe('precondition_failed');
  });

  it('reports a failed join as fail (never throws)', async () => {
    const r = await join.run(ctxWith({ state: { connected: false, controllable: true }, connectThrows: true }), {});
    expect(r.effectStatus).toBe('fail');
    expect(r.reasonDetail).toContain('join failed');
  });
});
