import type { ItemStack } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import type { World } from '@mc-agent/world';

/** Inventory count, or null when the inventory is unobservable (never silently 0). */
export async function invCountOrNull(world: World, item: string): Promise<number | null> {
  const inv = await world.inventory();
  if (isUnknown(inv)) return null;
  return inv.value.filter((i: ItemStack) => i.item === item).reduce((s, i) => s + i.count, 0);
}

/** Whole-inventory snapshot keyed by item id; null when unobservable. */
export async function invSnapshot(world: World): Promise<Map<string, number> | null> {
  const inv = await world.inventory();
  if (isUnknown(inv)) return null;
  const m = new Map<string, number>();
  for (const i of inv.value) m.set(i.item, (m.get(i.item) ?? 0) + i.count);
  return m;
}

/** after - before over all items (missing = 0). */
export function snapshotDelta(before: Map<string, number>, after: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const d = (after.get(k) ?? 0) - (before.get(k) ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}
