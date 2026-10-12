import { describe, expect, it } from 'vitest';
import type { BodyState, ConnectOptions } from '@mc-agent/contracts';
import { actionRegistry } from '@mc-agent/execution';

const join = actionRegistry().get('join_server')!;
const leave = actionRegistry().get('leave_server')!;

interface Rec {
  connect: ConnectOptions[];
  disconnect: number;
}

function ctxWith(st: BodyState, rec: Rec, connectThrows = false): never {
  return {
    ctrl: {
      bodyState: async () => st,
      connect: async (opts: ConnectOptions = {}) => {
        rec.connect.push(opts);
        if (connectThrows) throw new Error('connection refused');
      },
      disconnect: async () => {
        rec.disconnect += 1;
      },
    },
  } as never;
}

const rec = (): Rec => ({ connect: [], disconnect: 0 });

describe('join_server / leave_server (body lifecycle)', () => {
  it('joins (no args) when disconnected', async () => {
    const r = rec();
    const res = await join.run(ctxWith({ connected: false, controllable: true, server: 'h:1' }, r), {});
    expect(res.effectStatus).toBe('pass');
    expect(r.connect).toEqual([{}]);
    expect(r.disconnect).toBe(0);
  });

  it('no_op when already connected and no target given', async () => {
    const r = rec();
    const res = await join.run(ctxWith({ connected: true, controllable: true }, r), {});
    expect(res.effectStatus).toBe('no_op');
    expect(r.connect).toEqual([]);
  });

  it('switches target while connected (leave then join with the parsed opts)', async () => {
    const r = rec();
    const res = await join.run(ctxWith({ connected: true, controllable: true }, r), { server: 'h:2', username: 'X' });
    expect(res.effectStatus).toBe('pass');
    expect(r.disconnect).toBe(1);
    expect(r.connect).toEqual([{ host: 'h', port: 2, username: 'X' }]);
  });

  it('parses server without a port, and version', async () => {
    const r = rec();
    await join.run(ctxWith({ connected: false, controllable: true }, r), { server: 'mc.example.com', version: '1.20.1' });
    expect(r.connect).toEqual([{ host: 'mc.example.com', version: '1.20.1' }]);
  });

  it('leave: pass when connected, no_op when not, and reports the new state', async () => {
    const r1 = rec();
    expect((await leave.run(ctxWith({ connected: true, controllable: true }, r1), {})).effectStatus).toBe('pass');
    expect(r1.disconnect).toBe(1);
    const r2 = rec();
    expect((await leave.run(ctxWith({ connected: false, controllable: true }, r2), {})).effectStatus).toBe('no_op');
    expect(r2.disconnect).toBe(0);
  });

  it('fails precondition_failed when the backend does not control join/leave', async () => {
    const r = rec();
    const ctx = ctxWith({ connected: true, controllable: false, server: 'client-mod' }, r);
    expect((await join.run(ctx, {})).reason).toBe('precondition_failed');
    expect((await leave.run(ctxWith({ connected: true, controllable: false }, rec()), {})).reason).toBe('precondition_failed');
  });

  it('reports a failed join as fail (never throws)', async () => {
    const res = await join.run(ctxWith({ connected: false, controllable: true }, rec(), true), {});
    expect(res.effectStatus).toBe('fail');
    expect(res.reasonDetail).toContain('join failed');
  });
});
