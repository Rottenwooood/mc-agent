// Typed port errors — adapters translate third-party/runtime failures into these
// so upper layers never see raw exceptions (framework §4.4 / layering §4.4).

export class PortError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PortError';
  }
}

export class UnreachableError extends PortError {
  constructor(base: string) {
    super('UNREACHABLE', `cannot reach ${base}`);
    this.name = 'UnreachableError';
  }
}

export class TimeoutPortError extends PortError {
  constructor(what: string, ms: number) {
    super('TIMEOUT', `${what} timed out after ${ms}ms`);
    this.name = 'TimeoutPortError';
  }
}
