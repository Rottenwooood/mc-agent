// Pure world-query functions (no IO), so they are unit-testable in tests/semantics.
//
// `cells` is the set of non-air cells of a region; a missing neighbour therefore means
// "air". Callers must query a region *expanded by one* beyond the queried box so that
// neighbour exposure at the box edge is resolved (otherwise it would be misread as air).

import type { BlockCell, Box, Component, ExposedFace, Vec3 } from '@mc-agent/contracts';

export const FACE_NEIGHBORS: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export const EDGE_NEIGHBORS: Vec3[] = (() => {
  const out: Vec3[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        out.push([dx, dy, dz]);
      }
    }
  }
  return out;
})();

export function key(p: Vec3): string {
  return `${p[0]},${p[1]},${p[2]}`;
}

export function inBox(p: Vec3, box: Box): boolean {
  return (
    p[0] >= box.min[0] &&
    p[0] <= box.max[0] &&
    p[1] >= box.min[1] &&
    p[1] <= box.max[1] &&
    p[2] >= box.min[2] &&
    p[2] <= box.max[2]
  );
}

export function expandBox(box: Box, by: number): Box {
  return {
    min: [box.min[0] - by, box.min[1] - by, box.min[2] - by],
    max: [box.max[0] + by, box.max[1] + by, box.max[2] + by],
  };
}

/** Exposed faces of the non-air cells inside `box` (neighbour air resolved from `cells`). */
export function exposedFaces(cells: readonly BlockCell[], box: Box): ExposedFace[] {
  const present = new Set(cells.map((c) => key(c.pos)));
  const out: ExposedFace[] = [];
  for (const c of cells) {
    if (!inBox(c.pos, box)) continue;
    const normals: Vec3[] = [];
    for (const n of FACE_NEIGHBORS) {
      const np: Vec3 = [c.pos[0] + n[0], c.pos[1] + n[1], c.pos[2] + n[2]];
      if (!present.has(key(np))) normals.push(n);
    }
    if (normals.length > 0) out.push({ pos: c.pos, block: c.block, normals });
  }
  return out;
}

/** Cells whose top face touches air and which have support below (multi-level allowed). */
export function standableSurfaces(cells: readonly BlockCell[], box: Box): Vec3[] {
  const present = new Set(cells.map((c) => key(c.pos)));
  const out: Vec3[] = [];
  for (const c of cells) {
    if (!inBox(c.pos, box)) continue;
    const above = key([c.pos[0], c.pos[1] + 1, c.pos[2]]);
    const below = key([c.pos[0], c.pos[1] - 1, c.pos[2]]);
    if (!present.has(above) && present.has(below)) out.push(c.pos);
  }
  return out;
}

export interface ConnectedOptions {
  bounded: Box;
  neighbor?: 'face' | 'edge';
}

/** Face (or edge) connected component of matching cells reachable from `seed`. */
export function connectedComponent(
  cells: readonly BlockCell[],
  seed: Vec3,
  match: (block: string) => boolean,
  opts: ConnectedOptions,
): Component {
  const byKey = new Map<string, BlockCell>();
  for (const c of cells) byKey.set(key(c.pos), c);
  const neighbor = opts.neighbor === 'edge' ? EDGE_NEIGHBORS : FACE_NEIGHBORS;

  const startCell = byKey.get(key(seed));
  if (!startCell || !match(startCell.block)) {
    return { seed, cells: [], bbox: { min: seed, max: seed }, size: 0, exposed: 0 };
  }

  const seen = new Set<string>([key(seed)]);
  const queue: Vec3[] = [seed];
  const members: BlockCell[] = [];
  let min: Vec3 = [...seed];
  let max: Vec3 = [...seed];

  while (queue.length > 0) {
    const p = queue.shift() as Vec3;
    const cell = byKey.get(key(p));
    if (!cell) continue;
    members.push(cell);
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1]), Math.min(min[2], p[2])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1]), Math.max(max[2], p[2])];
    for (const n of neighbor) {
      const np: Vec3 = [p[0] + n[0], p[1] + n[1], p[2] + n[2]];
      if (!inBox(np, opts.bounded)) continue;
      const k = key(np);
      if (seen.has(k)) continue;
      const nc = byKey.get(k);
      if (!nc || !match(nc.block)) continue;
      seen.add(k);
      queue.push(np);
    }
  }

  let exposed = 0;
  for (const m of members) {
    let touchesAir = false;
    for (const n of FACE_NEIGHBORS) {
      const np: Vec3 = [m.pos[0] + n[0], m.pos[1] + n[1], m.pos[2] + n[2]];
      if (!byKey.has(key(np))) {
        touchesAir = true;
        break;
      }
    }
    if (touchesAir) exposed += 1;
  }

  return { seed, cells: members, bbox: { min, max }, size: members.length, exposed };
}
