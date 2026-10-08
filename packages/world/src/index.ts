// World layer (M1 minimal): turns port facts into queryable world answers.
// Full general queries (component/relations/surface graph/two-tier map) arrive in M2.

import type {
  BlockCell,
  EntityFact,
  ItemStack,
  MaybeFact,
  SelfState,
  Vec3,
  WorldPort,
} from '@mc-agent/contracts';
import { isUnknown, unknown } from '@mc-agent/contracts';
import { nearestCell, type BlockHit } from './geometry.js';

export class World {
  constructor(private readonly port: WorldPort) {}

  status(): Promise<MaybeFact<SelfState>> {
    return this.port.status();
  }

  inventory(): Promise<MaybeFact<ItemStack[]>> {
    return this.port.inventory();
  }

  entities(radius?: number): Promise<MaybeFact<EntityFact[]>> {
    return this.port.entities(radius != null ? { radius } : undefined);
  }

  async selfPos(): Promise<Vec3 | undefined> {
    const s = await this.port.status();
    return isUnknown(s) ? undefined : s.value.pos;
  }

  /** Authoritative block id at a position; 'minecraft:air' when confirmed empty, Unknown when not observed. */
  async blockAt(pos: Vec3): Promise<MaybeFact<string>> {
    const r = await this.port.query({ min: pos, max: pos });
    if (isUnknown(r)) return r;
    const hit = r.value.find((c) => c.pos[0] === pos[0] && c.pos[1] === pos[1] && c.pos[2] === pos[2]);
    return {
      value: hit ? hit.block : 'minecraft:air',
      source: 'authoritative',
      observedTick: r.observedTick,
      coverage: r.coverage,
    };
  }

  /** Nearest block of an id within a cube around `around` (default: self). null = confirmed none; Unknown = not observed. */
  async findNearestBlock(block: string, radius: number, around?: Vec3): Promise<MaybeFact<BlockHit | null>> {
    const center = around ?? (await this.selfPos());
    if (!center) return unknown('no self position');
    const box = {
      min: [center[0] - radius, center[1] - radius, center[2] - radius] as Vec3,
      max: [center[0] + radius, center[1] + radius, center[2] + radius] as Vec3,
    };
    const r = await this.port.query(box);
    if (isUnknown(r)) return r;
    const cells: BlockCell[] = r.value.filter((c) => c.block === block);
    const best = nearestCell(cells, center);
    return { value: best, source: 'authoritative', observedTick: r.observedTick, coverage: r.coverage };
  }
}

export { nearestCell, distance } from './geometry.js';
export type { BlockHit } from './geometry.js';
