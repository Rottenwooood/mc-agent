// World layer: turns port facts into queryable world answers.
// M2 adds general queries (region / exposed faces / standable surfaces / connected
// components) and official-tag matching; relations + surface graph build on these.

import type {
  BlockCell,
  Box,
  Component,
  EntityFact,
  EventCursor,
  EventPage,
  ExposedFace,
  ItemStack,
  Match,
  MaybeFact,
  SelfState,
  TagTable,
  Vec3,
  WorldPort,
} from '@mc-agent/contracts';
import { isUnknown, unknown } from '@mc-agent/contracts';
import { nearestCell, type BlockHit } from './geometry.js';
import { makeBlockMatcher } from './match.js';
import { DiscoveryGraph } from './discovery.js';
import { connectedComponent, expandBox, exposedFaces as exposedFacesOf, standableSurfaces as standableOf, isHazardous, FACE_NEIGHBORS, key } from './queries.js';

export class World {
  private tagsFact: MaybeFact<TagTable> | undefined;
  /** Persistent sparse discovery graph — planning only, never postcondition evidence. */
  readonly discoveries = new DiscoveryGraph();

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

  events(cursor?: EventCursor, max?: number): Promise<EventPage> {
    return this.port.events(cursor, max);
  }

  selfPos(): Promise<Vec3 | undefined> {
    return this.port.status().then((s) => (isUnknown(s) ? undefined : s.value.pos));
  }

  /** Official tag tables, fetched once (static per server start). */
  async tagTable(): Promise<MaybeFact<TagTable>> {
    if (this.tagsFact === undefined) this.tagsFact = await this.port.tags();
    return this.tagsFact;
  }

  /** Raw bounded region query (authoritative non-air cells). */
  query(box: Box): Promise<MaybeFact<BlockCell[]>> {
    return this.port.query(box);
  }

  /** Bounded region query (authoritative non-air cells), optionally filtered by block/tag. */
  async region(box: Box, match: Match = { kind: 'any' }): Promise<MaybeFact<BlockCell[]>> {
    const tags = match.kind === 'tag' ? await this.tagTable() : undefined;
    if (match.kind === 'tag' && tags !== undefined && isUnknown(tags)) return tags;
    const r = await this.query(box);
    if (isUnknown(r)) return r;
    const m = makeBlockMatcher(match, tags !== undefined && !isUnknown(tags) ? tags.value : undefined);
    return { value: r.value.filter((c) => m(c.block)), source: r.source, observedTick: r.observedTick, coverage: r.coverage };
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
    const r = await this.port.query(box, { blockIds: [block] });
    if (isUnknown(r)) return r;
    if (r.coverage.truncated) return unknown('region truncated; nearest not reliable');
    const cells: BlockCell[] = r.value.filter((c) => c.block === block);
    const best = nearestCell(cells, center);
    return { value: best, source: 'authoritative', observedTick: r.observedTick, coverage: r.coverage };
  }

  /** Exposed faces (surface shell elements) of the non-air cells inside `box`. */
  async exposedFaces(box: Box): Promise<MaybeFact<ExposedFace[]>> {
    const r = await this.port.query(expandBox(box, 1));
    if (isUnknown(r)) return r;
    return { value: exposedFacesOf(r.value, box), source: r.source, observedTick: r.observedTick, coverage: r.coverage };
  }

  /** Cells whose top face touches air and which have support below (multi-level). */
  async standableSurfaces(box: Box): Promise<MaybeFact<Vec3[]>> {
    const r = await this.port.query(expandBox(box, 1));
    if (isUnknown(r)) return r;
    return { value: standableOf(r.value, box), source: r.source, observedTick: r.observedTick, coverage: r.coverage };
  }

  /** Face/edge connected component of matching cells reachable from `seed` (e.g. "a tree" over a log and #logs). */
  async connected(
    seed: Vec3,
    match: Match,
    opts: { bounded?: Box; neighbor?: 'face' | 'edge'; radius?: number } = {},
  ): Promise<MaybeFact<Component>> {
    const tags = match.kind === 'tag' ? await this.tagTable() : undefined;
    if (match.kind === 'tag' && tags !== undefined && isUnknown(tags)) return tags;
    const radius = opts.radius ?? 16;
    const bounded: Box =
      opts.bounded ?? {
        min: [seed[0] - radius, seed[1] - radius, seed[2] - radius],
        max: [seed[0] + radius, seed[1] + radius, seed[2] + radius],
      };
    const r = await this.port.query(expandBox(bounded, 1));
    if (isUnknown(r)) return r;
    const m = makeBlockMatcher(match, tags !== undefined && !isUnknown(tags) ? tags.value : undefined);
    const component = connectedComponent(r.value, seed, m, { bounded, ...(opts.neighbor ? { neighbor: opts.neighbor } : {}) });
    return { value: component, source: r.source, observedTick: r.observedTick, coverage: r.coverage };
  }

  /** At least one face neighbour is air (authoritative). */
  async adjacentAir(pos: Vec3): Promise<MaybeFact<boolean>> {
    const r = await this.query(expandBox({ min: pos, max: pos }, 1));
    if (isUnknown(r)) return r;
    const present = new Set(r.value.map((c) => key(c.pos)));
    const value = FACE_NEIGHBORS.some(
      (n) => !present.has(key([pos[0] + n[0], pos[1] + n[1], pos[2] + n[2]])),
    );
    return { value, source: r.source, observedTick: r.observedTick, coverage: r.coverage };
  }

  /** The cell directly below is non-air (support) (authoritative). */
  async support(pos: Vec3): Promise<MaybeFact<boolean>> {
    const below: Vec3 = [pos[0], pos[1] - 1, pos[2]];
    const b = await this.blockAt(below);
    if (isUnknown(b)) return b;
    return { value: b.value !== 'minecraft:air', source: b.source, observedTick: b.observedTick, coverage: b.coverage };
  }

  /** Hazardous block at a position, from official damage tags (authoritative). */
  async hazardous(pos: Vec3): Promise<MaybeFact<boolean>> {
    const tags = await this.tagTable();
    const b = await this.blockAt(pos);
    if (isUnknown(b)) return b;
    const value = isHazardous(b.value, isUnknown(tags) ? undefined : tags.value);
    return { value, source: 'authoritative', observedTick: b.observedTick, coverage: b.coverage };
  }
}

export { nearestCell, distance } from './geometry.js';
export type { BlockHit } from './geometry.js';
export { SurfaceShell } from './shell.js';
export { DiscoveryGraph } from './discovery.js';
export type { DiscoveryEntry, DiscoveryKind, DiscoveryQuery, DiscoveryGraphJSON } from './discovery.js';
export { makeBlockMatcher, makeEntityMatcher } from './match.js';
export {
  FACE_NEIGHBORS,
  EDGE_NEIGHBORS,
  key,
  inBox,
  expandBox,
  boxDiff,
  exposedFaces,
  standableSurfaces,
  connectedComponent,
  isHazardous,
  HAZARD_TAGS,
} from './queries.js';
export type { ConnectedOptions } from './queries.js';
