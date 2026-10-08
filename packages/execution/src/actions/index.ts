// The full atomic action library (all domains). This is the library the rest of the system
// is built around — not a hand-picked subset.

import type { AtomicAction } from './types.js';
import { perceptionActions } from './perception.js';
import { movementActions } from './movement.js';
import { blockActions } from './blocks.js';
import { entityActions } from './entities.js';
import { inventoryActions } from './inventory.js';
import { containerActions } from './containers.js';
import { metaActions } from './meta.js';

export const ALL_ACTIONS: AtomicAction[] = [
  ...perceptionActions,
  ...movementActions,
  ...blockActions,
  ...entityActions,
  ...inventoryActions,
  ...containerActions,
  ...metaActions,
];

export function actionRegistry(): Map<string, AtomicAction> {
  return new Map(ALL_ACTIONS.map((a) => [a.contract.name, a]));
}

export * from './types.js';
export * from './target.js';
