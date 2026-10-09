// Resolve a semantic Target into concrete world coordinates / ids at execution time
// (world-map-and-composition §12). Handles are re-validated on use; directions are compass.

import type { Target, Vec3 } from '@mc-agent/contracts';
import { directionStep, isUnknown } from '@mc-agent/contracts';
import { connectedComponent, distance, expandBox, parseHandle } from '@mc-agent/world';
import type { ActionContext } from './types.js';

export interface Resolved {
  pos?: Vec3;
  entityId?: string;
  item?: string;
  containerPos?: Vec3;
  /** The handle this resolved from, for evidence. */
  subject?: string;
}

export type ResolveResult = { ok: true; value: Resolved } | { ok: false; reason: string };

async function selfPos(ctx: ActionContext): Promise<Vec3 | undefined> {
  return ctx.world.selfPos();
}

/** Re-validate a block/liquid/interactable handle to its nearest present member. */
async function resolveObject(ctx: ActionContext, ref: string): Promise<ResolveResult> {
  const h = parseHandle(ref);
  if (!h) return { ok: false, reason: `bad handle: ${ref}` };
  if (h.kind === 'entity') return { ok: true, value: { entityId: h.label, subject: ref } };
  const radius = 24;
  const bounded = {
    min: [h.anchor[0] - radius, h.anchor[1] - radius, h.anchor[2] - radius] as Vec3,
    max: [h.anchor[0] + radius, h.anchor[1] + radius, h.anchor[2] + radius] as Vec3,
  };
  const r = await ctx.world.query(expandBox(bounded, 1), { blockIds: [h.label], maxItems: 60000 });
  if (isUnknown(r)) return { ok: false, reason: 'not observed' };
  const comp = connectedComponent(r.value, h.anchor, (b) => b === h.label, { bounded });
  if (comp.size === 0) return { ok: false, reason: 'expired: object no longer present' };
  const self = await selfPos(ctx);
  let best = comp.cells[0]!.pos;
  if (self) {
    let bd = distance(self, best);
    for (const c of comp.cells) {
      const d = distance(self, c.pos);
      if (d < bd) {
        bd = d;
        best = c.pos;
      }
    }
  }
  return { ok: true, value: { pos: best, subject: ref } };
}

export async function resolveTarget(ctx: ActionContext, t: Target): Promise<ResolveResult> {
  switch (t.kind) {
    case 'self': {
      const p = await selfPos(ctx);
      return p ? { ok: true, value: { pos: p } } : { ok: false, reason: 'no self position' };
    }
    case 'cell':
      return { ok: true, value: { pos: t.pos } };
    case 'object':
      return resolveObject(ctx, t.ref);
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
      if (isUnknown(r)) return { ok: false, reason: 'not observed' };
      if (!r.value) return { ok: false, reason: 'not_found' };
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
  }
}
