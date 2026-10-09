// Object aggregation + the near per-block view (world-map-and-composition §12).
// Aggregates exposed (air/water-facing) connected matching cells into objects with compass
// addresses; builds the cropped per-block view. Pure over a set of authoritative cells.

import type { BlockCell, Direction, Vec3 } from '@mc-agent/contracts';
import { compassFrom } from '@mc-agent/contracts';
import { EDGE_NEIGHBORS, FACE_NEIGHBORS, key } from './queries.js';

export type ObjectKind = 'block' | 'interactable' | 'entity' | 'liquid';

export interface WorldObject {
  handle: string;
  kind: ObjectKind;
  label: string;
  size: number;
  cells: Vec3[];
  anchor: Vec3;
  center: Vec3;
  dir: Direction;
  centerDistance: number;
  edgeDistance: number;
  touchable: boolean;
  reachable: boolean | null;
}

const FLUID_RE = /^minecraft:(flowing_)?(water|lava)$/;
export const isFluid = (b: string): boolean => FLUID_RE.test(b);

export function objectHandle(kind: ObjectKind, label: string, anchor: Vec3): string {
  return `obj:${kind}:${label}:${anchor[0]},${anchor[1]},${anchor[2]}`;
}

export const entityHandle = (id: string): string => `ent:${id}`;

export function parseHandle(ref: string): { kind: ObjectKind; label: string; anchor: Vec3 } | null {
  const e = /^ent:(.+)$/.exec(ref);
  if (e) return { kind: 'entity', label: e[1]!, anchor: [0, 0, 0] };
  const m = /^obj:([a-z]+):(.+):(-?\d+),(-?\d+),(-?\d+)$/.exec(ref);
  if (!m) return null;
  return { kind: m[1] as ObjectKind, label: m[2]!, anchor: [Number(m[3]), Number(m[4]), Number(m[5])] };
}

/** Cells whose at least one face neighbour is air (absent) or a fluid. Requires a padded cell set. */
export function exposedCells(cells: readonly BlockCell[]): BlockCell[] {
  const present = new Map<string, string>();
  for (const c of cells) present.set(key(c.pos), c.block);
  return cells.filter((c) =>
    FACE_NEIGHBORS.some((n) => {
      const nb = present.get(key([c.pos[0] + n[0], c.pos[1] + n[1], c.pos[2] + n[2]]));
      return nb === undefined || isFluid(nb);
    }),
  );
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Aggregate matching exposed cells into connected objects (face/edge), each with compass attributes. */
export function aggregateObjects(
  cells: readonly BlockCell[],
  match: (block: string) => boolean,
  self: Vec3,
  opts: { neighbor?: 'face' | 'edge'; reach?: number; kind?: ObjectKind } = {},
): WorldObject[] {
  const neighbor = opts.neighbor === 'edge' ? EDGE_NEIGHBORS : FACE_NEIGHBORS;
  const reach = opts.reach ?? 4.5;
  const byKey = new Map<string, BlockCell>();
  for (const c of cells) if (match(c.block)) byKey.set(key(c.pos), c);

  const seen = new Set<string>();
  const out: WorldObject[] = [];
  for (const start of byKey.keys()) {
    if (seen.has(start)) continue;
    const queue: Vec3[] = [];
    const startCell = byKey.get(start)!;
    queue.push(startCell.pos);
    seen.add(start);
    const members: Vec3[] = [startCell.pos];
    while (queue.length > 0) {
      const p = queue.shift()!;
      for (const n of neighbor) {
        const np: Vec3 = [p[0] + n[0], p[1] + n[1], p[2] + n[2]];
        const k = key(np);
        if (seen.has(k) || !byKey.has(k)) continue;
        seen.add(k);
        members.push(np);
        queue.push(np);
      }
    }
    let nearest = members[0]!;
    let edge = Infinity;
    const center: Vec3 = [0, 0, 0];
    for (const m of members) {
      center[0] += m[0];
      center[1] += m[1];
      center[2] += m[2];
      const d = dist(self, m);
      if (d < edge) {
        edge = d;
        nearest = m;
      }
    }
    center[0] /= members.length;
    center[1] /= members.length;
    center[2] /= members.length;
    const label = startCell.block;
    const kind = opts.kind ?? 'block';
    out.push({
      handle: objectHandle(kind, label, nearest),
      kind,
      label,
      size: members.length,
      cells: members.slice(0, 256),
      anchor: nearest,
      center,
      dir: compassFrom(self, nearest),
      centerDistance: Number(dist(self, center).toFixed(2)),
      edgeDistance: Number(edge.toFixed(2)),
      touchable: edge <= reach,
      reachable: null,
    });
  }
  out.sort((a, b) => a.edgeDistance - b.edgeDistance);
  return out;
}

// ---- near per-block view ----

export interface ViewLayer {
  y: number;
  rows: string[];
}
export interface ViewResult {
  origin: Vec3;
  dims: [number, number, number];
  axes: { x: string; z: string; y: string };
  legend: Record<string, string>;
  layers: ViewLayer[];
  self: [number, number, number];
  cropped: boolean;
  truncated: boolean;
}

const AIR = '.';
const SOLID = '#'; // known non-air but not an exposed face (buried/interior)
const FOG = '?';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Build a cropped per-block view: only the tight box that contains blocks (plus the player),
 * expanded by one, clamped to the radius box. Exposed faces get legend letters; known buried
 * cells are `#`; air is `.`; unobserved (only at a truncated edge) is `?`.
 */
export function buildView(
  cells: readonly BlockCell[],
  self: Vec3,
  opts: { radius: number; height: number; truncated?: boolean },
): ViewResult {
  const { radius, height, truncated = false } = opts;
  const boxMin: Vec3 = [Math.round(self[0]) - radius, Math.round(self[1]) - height, Math.round(self[2]) - radius];
  const boxMax: Vec3 = [Math.round(self[0]) + radius, Math.round(self[1]) + height, Math.round(self[2]) + radius];
  const byKey = new Map<string, string>();
  for (const c of cells) byKey.set(key(c.pos), c.block);

  // bounding box of non-air cells within the radius box
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  const grow = (p: Vec3) => {
    if (!min || !max) {
      min = [p[0], p[1], p[2]];
      max = [p[0], p[1], p[2]];
      return;
    }
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1]), Math.min(min[2], p[2])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1]), Math.max(max[2], p[2])];
  };
  for (const c of cells) grow(c.pos);
  grow([Math.round(self[0]), Math.round(self[1]), Math.round(self[2])]);

  const lo: Vec3 = [
    Math.max(boxMin[0], Math.round(min ![0]) - 1),
    Math.max(boxMin[1], Math.round(min ![1]) - 1),
    Math.max(boxMin[2], Math.round(min ![2]) - 1),
  ];
  const hi: Vec3 = [
    Math.min(boxMax[0], Math.round(max![0]) + 1),
    Math.min(boxMax[1], Math.round(max![1]) + 1),
    Math.min(boxMax[2], Math.round(max![2]) + 1),
  ];

  // legend for exposed faces
  const legend: Record<string, string> = {};
  const legendFor = (block: string): string => {
    for (const [ch, b] of Object.entries(legend)) if (b === block) return ch;
    const ch = ALPHABET[Object.keys(legend).length] ?? 'x';
    legend[ch] = block;
    return ch;
  };
  const exposed = new Set(exposedCells(cells).map((c) => key(c.pos)));

  const selfIdx: [number, number, number] = [Math.round(self[0]) - lo[0], Math.round(self[1]) - lo[1], Math.round(self[2]) - lo[2]];
  const layers: ViewLayer[] = [];
  for (let y = lo[1]; y <= hi[1]; y++) {
    const rows: string[] = [];
    for (let x = lo[0]; x <= hi[0]; x++) {
      let row = '';
      for (let z = lo[2]; z <= hi[2]; z++) {
        const block = byKey.get(`${x},${y},${z}`);
        if (x === Math.round(self[0]) && y === Math.round(self[1]) && z === Math.round(self[2])) row += '@';
        else if (block === undefined) row += truncated ? FOG : AIR;
        else if (isFluid(block)) row += legendFor(block);
        else if (exposed.has(`${x},${y},${z}`)) row += legendFor(block);
        else row += SOLID;
      }
      rows.push(row);
    }
    layers.push({ y, rows });
  }

  const cropped = lo[0] > boxMin[0] || lo[1] > boxMin[1] || lo[2] > boxMin[2] || hi[0] < boxMax[0] || hi[1] < boxMax[1] || hi[2] < boxMax[2];
  return {
    origin: lo,
    dims: [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1],
    axes: { x: 'west→east', z: 'north→south', y: 'down→up' },
    legend,
    layers,
    self: selfIdx,
    cropped,
    truncated,
  };
}
