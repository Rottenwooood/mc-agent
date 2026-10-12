// Causal-neighbourhood signature (framework §4/§6, L3): a cheap snapshot of the world a
// body action can causally affect — blocks in a scope plus inventory and self vitals — so
// the engine can diff "before vs after" and attribute the real effect.

import type { Box, Evidence, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { key } from '@mc-agent/world';
import type { ActionContext } from '../actions/types.js';

export interface EffectScope {
  box: Box;
  anchor?: Vec3;
}

export interface Signature {
  blocks: Map<string, string>;
  inventory: Record<string, number>;
  hp: number | null;
  food: number | null;
  pos: Vec3 | null;
}

export interface SignatureDiff {
  changed: boolean;
  blocksAdded: string[];
  blocksRemoved: string[];
  blocksChanged: string[];
  inventoryDelta: Record<string, number>;
  hpDelta: number;
  foodDelta: number;
}

/** Everything an action's own verifier sees: the scope before/after and the causal diff. */
export interface VerificationWindow {
  before: Signature;
  after: Signature;
  diff: SignatureDiff;
  anchor?: Vec3;
}

export interface VerifyOutcome {
  ok: 'pass' | 'fail' | 'unobservable' | 'no_op';
  evidence: Evidence[];
}

export async function captureSignature(ctx: ActionContext, scope: EffectScope): Promise<Signature> {
  const blocks = new Map<string, string>();
  const r = await ctx.world.query(scope.box);
  if (!isUnknown(r)) {
    for (const c of r.value) blocks.set(key(c.pos), c.block);
  }
  const inventory: Record<string, number> = {};
  const inv = await ctx.world.inventory();
  if (!isUnknown(inv)) {
    for (const s of inv.value) inventory[s.item] = (inventory[s.item] ?? 0) + s.count;
  }
  const st = await ctx.world.status();
  return {
    blocks,
    inventory,
    hp: isUnknown(st) ? null : st.value.health,
    food: isUnknown(st) ? null : st.value.food,
    pos: isUnknown(st) ? null : st.value.pos,
  };
}

export function diffSignatures(before: Signature, after: Signature): SignatureDiff {
  const blocksAdded: string[] = [];
  const blocksRemoved: string[] = [];
  const blocksChanged: string[] = [];
  for (const [k, v] of after.blocks) {
    if (!before.blocks.has(k)) blocksAdded.push(k);
    else if (before.blocks.get(k) !== v) blocksChanged.push(k);
  }
  for (const k of before.blocks.keys()) {
    if (!after.blocks.has(k)) blocksRemoved.push(k);
  }
  const inventoryDelta: Record<string, number> = {};
  for (const item of new Set([...Object.keys(before.inventory), ...Object.keys(after.inventory)])) {
    const d = (after.inventory[item] ?? 0) - (before.inventory[item] ?? 0);
    if (d !== 0) inventoryDelta[item] = d;
  }
  const hpDelta = (after.hp ?? 0) - (before.hp ?? 0);
  const foodDelta = (after.food ?? 0) - (before.food ?? 0);
  const changed =
    blocksAdded.length > 0 ||
    blocksRemoved.length > 0 ||
    blocksChanged.length > 0 ||
    Object.keys(inventoryDelta).length > 0 ||
    hpDelta !== 0 ||
    foodDelta !== 0;
  return { changed, blocksAdded, blocksRemoved, blocksChanged, inventoryDelta, hpDelta, foodDelta };
}
