// Wire types of the server-observer mod HTTP contract (see mods/server-observer HttpApi).
// These are the *only* shapes this adapter knows; upper layers see contracts, not these.

export interface WireCoverage {
  loaded: boolean;
  truncated: boolean;
  boxes?: [number[], number[]];
}

export interface WireSelf {
  pos: number[];
  yaw: number;
  pitch: number;
  health: number;
  food: number;
  on_ground: boolean;
  dimension: string;
  source: string;
  observed_tick: number;
  obs_seq: number;
}

export interface WireBlock {
  pos: number[];
  block: string;
  source: string;
  observed_tick: number;
  obs_seq: number;
}

export interface WireEntity {
  id: number;
  type: string;
  pos: number[];
  source: string;
  observed_tick: number;
}

export interface WireInventoryItem {
  slot: number;
  item: string;
  count: number;
}

export interface WireSnapshot {
  ok: boolean;
  snapshot_seq: number;
  server_tick: number;
  revision: number;
  coverage: WireCoverage;
  self?: WireSelf;
  blocks?: WireBlock[];
  block_count?: number;
  entities?: WireEntity[];
  entity_count?: number;
  inventory?: WireInventoryItem[];
}

export interface WireEvent {
  seq: number;
  tick: number;
  type: string;
  pos?: number[];
  before?: string;
  after?: string;
  actor?: string;
}

export interface WireEvents {
  ok: boolean;
  epoch: number;
  cursor: { epoch: number; seq: number };
  has_more: boolean;
  reset_required: boolean;
  events: WireEvent[];
}

export interface WireTags {
  ok: boolean;
  server_tick: number;
  blocks: Record<string, string[]>;
  entities: Record<string, string[]>;
}
