// Surface shell (world-map-and-composition §1-4): keep only air-exposed faces, updated by
// event patches, window sliding and a low-frequency sweep. It is the authoritative, fresh
// source for control / safety / assertions — never the stale discovery map.
//
// Derived layers (standable / interactive / hazardous) are projections of the exposed faces.

import type { Box, ExposedFace, TagTable, Vec3, WorldEvent } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import type { World } from './index.js';
import { boxDiff, inBox, isHazardous, key } from './queries.js';

const hasNormal = (f: ExposedFace, n: Vec3): boolean =>
  f.normals.some((m) => m[0] === n[0] && m[1] === n[1] && m[2] === n[2]);

export class SurfaceShell {
  private readonly faces = new Map<string, ExposedFace>();
  private center: Vec3 | null = null;

  constructor(
    private readonly world: World,
    /** Window radius in blocks. Kept modest until the Mod can return only exposed faces. */
    private readonly radius = 10,
  ) {}

  get size(): number {
    return this.faces.size;
  }

  get windowCenter(): Vec3 | null {
    return this.center;
  }

  private windowBox(center: Vec3): Box {
    const r = this.radius;
    return { min: [center[0] - r, center[1] - r, center[2] - r], max: [center[0] + r, center[1] + r, center[2] + r] };
  }

  /** Full authoritative scan of the window (initial fill and low-frequency fallback). */
  async refresh(center: Vec3): Promise<void> {
    const box = this.windowBox(center);
    const r = await this.world.exposedFaces(box);
    if (isUnknown(r)) return;
    // A truncated scan would silently drop faces; refuse to populate from it.
    if (r.coverage.truncated) return;
    this.faces.clear();
    for (const f of r.value) this.faces.set(key(f.pos), f);
    this.center = center;
  }

  /** Event patch: recompute the 3x3x3 neighbourhood of a changed cell. */
  async patch(pos: Vec3): Promise<void> {
    const box: Box = { min: [pos[0] - 1, pos[1] - 1, pos[2] - 1], max: [pos[0] + 1, pos[1] + 1, pos[2] + 1] };
    const r = await this.world.exposedFaces(box);
    if (isUnknown(r)) return;
    for (let x = box.min[0]; x <= box.max[0]; x++) {
      for (let y = box.min[1]; y <= box.max[1]; y++) {
        for (let z = box.min[2]; z <= box.max[2]; z++) {
          this.faces.delete(key([x, y, z]));
        }
      }
    }
    for (const f of r.value) this.faces.set(key(f.pos), f);
  }

  /** Apply authoritative block-change events as patches. */
  async applyEvents(events: readonly WorldEvent[]): Promise<void> {
    for (const e of events) {
      if (e.type === 'block_changed' && e.pos) await this.patch(e.pos);
    }
  }

  /** Shift the window when the centre enters a new chunk: add the frontier, drop the trailing edge. */
  async recenter(center: Vec3): Promise<void> {
    const prev = this.center;
    const sameChunk =
      prev !== null &&
      Math.floor(prev[0] / 16) === Math.floor(center[0] / 16) &&
      Math.floor(prev[2] / 16) === Math.floor(center[2] / 16);
    if (sameChunk) {
      this.center = center;
      return;
    }
    const newBox = this.windowBox(center);
    const additions = prev ? boxDiff(newBox, this.windowBox(prev)) : [newBox];
    for (const b of additions) {
      const r = await this.world.exposedFaces(b);
      if (isUnknown(r) || r.coverage.truncated) continue;
      for (const f of r.value) this.faces.set(key(f.pos), f);
    }
    for (const [k, f] of this.faces) {
      if (!inBox(f.pos, newBox)) this.faces.delete(k);
    }
    this.center = center;
  }

  facesIn(box: Box): ExposedFace[] {
    return [...this.faces.values()].filter((f) => inBox(f.pos, box));
  }

  /** Standable surfaces: top face exposed and resting on something (bottom not exposed). */
  standableIn(box: Box): Vec3[] {
    return this.facesIn(box)
      .filter((f) => hasNormal(f, [0, 1, 0]) && !hasNormal(f, [0, -1, 0]))
      .map((f) => f.pos);
  }

  /** Interactive faces: any exposed face (LOS filtering happens where the client is available). */
  interactiveIn(box: Box): ExposedFace[] {
    return this.facesIn(box);
  }

  /** Hazardous exposed faces, from official damage tags. */
  hazardousIn(box: Box, tags?: TagTable): ExposedFace[] {
    return this.facesIn(box).filter((f) => isHazardous(f.block, tags));
  }
}
