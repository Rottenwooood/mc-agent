// Set expressions of the bounded vocabulary, evaluated fresh against the authoritative world
// (target-conditioned: the agent recomputes what is missing instead of replaying literals).

import type { Box, Filter, SetExpr, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { connectedComponent, expandBox, key, type World } from '@mc-agent/world';
import { resolveArg, type Vars } from './args.js';

const norm = (b: string): string => (b.includes(':') ? b : 'minecraft:' + b);

export async function filterPredicate(world: World, filter?: Filter): Promise<(b: string) => boolean> {
  if (!filter) return () => true;
  if (typeof filter === 'string') {
    const t = norm(filter);
    return (b) => b === t;
  }
  if (filter.anyOf && filter.anyOf.length > 0) {
    const s = new Set(filter.anyOf.map(norm));
    return (b) => s.has(b);
  }
  if (filter.block) {
    const t = norm(filter.block);
    return (b) => b === t;
  }
  if (filter.tag) {
    const tt = await world.tagTable();
    const set = new Set(isUnknown(tt) ? [] : (tt.value.blocks[norm(filter.tag)] ?? []));
    return (b) => set.has(b);
  }
  return () => true;
}

export async function evalSet(world: World, set: SetExpr, vars: Vars): Promise<Vec3[]> {
  switch (set.op) {
    case 'region': {
      const box = resolveArg(set.box, vars) as Box;
      const r = await world.query(box);
      if (isUnknown(r)) return [];
      const pred = await filterPredicate(world, set.filter);
      return r.value.filter((c) => pred(c.block)).map((c) => c.pos);
    }
    case 'component': {
      const seed = resolveArg(set.seed, vars) as Vec3;
      const radius = 32;
      const bounded: Box =
        set.bounded ?? {
          min: [seed[0] - radius, seed[1] - radius, seed[2] - radius],
          max: [seed[0] + radius, seed[1] + radius, seed[2] + radius],
        };
      const r = await world.query(expandBox(bounded, 1));
      if (isUnknown(r)) return [];
      const pred = await filterPredicate(world, set.match);
      const neighbor = set.neighbor === 'edge' ? 'edge' : 'face';
      const comp = connectedComponent(r.value, seed, pred, { bounded, neighbor });
      return comp.cells.map((c) => c.pos);
    }
    case 'set_difference': {
      const a = await evalSet(world, set.a, vars);
      const b = await evalSet(world, set.b, vars);
      const bs = new Set(b.map((p) => key(p)));
      return a.filter((p) => !bs.has(key(p)));
    }
  }
}
