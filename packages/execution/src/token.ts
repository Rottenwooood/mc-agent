// Single-body control token. The first version is a strict mutex: only one body-owning
// action runs at a time (framework §9 / docs/research/15 §2). Priority preemption arrives
// in M2 with the reflex layer.

export class ControlToken {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
