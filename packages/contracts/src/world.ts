// World query / relation shapes (framework §5, world-map-and-composition §6).
// Matching is by block id or official tag — never a hand-made taxonomy.

import type { Box, Vec3 } from './fact.js';
import type { BlockCell } from './ports.js';

export type Match =
  | { kind: 'block'; block: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'any' };

/** Official tag tables as reported by the server registry (tag id -> member ids). */
export interface TagTable {
  blocks: Record<string, string[]>;
  entities: Record<string, string[]>;
}

/** A non-air cell face that touches air (surface shell element). */
export interface ExposedFace {
  pos: Vec3;
  block: string;
  /** Outward unit normals that face air. */
  normals: Vec3[];
}

/** Connected component of matching cells (e.g. "a tree" = component of a log over #logs). */
export interface Component {
  seed: Vec3 | null;
  cells: BlockCell[];
  bbox: Box;
  size: number;
  exposed: number;
}

export interface Reachability {
  reachable: boolean;
  pathLength?: number;
}
