// Capability ports implemented by adapters (framework §4.7).
// contracts must not depend on Mineflayer/Fabric/MCP.

import type { Box, EvidenceLevel, Fact, Vec3 } from './fact.js';

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
  status(): Promise<Fact<SelfState>>;
  entities(): Promise<Fact<EntityFact[]>>;
  query(box: Box): Promise<Fact<BlockCell[]>>;
  events(cursor?: EventCursor): Promise<EventPage>;
}

export interface VisionPort {
  frame(): Promise<Frame>;
}

/** Player-legal control surface. Implemented by adapters/mineflayer. */
export interface ControlPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  goto(pos: Vec3, opts?: { range?: number; timeoutMs?: number }): Promise<ControlReceipt>;
  dig(pos: Vec3): Promise<ControlReceipt>;
  place(pos: Vec3, face: Vec3, item?: string): Promise<ControlReceipt>;
  use(pos: Vec3): Promise<ControlReceipt>;
  equip(item: string, destination?: string): Promise<ControlReceipt>;
  craft(item: string, count: number): Promise<ControlReceipt>;
  chat(message: string): Promise<ControlReceipt>;
}
