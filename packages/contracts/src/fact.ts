// Facts and evidence grading (framework §4.1).
// Two orthogonal axes:
//   Source       — where a fact comes from (server truth vs client view vs inference).
//   EvidenceLevel— how strong the evidence for an *action effect* is.

export const SOURCES = ['authoritative', 'observed', 'predicted', 'inferred'] as const;
export type Source = (typeof SOURCES)[number];

export const EVIDENCE_LEVELS = ['sent', 'predicted', 'observed', 'attributed'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export type Vec3 = [number, number, number];

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface Coverage {
  loaded: boolean;
  truncated: boolean;
  box?: Box;
}

/** A value that is only meaningful together with its provenance and freshness. */
export interface Fact<T> {
  value: T;
  source: Source;
  observedTick: number;
  coverage: Coverage;
}

/** An explicit "we do not know" — never to be treated as false/absent. */
export interface Unknown {
  readonly unknown: true;
  readonly reason: string;
}

export type MaybeFact<T> = Fact<T> | Unknown;

export function isUnknown(x: unknown): x is Unknown {
  return typeof x === 'object' && x !== null && (x as { unknown?: unknown }).unknown === true;
}

export function unknown(reason: string): Unknown {
  return { unknown: true, reason };
}

/** Input already sent / client prediction does NOT count as a pass basis. */
export function countsAsPassBasis(level: EvidenceLevel): boolean {
  return level === 'observed' || level === 'attributed';
}
