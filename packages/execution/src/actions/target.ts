// Resolve a semantic Target into concrete world coordinates / ids at execution time.
// Coordinates are resolved here, not supplied by the model.

import type { Target, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import type { ActionContext } from './types.js';

export interface Resolved {
  pos?: Vec3;
  entityId?: string;
  item?: string;
  containerPos?: Vec3;
}

export type ResolveResult = { ok: true; value: Resolved } | { ok: false; reason: string };

export async function resolveTarget(ctx: ActionContext, t: Target): Promise<ResolveResult> {
  switch (t.kind) {
    case 'self': {
      const p = await ctx.world.selfPos();
      return p ? { ok: true, value: { pos: p } } : { ok: false, reason: 'no self position' };
    }
    case 'cell':
      return { ok: true, value: { pos: t.pos } };
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
      return t.pos ? { ok: true, value: { containerPos: t.pos } } : { ok: false, reason: 'container target needs a position (M2: nearest container)' };
    case 'object':
      return { ok: false, reason: 'object refs arrive in M2' };
  }
}
