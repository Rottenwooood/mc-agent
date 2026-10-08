// Capability ports implemented by adapters (framework §4.7).
// contracts must not depend on Mineflayer/Fabric/MCP.

import type { Box, EvidenceLevel, Fact, MaybeFact, Vec3 } from './fact.js';
import type { TagTable } from './world.js';

export interface SelfState {
  pos: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  food: number;
  dimension: string;
  onGround: boolean;
}

export interface EntityFact {
  id: string;
  type: string;
  pos: Vec3;
  hostile?: boolean;
  distance?: number;
}

export interface BlockCell {
  pos: Vec3;
  block: string;
}

export interface ItemStack {
  slot: number;
  item: string;
  count: number;
}

export interface EventCursor {
  epoch: number;
  seq: number;
}

export interface WorldEvent {
  seq: number;
  tick: number;
  type: string;
  pos?: Vec3;
  before?: string;
  after?: string;
  actor?: string;
}

export interface EventPage {
  cursor: EventCursor;
  hasMore: boolean;
  resetRequired?: boolean;
  events: WorldEvent[];
}

/** Raw receipt of a control request — never a success judgement. */
export interface ControlReceipt {
  accepted: boolean;
  level: EvidenceLevel;
  note?: string;
  raw?: unknown;
}

export interface Frame {
  width: number;
  height: number;
  format: string;
  data: Uint8Array;
  tick: number;
}

export interface WorldPort {
  status(): Promise<MaybeFact<SelfState>>;
  entities(opts?: { radius?: number }): Promise<MaybeFact<EntityFact[]>>;
  inventory(): Promise<MaybeFact<ItemStack[]>>;
  query(box: Box): Promise<MaybeFact<BlockCell[]>>;
  events(cursor?: EventCursor, max?: number): Promise<EventPage>;
  /** Official tag tables (server-authoritative). Bound at server start; safe to cache. */
  tags(): Promise<MaybeFact<TagTable>>;
}

export interface VisionPort {
  frame(): Promise<Frame>;
}

// Player-legal control surface: the FULL primitive set across all domains
// (framework §6 / docs/research/10 §2). Raw receipts only; never a success judgement.

export interface MoveOptions {
  range?: number;
  timeoutMs?: number;
  /** Allow pathfinder to modify terrain (dig/place) while moving. Default false (protected). */
  allowModify?: boolean;
}

export interface AttackOptions {
  weapon?: string;
  durationMs?: number;
}

export interface ControlPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // movement
  goto(pos: Vec3, opts?: MoveOptions): Promise<ControlReceipt>;
  follow(entityId: string, distance: number, durationMs?: number): Promise<ControlReceipt>;
  flee(entityId: string, distance: number, timeoutMs?: number): Promise<ControlReceipt>;
  lookAt(pos: Vec3): Promise<ControlReceipt>;
  wait(ticks: number): Promise<ControlReceipt>;
  steer(controls: string[], durationMs: number): Promise<ControlReceipt>;

  // blocks
  dig(pos: Vec3): Promise<ControlReceipt>;
  place(pos: Vec3, face: Vec3, item?: string): Promise<ControlReceipt>;
  use(pos: Vec3): Promise<ControlReceipt>;

  // entities / combat
  attack(entityId: string, opts?: AttackOptions): Promise<ControlReceipt>;
  interactEntity(entityId: string, item?: string): Promise<ControlReceipt>;
  useItemOn(item: string, target: { pos?: Vec3; entityId?: string }): Promise<ControlReceipt>;

  // inventory
  equip(item: string, destination?: string): Promise<ControlReceipt>;
  unequip(destination?: string): Promise<ControlReceipt>;
  drop(item: string, count: number): Promise<ControlReceipt>;
  transfer(item: string, count: number, opts: { from: 'inventory' | 'container'; to: 'inventory' | 'container'; pos?: Vec3 }): Promise<ControlReceipt>;
  consume(item: string): Promise<ControlReceipt>;
  useItem(item: string, releaseMs?: number): Promise<ControlReceipt>;

  // containers / production
  openContainer(pos: Vec3): Promise<ControlReceipt>;
  closeContainer(): Promise<ControlReceipt>;
  craft(item: string, count: number, tablePos?: Vec3): Promise<ControlReceipt>;
  smelt(item: string, count: number, opts?: { fuel?: string; pos?: Vec3 }): Promise<ControlReceipt>;
  enchant(item: string, choice: number, pos?: Vec3): Promise<ControlReceipt>;
  anvilCombine(item1: string, item2: string, name?: string): Promise<ControlReceipt>;
  trade(entityId: string, index: number, times: number): Promise<ControlReceipt>;

  // meta
  chat(message: string): Promise<ControlReceipt>;
  runCommand(command: string): Promise<ControlReceipt>;

  // client-side reads (observed; never authoritative)
  raycast(maxDistance?: number): Promise<{ block?: { pos: Vec3; name: string }; entity?: { id: string; type: string } }>;
  lookupRecipe(item: string, table?: boolean): Promise<{ result: { item: string; count: number }; ingredients: { item: string; count: number }[]; requiresTable: boolean }[]>;
  worldInfo(): Promise<{ time: number; raining: boolean; dimension: string }>;
  containerContents(pos: Vec3): Promise<ItemStack[]>;
}
