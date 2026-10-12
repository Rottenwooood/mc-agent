// Resolve a semantic Target into concrete world coordinates / ids at execution time
// (world-map-and-composition §12). Handles are re-validated on use; directions are compass.

import type { ActionResult, Target, Vec3 } from '@mc-agent/contracts';
import { directionStep, isUnknown } from '@mc-agent/contracts';
import { connectedComponent, distance, expandBox, parseHandle } from '@mc-agent/world';
import { mk } from '../result.js';
import type { ActionContext } from './types.js';

export interface Resolved {
  pos?: Vec3;
  entityId?: string;
  item?: string;
  containerPos?: Vec3;
  /** The handle this resolved from, for evidence. */
  subject?: string;
}

export type ResolveResult = { ok: true; value: Resolved } | ResolveFailure;

/** Structured resolve failure: reason + accepted shapes + the value actually received. */
export interface ResolveFailure {
  ok: false;
  reason: string;
  acceptedShapes?: readonly string[];
  received?: unknown;
}

/** Canonical target shapes (shown in tool schemas and echoed on resolve failure). */
export const TARGET_SHAPES = [
  '{kind:"object", handle:"obj:..."}',
  '{kind:"block", block:"minecraft:stone"}',
  '{kind:"cell", pos:[x,y,z]}',
  '{kind:"entity", handle:"ent:..."}',
  '{kind:"relative", dir:"north", steps:1}',
  '{kind:"self"}',
] as const;

/** JSON Schema for a `target` param — clients validate the shape before the resident runs it. */
export const TARGET_SCHEMA = {
  description: `Where to act. Prefer a view/scan_blocks object handle. Shapes: ${TARGET_SHAPES.join(' | ')}.`,
  oneOf: [
    { type: 'object', properties: { kind: { const: 'self' } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'object' }, handle: { type: 'string', description: 'obj:... handle from view/scan_blocks' }, ref: { type: 'string', description: 'alias of handle' } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'block' }, block: { type: 'string', description: 'e.g. minecraft:stone' }, within: { type: 'integer' }, around: { type: 'array', items: { type: 'integer' } } }, required: ['kind', 'block'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'cell' }, pos: { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 3 } }, required: ['kind', 'pos'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'entity' }, handle: { type: 'string' }, id: { type: 'string' }, type: { type: 'string' } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'relative' }, from: { type: 'string' }, dir: { type: 'string', enum: ['north', 'south', 'east', 'west', 'up', 'down', 'north-east', 'north-west', 'south-east', 'south-west'] }, steps: { type: 'integer' } }, required: ['kind', 'dir'], additionalProperties: false },
  ],
};

async function selfPos(ctx: ActionContext): Promise<Vec3 | undefined> {
  return ctx.world.selfPos();
}

/** Re-validate a block/liquid/interactable handle to its nearest present member. */
async function resolveObject(ctx: ActionContext, ref: string): Promise<ResolveResult> {
  const h = parseHandle(ref);
  if (!h) return { ok: false, reason: `bad handle: ${JSON.stringify(ref)}`, acceptedShapes: TARGET_SHAPES, received: ref };
  if (h.kind === 'entity') return { ok: true, value: { entityId: h.label, subject: ref } };
  const radius = 24;
  const bounded = {
    min: [h.anchor[0] - radius, h.anchor[1] - radius, h.anchor[2] - radius] as Vec3,
    max: [h.anchor[0] + radius, h.anchor[1] + radius, h.anchor[2] + radius] as Vec3,
  };
  const r = await ctx.world.query(expandBox(bounded, 1), { blockIds: [h.label], maxItems: 60000 });
  if (isUnknown(r)) return { ok: false, reason: 'not observed', acceptedShapes: TARGET_SHAPES, received: ref };
  const comp = connectedComponent(r.value, h.anchor, (b) => b === h.label, { bounded });
  if (comp.size === 0) return { ok: false, reason: 'expired: object no longer present', acceptedShapes: TARGET_SHAPES, received: ref };
  const self = await selfPos(ctx);
  // Prefer cells with an air-exposed face so pathing/digging targets a reachable surface
  // (e.g. an exposed trunk cell of a tree, not one buried inside the canopy).
  const pool = await exposedCells(ctx, comp.cells);
  let best = pool[0]!.pos;
  if (self) {
    let bd = distance(self, best);
    for (const c of pool) {
      const d = distance(self, c.pos);
      if (d < bd) {
        bd = d;
        best = c.pos;
      }
    }
  }
  return { ok: true, value: { pos: best, subject: ref } };
}

/** Keep only cells that touch air on some face; fall back to all cells if nothing is exposed. */
async function exposedCells(ctx: ActionContext, cells: { pos: Vec3 }[]): Promise<{ pos: Vec3 }[]> {
  if (cells.length === 0) return cells;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, c.pos[i]!);
      max[i] = Math.max(max[i]!, c.pos[i]!);
    }
  }
  const box = { min: [min[0] - 1, min[1] - 1, min[2] - 1] as Vec3, max: [max[0] + 1, max[1] + 1, max[2] + 1] as Vec3 };
  const all = await ctx.world.query(box, { maxItems: 60000 });
  if (isUnknown(all)) return cells;
  const solid = new Set(all.value.map((c) => c.pos.join(',')));
  const deltas = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  const exposed = cells.filter((c) =>
    deltas.some((d) => !solid.has([c.pos[0] + d[0]!, c.pos[1] + d[1]!, c.pos[2] + d[2]!].join(','))),
  );
  return exposed.length > 0 ? exposed : cells;
}

export async function resolveTarget(ctx: ActionContext, t: Target): Promise<ResolveResult> {
  // Structured guard: a missing/garbage target must return shapes to self-correct, not throw.
  if (!t || typeof t !== 'object' || typeof (t as { kind?: unknown }).kind !== 'string') {
    return { ok: false, reason: 'target is required (an object with a "kind")', acceptedShapes: TARGET_SHAPES, received: t };
  }
  switch (t.kind) {
    case 'self': {
      const p = await selfPos(ctx);
      return p ? { ok: true, value: { pos: p } } : { ok: false, reason: 'no self position' };
    }
    case 'cell':
      return { ok: true, value: { pos: t.pos } };
    case 'object': {
      const handle = (t as { handle?: string; ref?: string }).handle ?? (t as { ref?: string }).ref;
      if (!handle) return { ok: false, reason: 'object target needs a "handle"', acceptedShapes: TARGET_SHAPES, received: t };
      return resolveObject(ctx, handle);
    }
    case 'relative': {
      const base = t.from ? await resolveObject(ctx, t.from) : { ok: true as const, value: { pos: await selfPos(ctx) } };
      if (!base.ok) return base;
      const p = base.value.pos;
      if (!p) return { ok: false, reason: 'relative base has no position' };
      const s = directionStep(t.dir);
      const n = t.steps ?? 1;
      return { ok: true, value: { pos: [p[0] + s[0] * n, p[1] + s[1] * n, p[2] + s[2] * n] } };
    }
    case 'block': {
      const r = await ctx.world.findNearestBlock(t.block, t.within ?? 48, t.around);
      if (isUnknown(r)) return { ok: false, reason: 'not observed', acceptedShapes: TARGET_SHAPES, received: t };
      if (!r.value) return { ok: false, reason: 'not_found', acceptedShapes: TARGET_SHAPES, received: t };
      // Re-validate at use: the "nearest block" sample can be stale/expired — confirm the cell
      // still holds the block, else refuse (never mine an air cell from an old sample).
      const want = t.block.includes(':') ? t.block : 'minecraft:' + t.block;
      const check = await ctx.world.blockAt(r.value.pos);
      if (isUnknown(check)) return { ok: false, reason: 'not observed', acceptedShapes: TARGET_SHAPES, received: t };
      if (check.value !== want) {
        return { ok: false, reason: `stale target: ${r.value.pos.join(',')} is ${check.value}, not ${want} (rescan)`, acceptedShapes: TARGET_SHAPES, received: t };
      }
      return { ok: true, value: { pos: r.value.pos } };
    }
    case 'entity': {
      if (t.id) return { ok: true, value: { entityId: t.id } };
      const r = await ctx.world.entities(t.within ?? 16);
      if (isUnknown(r)) return { ok: false, reason: 'not observed' };
      const hit = r.value.find((e) => !t.type || e.type.includes(t.type));
      return hit ? { ok: true, value: { entityId: hit.id } } : { ok: false, reason: 'not_found' };
    }
    case 'item':
      return { ok: true, value: { item: t.item } };
    case 'container':
      return t.pos ? { ok: true, value: { containerPos: t.pos } } : { ok: false, reason: 'container target needs a position' };
    default:
      return { ok: false, reason: `unknown target kind: ${JSON.stringify(t)}`, acceptedShapes: TARGET_SHAPES, received: t };
  }
}

/** A structured failure result for a resolve error (accepted shapes + echo) — never a thrown exception. */
export function targetError(rt: ResolveFailure): ActionResult {
  return mk({
    effectStatus: 'fail',
    controlStatus: 'needs_replan',
    reason: 'precondition_failed',
    reasonDetail: rt.reason,
    data: { accepted_shapes: rt.acceptedShapes ?? TARGET_SHAPES, received: rt.received ?? null },
  });
}

/** Resolve or return a ready-to-return structured failure (the common action pattern). */
export async function resolveTargetOrFail(
  ctx: ActionContext,
  t: Target,
): Promise<{ ok: true; value: Resolved } | { ok: false; result: ActionResult }> {
  const rt = await resolveTarget(ctx, t);
  if (rt.ok) return rt;
  return { ok: false, result: targetError(rt) };
}
