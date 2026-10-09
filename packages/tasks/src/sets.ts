// Set expressions of the bounded vocabulary (world-map-and-composition §12), evaluated fresh
// against the authoritative world. Object/anchor-derived: members / surface / nearest / area.
// Explicit region/box_cells are kept as a fallback and are not guided.

import type { Box, Filter, SetExpr, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { connectedComponent, expandBox, exposedCells, key, parseHandle } from '@mc-agent/world';
import type { ActionContext } from '@mc-agent/execution';
import { resolveArg, type Vars } from './args.js';

const norm = (b: string): string => (b.includes(':') ? b : 'minecraft:' + b);

export async function filterPredicate(ctx: ActionContext, filter?: Filter): Promise<(b: string) => boolean> {
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
    const tt = await ctx.world.tagTable();
    const set = new Set(isUnknown(tt) ? [] : (tt.value.blocks[norm(filter.tag)] ?? []));
    return (b) => set.has(b);
  }
  return () => true;
}

function bboxOf(cells: readonly Vec3[]): Box | null {
  if (cells.length === 0) return null;
  const first = cells[0]!;
  let min: Vec3 = [first[0], first[1], first[2]];
  let max: Vec3 = [first[0], first[1], first[2]];
  for (const p of cells) {
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1]), Math.min(min[2], p[2])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1]), Math.max(max[2], p[2])];
  }
  return { min, max };
}

function cellsInBox(box: Box): Vec3[] {
  const out: Vec3[] = [];
  for (let x = box.min[0]; x <= box.max[0]; x++) {
    for (let y = box.min[1]; y <= box.max[1]; y++) {
      for (let z = box.min[2]; z <= box.max[2]; z++) out.push([x, y, z]);
    }
  }
  return out;
}

/** All cells of the object a handle points at (re-validated fresh). */
async function handleCells(ctx: ActionContext, ref: string): Promise<Vec3[]> {
  const h = parseHandle(ref);
  if (!h) return [];
  const r = await ctx.world.connected(h.anchor, { kind: 'block', block: h.label }, { radius: 32 });
  if (isUnknown(r)) return [];
  return r.value.cells.map((c) => c.pos);
}

async function resolveAnchor(ctx: ActionContext, anchor: unknown, vars: Vars): Promise<Vec3 | null> {
  const v = resolveArg(anchor, vars);
  if (v === 'self' || v === undefined || v === null) return (await ctx.world.selfPos()) ?? null;
  if (Array.isArray(v) && v.length === 3) return [Number(v[0]), Number(v[1]), Number(v[2])];
  if (typeof v === 'string') {
    const cells = await handleCells(ctx, v);
    if (cells.length === 0) return null;
    const self = await ctx.world.selfPos();
    let best = cells[0]!;
    if (self) {
      let bd = Number.POSITIVE_INFINITY;
      for (const c of cells) {
        const d = (c[0] - self[0]) ** 2 + (c[1] - self[1]) ** 2 + (c[2] - self[2]) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
    }
    return best;
  }
  return null;
}

async function nearestObjectCells(ctx: ActionContext, pred: (b: string) => boolean): Promise<Vec3[]> {
  const self = await ctx.world.selfPos();
  if (!self) return [];
  const radius = 32;
  const box: Box = {
    min: [Math.round(self[0]) - radius, Math.round(self[1]) - radius, Math.round(self[2]) - radius],
    max: [Math.round(self[0]) + radius, Math.round(self[1]) + radius, Math.round(self[2]) + radius],
  };
  const r = await ctx.world.query(expandBox(box, 1), { exposedOnly: true, maxItems: 40000 });
  if (isUnknown(r)) return [];
  const matches = r.value.filter((c) => pred(c.block));
  if (matches.length === 0) return [];
  let best = matches[0]!;
  let bd = Number.POSITIVE_INFINITY;
  for (const c of matches) {
    const d = (c.pos[0] - self[0]) ** 2 + (c.pos[1] - self[1]) ** 2 + (c.pos[2] - self[2]) ** 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  const matchLabel = best.block;
  const comp = connectedComponent(r.value, best.pos, (b) => b === matchLabel, { bounded: box });
  return comp.cells.map((c) => c.pos);
}

export async function evalSet(ctx: ActionContext, set: SetExpr, vars: Vars): Promise<Vec3[]> {
  const world = ctx.world;
  switch (set.op) {
    case 'members':
      return handleCells(ctx, String(resolveArg(set.handle, vars)));
    case 'surface': {
      const members = await handleCells(ctx, String(resolveArg(set.handle, vars)));
      const box = bboxOf(members);
      if (!box) return [];
      const setOf = new Set(members.map((p) => key(p)));
      const r = await world.query(expandBox(box, 1));
      if (isUnknown(r)) return [];
      return exposedCells(r.value).map((c) => c.pos).filter((p) => setOf.has(key(p)));
    }
    case 'nearest':
      return nearestObjectCells(ctx, await filterPredicate(ctx, set.match));
    case 'area': {
      const base = await resolveAnchor(ctx, set.anchor, vars);
      if (!base) return [];
      const off = set.offset ?? [0, 0, 0];
      const min: Vec3 = [base[0] + off[0], base[1] + off[1], base[2] + off[2]];
      const max: Vec3 = [min[0] + set.size[0] - 1, min[1] + set.size[1] - 1, min[2] + set.size[2] - 1];
      return cellsInBox({ min, max });
    }
    case 'region': {
      const box = resolveArg(set.box, vars) as Box;
      const r = await world.query(box);
      if (isUnknown(r)) return [];
      const pred = await filterPredicate(ctx, set.filter);
      return r.value.filter((c) => pred(c.block)).map((c) => c.pos);
    }
    case 'box_cells':
      return cellsInBox(resolveArg(set.box, vars) as Box);
    case 'component': {
      const seed = resolveArg(set.seed, vars) as Vec3;
      const radius = 32;
      const bounded: Box =
        set.bounded ?? { min: [seed[0] - radius, seed[1] - radius, seed[2] - radius], max: [seed[0] + radius, seed[1] + radius, seed[2] + radius] };
      const r = await world.query(expandBox(bounded, 1));
      if (isUnknown(r)) return [];
      const pred = await filterPredicate(ctx, set.match);
      const neighbor = set.neighbor === 'edge' ? 'edge' : 'face';
      const comp = connectedComponent(r.value, seed, pred, { bounded, neighbor });
      return comp.cells.map((c) => c.pos);
    }
    case 'set_difference': {
      const a = await evalSet(ctx, set.a, vars);
      const b = await evalSet(ctx, set.b, vars);
      const bs = new Set(b.map((p) => key(p)));
      return a.filter((p) => !bs.has(key(p)));
    }
  }
}
