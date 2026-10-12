import type { ItemStack } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import type { World } from '@mc-agent/world';

export async function invCount(world: World, item: string): Promise<number> {
  const inv = await world.inventory();
  if (isUnknown(inv)) return 0;
  return inv.value.filter((i: ItemStack) => i.item === item).reduce((s, i) => s + i.count, 0);
}

/** Inventory count, or null when the inventory is unobservable (never silently 0). */
export async function invCountOrNull(world: World, item: string): Promise<number | null> {
  const inv = await world.inventory();
  if (isUnknown(inv)) return null;
  return inv.value.filter((i: ItemStack) => i.item === item).reduce((s, i) => s + i.count, 0);
}
