// Target model for atomic actions (world-map-and-composition §12).
// Model-facing addresses are primarily OBJECT HANDLES and COMPASS DIRECTIONS. Explicit
// coordinates are kept as a secondary escape and are not guided.

import type { Vec3 } from './fact.js';

/** Compass + vertical. Never bound to the player's facing. */
export type Direction =
  | 'north'
  | 'south'
  | 'east'
  | 'west'
  | 'up'
  | 'down'
  | 'north-east'
  | 'north-west'
  | 'south-east'
  | 'south-west';

export type Target =
  | { kind: 'self' }
  /** A handle from view/scan_blocks/recall; re-validated on use. */
  | { kind: 'object'; ref: string }
  /** Relative to the player or another handle. */
  | { kind: 'relative'; from?: string; dir: Direction; steps?: number }
  | { kind: 'block'; block: string; nearest?: boolean; around?: Vec3; radius?: number }
  | { kind: 'entity'; id?: string; type?: string; nearest?: boolean; radius?: number }
  | { kind: 'item'; item: string }
  | { kind: 'container'; pos?: Vec3; entityId?: string }
  /** Secondary escape: explicit coordinate. Not guided. */
  | { kind: 'cell'; pos: Vec3 };

export function isCellTarget(t: Target): t is { kind: 'cell'; pos: Vec3 } {
  return t.kind === 'cell';
}

/** Unit step for a compass direction (+X east, -X west, +Z south, -Z north, +Y up). */
export function directionStep(dir: Direction): Vec3 {
  switch (dir) {
    case 'east':
      return [1, 0, 0];
    case 'west':
      return [-1, 0, 0];
    case 'south':
      return [0, 0, 1];
    case 'north':
      return [0, 0, -1];
    case 'up':
      return [0, 1, 0];
    case 'down':
      return [0, -1, 0];
    case 'north-east':
      return [1, 0, -1];
    case 'north-west':
      return [-1, 0, -1];
    case 'south-east':
      return [1, 0, 1];
    case 'south-west':
      return [-1, 0, 1];
  }
}

/** Compass direction from `from` to `to` (horizontal sectors + vertical), for display. */
export function compassFrom(from: Vec3, to: Vec3): Direction {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const dy = to[1] - from[1];
  if (dx === 0 && dz === 0) return dy >= 0 ? 'up' : 'down';
  if (dz < 0) return dx > 0 ? 'north-east' : dx < 0 ? 'north-west' : 'north';
  if (dz > 0) return dx > 0 ? 'south-east' : dx < 0 ? 'south-west' : 'south';
  return dx > 0 ? 'east' : 'west';
}
