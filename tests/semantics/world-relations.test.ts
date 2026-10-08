import { describe, expect, it } from 'vitest';
import { SurfaceShell, World } from '@mc-agent/world';
import type { BlockCell, Box, EntityFact, EventPage, ItemStack, MaybeFact, SelfState, TagTable, Vec3, WorldPort } from '@mc-agent/contracts';

const fact = <T>(value: T): MaybeFact<T> => ({ value, source: 'authoritative', observedTick: 1, coverage: { loaded: true, truncated: false } });

class FakePort implements WorldPort {
  constructor(
    readonly cells: BlockCell[],
    private readonly tagTable: TagTable = { blocks: {}, entities: {} },
  ) {}

  async status(): Promise<MaybeFact<SelfState>> {
    return fact<SelfState>({ pos: [0, 0, 0], yaw: 0, pitch: 0, health: 20, food: 20, dimension: 'minecraft:overworld', onGround: true });
  }
  async entities(): Promise<MaybeFact<EntityFact[]>> {
    return fact<EntityFact[]>([]);
  }
  async inventory(): Promise<MaybeFact<ItemStack[]>> {
    return fact<ItemStack[]>([]);
  }
  async query(box: Box): Promise<MaybeFact<BlockCell[]>> {
    return fact(
      this.cells.filter(
        (c) =>
          c.pos[0] >= box.min[0] && c.pos[0] <= box.max[0] &&
          c.pos[1] >= box.min[1] && c.pos[1] <= box.max[1] &&
          c.pos[2] >= box.min[2] && c.pos[2] <= box.max[2],
      ),
    );
  }
  async events(): Promise<EventPage> {
    return { cursor: { epoch: 1, seq: 0 }, hasMore: false, events: [] };
  }
  async tags(): Promise<MaybeFact<TagTable>> {
    return fact(this.tagTable);
  }
}

const cell = (x: number, y: number, z: number, block: string): BlockCell => ({ pos: [x, y, z] as Vec3, block });

describe('World wrapper over a port (queries + relations)', () => {
  it('filters a region by official tag', async () => {
    const w = new World(new FakePort(
      [cell(0, 0, 0, 'minecraft:oak_log'), cell(1, 0, 0, 'minecraft:stone')],
      { blocks: { 'minecraft:logs': ['minecraft:oak_log'] }, entities: {} },
    ));
    const r = await w.region({ min: [-4, -4, -4], max: [4, 4, 4] }, { kind: 'tag', tag: 'minecraft:logs' });
    expect('value' in r && r.value.map((c) => c.block)).toEqual(['minecraft:oak_log']);
  });

  it('reports adjacency, support and hazards', async () => {
    const w = new World(new FakePort(
      [cell(0, 0, 0, 'minecraft:stone'), cell(0, -1, 0, 'minecraft:dirt'), cell(5, 0, 0, 'minecraft:fire')],
      { blocks: { 'minecraft:fire': ['minecraft:fire'] }, entities: {} },
    ));
    expect(await w.adjacentAir([0, 0, 0])).toMatchObject({ value: true });
    expect(await w.support([0, 0, 0])).toMatchObject({ value: true });
    expect(await w.support([0, 9, 0])).toMatchObject({ value: false });
    expect(await w.hazardous([5, 0, 0])).toMatchObject({ value: true });
    expect(await w.hazardous([0, 0, 0])).toMatchObject({ value: false });
  });

  it('builds a connected component of a log chain', async () => {
    const w = new World(new FakePort(
      [cell(0, 0, 0, 'minecraft:oak_log'), cell(1, 0, 0, 'minecraft:oak_log'), cell(2, 0, 0, 'minecraft:oak_log'), cell(9, 0, 0, 'minecraft:oak_log')],
      { blocks: { 'minecraft:logs': ['minecraft:oak_log'] }, entities: {} },
    ));
    const c = await w.connected([0, 0, 0], { kind: 'tag', tag: 'minecraft:logs' }, { radius: 8 });
    expect('value' in c && c.value.size).toBe(3);
  });
});

describe('surface shell', () => {
  it('derives standable/hazardous faces and patches on events', async () => {
    const port = new FakePort(
      [cell(0, 0, 0, 'minecraft:stone'), cell(0, -1, 0, 'minecraft:dirt'), cell(5, 0, 0, 'minecraft:fire')],
      { blocks: { 'minecraft:fire': ['minecraft:fire'] }, entities: {} },
    );
    const w = new World(port);
    const shell = new SurfaceShell(w, 8);
    await shell.refresh([0, 0, 0]);
    const box: Box = { min: [-2, -2, -2] as Vec3, max: [6, 2, 2] as Vec3 };
    expect(shell.standableIn(box)).toContainEqual([0, 0, 0]);

    const tt = await w.tagTable();
    const haz = shell.hazardousIn(box, 'value' in tt ? tt.value : undefined).map((f) => f.block);
    expect(haz).toContain('minecraft:fire');

    // event: remove the stone at (0,0,0); the shell must drop its faces on patch
    const i = port.cells.findIndex((c) => c.pos[0] === 0 && c.pos[1] === 0 && c.pos[2] === 0);
    port.cells.splice(i, 1);
    await shell.patch([0, 0, 0]);
    const local: Box = { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 };
    expect(shell.facesIn(local).some((f) => f.pos[0] === 0 && f.pos[1] === 0 && f.pos[2] === 0)).toBe(false);
  });
});
