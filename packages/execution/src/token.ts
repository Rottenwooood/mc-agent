// Single-body control token. The execution engine is the sole owner; only one body-owning
// action runs at a time. It is re-entrant within the same async context, so an action that
// (defensively) also asks for the token does not deadlock against the engine.

import { AsyncLocalStorage } from 'node:async_hooks';

export class ControlToken {
  private tail: Promise<void> = Promise.resolve();
  private readonly held = new AsyncLocalStorage<true>();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.held.getStore()) return fn();
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await this.held.run(true, fn);
    } finally {
      release();
    }
  }
}
