// Minimal three-valued predicate evaluation for the vocabulary's `until`/`if`/postconditions.
// Unsupported subjects return `undefined` (unknown) — never coerced to false.

import type { Predicate, Tri } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { parseHandle } from '@mc-agent/world';
import type { ActionContext } from '@mc-agent/execution';

const norm = (b: string): string => (b.includes(':') ? b : 'minecraft:' + b);

function parseVec(s: string): [number, number, number] {
  const p = s.split(',').map((x) => Number(x));
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

function cmpNum(actual: number, pred: Predicate): Tri {
  const v = Number(pred.value);
  switch (pred.predicate) {
    case 'is':
    case '==':
      return actual === v;
    case '!=':
      return actual !== v;
    case '>=':
      return actual >= v;
    case '<=':
      return actual <= v;
    case '>':
      return actual > v;
    case '<':
      return actual < v;
    default:
      return undefined;
  }
}

function cmpStr(actual: string, pred: Predicate): Tri {
  switch (pred.predicate) {
    case 'is':
    case '==':
      return actual === String(pred.value);
    case '!=':
      return actual !== String(pred.value);
    default:
      return undefined;
  }
}

export async function evalPredicate(ctx: ActionContext, pred: Predicate): Promise<Tri> {
  const s = pred.subject;
  if (s.startsWith('block@')) {
    const b = await ctx.world.blockAt(parseVec(s.slice('block@'.length)));
    return isUnknown(b) ? undefined : cmpStr(b.value, pred);
  }
  if (s.startsWith('inv:')) {
    const item = norm(s.slice('inv:'.length));
    const inv = await ctx.world.inventory();
    if (isUnknown(inv)) return undefined;
    const n = inv.value.filter((i) => i.item === item).reduce((a, x) => a + x.count, 0);
    return cmpNum(n, pred);
  }
  if (s === 'self.hp' || s === 'self.health') {
    const st = await ctx.world.status();
    return isUnknown(st) ? undefined : cmpNum(st.value.health, pred);
  }
  if (s === 'self.food') {
    const st = await ctx.world.status();
    return isUnknown(st) ? undefined : cmpNum(st.value.food, pred);
  }
  if (s === 'self.on_ground') {
    const st = await ctx.world.status();
    return isUnknown(st) ? undefined : st.value.onGround;
  }
  if (s.startsWith('entity#')) {
    const id = s.slice('entity#'.length);
    const es = await ctx.world.entities(64);
    return isUnknown(es) ? undefined : es.value.some((e) => e.id === id);
  }
  if (s.startsWith('obj:') || s.startsWith('ent:')) {
    const h = parseHandle(s);
    if (!h) return undefined;
    if (h.kind === 'entity') {
      const es = await ctx.world.entities(64);
      return isUnknown(es) ? undefined : es.value.some((e) => e.id === h.label);
    }
    const r = await ctx.world.connected(h.anchor, { kind: 'block', block: h.label }, { radius: 32 });
    if (isUnknown(r)) return undefined;
    const size = r.value.size;
    switch (pred.predicate) {
      case 'gone':
        return size === 0;
      case 'present':
        return size > 0;
      case 'size_ge':
        return size >= Number(pred.value);
      case 'size_le':
        return size <= Number(pred.value);
      case 'size_is':
      case 'is':
        return size === Number(pred.value);
      default:
        return undefined;
    }
  }
  return undefined;
}
