// Pure geometric helpers (no IO), so they are unit-testable in tests/semantics.

import type { BlockCell, Vec3 } from '@mc-agent/contracts';

export interface BlockHit {
  pos: Vec3;
  block: string;
  distance: number;
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function nearestCell(cells: readonly BlockCell[], from: Vec3): BlockHit | null {
  let best: BlockHit | null = null;
  let bestD = Infinity;
  for (const c of cells) {
    const d = distance(c.pos, from);
    if (d < bestD) {
      bestD = d;
      best = { pos: c.pos, block: c.block, distance: d };
    }
  }
  return best;
}
