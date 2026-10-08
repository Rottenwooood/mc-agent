import { describe, expect, it } from 'vitest';
import {
  connectedComponent,
  exposedFaces,
  makeBlockMatcher,
  standableSurfaces,
} from '@mc-agent/world';
import type { BlockCell, Box, Vec3 } from '@mc-agent/contracts';

const cell = (x: number, y: number, z: number, block: string): BlockCell => ({ pos: [x, y, z] as Vec3, block });
const box = (min: Vec3, max: Vec3): Box => ({ min, max });

describe('world queries (pure)', () => {
  it('exposedFaces reports every air-facing normal for an isolated block', () => {
    const cells = [cell(0, 0, 0, 'minecraft:stone')];
    const faces = exposedFaces(cells, box([0, 0, 0], [0, 0, 0]));
    expect(faces).toHaveLength(1);
    expect(faces[0]!.normals).toHaveLength(6);
  });

  it('exposedFaces hides faces pressed against a neighbour', () => {
    const cells = [cell(0, 0, 0, 'minecraft:stone'), cell(1, 0, 0, 'minecraft:stone')];
    const faces = exposedFaces(cells, box([0, 0, 0], [1, 0, 0]));
    const left = faces.find((f) => f.pos[0] === 0)!;
    const right = faces.find((f) => f.pos[0] === 1)!;
    expect(left.normals).not.toContainEqual([1, 0, 0]);
    expect(right.normals).not.toContainEqual([-1, 0, 0]);
  });

  it('standableSurfaces needs air above and support below (multi-level)', () => {
    const cells = [cell(0, 0, 0, 'minecraft:stone'), cell(0, 1, 0, 'minecraft:stone'), cell(0, 2, 0, 'minecraft:stone')];
    const s = standableSurfaces(cells, box([0, 0, 0], [0, 2, 0]));
    expect(s).toEqual([[0, 2, 0]]);
  });

  it('connectedComponent walks a chain and excludes a disconnected island', () => {
    const cells = [
      cell(0, 0, 0, 'minecraft:oak_log'),
      cell(1, 0, 0, 'minecraft:oak_log'),
      cell(2, 0, 0, 'minecraft:oak_log'),
      cell(3, 0, 0, 'minecraft:oak_log'),
      cell(10, 0, 0, 'minecraft:oak_log'),
    ];
    const logMatch = makeBlockMatcher({ kind: 'block', block: 'minecraft:oak_log' });
    const c = connectedComponent(cells, [0, 0, 0], logMatch, { bounded: box([-16, -16, -16], [16, 16, 16]) });
    expect(c.size).toBe(4);
    expect(c.bbox.min).toEqual([0, 0, 0]);
    expect(c.bbox.max).toEqual([3, 0, 0]);
  });

  it('tag matching uses the official tag table only', () => {
    const tags = { blocks: { 'minecraft:logs': ['minecraft:oak_log'] }, entities: {} };
    const m = makeBlockMatcher({ kind: 'tag', tag: 'minecraft:logs' }, tags);
    expect(m('minecraft:oak_log')).toBe(true);
    expect(m('minecraft:oak_planks')).toBe(false);
    // without the table a tag matches nothing (never a guessed taxonomy)
    expect(makeBlockMatcher({ kind: 'tag', tag: 'minecraft:logs' })('minecraft:oak_log')).toBe(false);
  });
});
