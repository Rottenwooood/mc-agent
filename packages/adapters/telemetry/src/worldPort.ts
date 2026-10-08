// WorldPort implementation over the read-only observer mod.
// Every fact is tagged with source=authoritative, its observed tick and coverage; a
// region that is not loaded becomes an explicit Unknown, never an empty/false value.

import type {
  BlockCell,
  Box,
  Coverage,
  EntityFact,
  EventCursor,
  EventPage,
  MaybeFact,
  SelfState,
  Vec3,
  WorldEvent,
  WorldPort,
} from '@mc-agent/contracts';
import { unknown } from '@mc-agent/contracts';
import { getJson, observerConfigFromEnv, postJson, type ObserverConfig } from '@mc-agent/foundation';
import type { WireCoverage, WireEvents, WireSnapshot } from './wire.js';

type Scope =
  | { kind: 'box'; min: Vec3; max: Vec3 }
  | { kind: 'egocentric'; r: number }
  | { kind: 'radius'; center: Vec3; r: number };

interface SnapshotReq {
  scope: Scope;
  want: string[];
  player?: string;
  max_items?: number;
  filters?: { block_ids?: string[] };
}

const v3 = (a: number[]): Vec3 => [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];

function toCoverage(c: WireCoverage): Coverage {
  const out: Coverage = { loaded: c.loaded, truncated: c.truncated };
  if (c.boxes && c.boxes.length === 2) {
    out.box = { min: v3(c.boxes[0]!), max: v3(c.boxes[1]!) };
  }
  return out;
}

export class TelemetryWorldPort implements WorldPort {
  constructor(
    private readonly cfg: ObserverConfig = observerConfigFromEnv(),
    private readonly player?: string,
  ) {}

  private async snapshot(req: SnapshotReq): Promise<WireSnapshot> {
    return postJson<WireSnapshot>(this.cfg.baseUrl + '/snapshot', req, {
      timeoutMs: this.cfg.timeoutMs,
      ...(this.cfg.token ? { token: this.cfg.token } : {}),
    });
  }

  async status(): Promise<MaybeFact<SelfState>> {
    const r = await this.snapshot({ scope: { kind: 'egocentric', r: 0 }, want: ['self'], ...(this.player ? { player: this.player } : {}) });
    if (!r.self) return unknown('self not present');
    const value: SelfState = {
      pos: v3(r.self.pos),
      yaw: r.self.yaw,
      pitch: r.self.pitch,
      health: r.self.health,
      food: r.self.food,
      dimension: r.self.dimension,
      onGround: r.self.on_ground,
    };
    return { value, source: 'authoritative', observedTick: r.server_tick, coverage: toCoverage(r.coverage) };
  }

  async entities(opts?: { radius?: number }): Promise<MaybeFact<EntityFact[]>> {
    const r = await this.snapshot({
      scope: { kind: 'egocentric', r: opts?.radius ?? 32 },
      want: ['entities'],
      ...(this.player ? { player: this.player } : {}),
    });
    if (!r.coverage.loaded) return unknown('region not loaded');
    const value: EntityFact[] = (r.entities ?? []).map((e) => ({ id: String(e.id), type: e.type, pos: v3(e.pos) }));
    return { value, source: 'authoritative', observedTick: r.server_tick, coverage: toCoverage(r.coverage) };
  }

  async query(box: Box): Promise<MaybeFact<BlockCell[]>> {
    const r = await this.snapshot({
      scope: { kind: 'box', min: box.min, max: box.max },
      want: ['blocks'],
      max_items: 8192,
      ...(this.player ? { player: this.player } : {}),
    });
    if (!r.coverage.loaded) return unknown('region not loaded');
    const value: BlockCell[] = (r.blocks ?? []).map((b) => ({ pos: v3(b.pos), block: b.block }));
    return { value, source: 'authoritative', observedTick: r.server_tick, coverage: toCoverage(r.coverage) };
  }

  async events(cursor?: EventCursor, max = 256): Promise<EventPage> {
    const params = new URLSearchParams();
    if (cursor) {
      params.set('epoch', String(cursor.epoch));
      params.set('seq', String(cursor.seq));
    }
    params.set('max', String(max));
    const r = await getJson<WireEvents>(this.cfg.baseUrl + '/events?' + params.toString(), {
      timeoutMs: this.cfg.timeoutMs,
      ...(this.cfg.token ? { token: this.cfg.token } : {}),
    });
    const events: WorldEvent[] = r.events.map((e) => {
      const ev: WorldEvent = { seq: e.seq, tick: e.tick, type: e.type };
      if (e.pos) ev.pos = v3(e.pos);
      if (e.before !== undefined) ev.before = e.before;
      if (e.after !== undefined) ev.after = e.after;
      if (e.actor !== undefined) ev.actor = e.actor;
      return ev;
    });
    return {
      cursor: { epoch: r.cursor.epoch, seq: r.cursor.seq },
      hasMore: r.has_more,
      resetRequired: r.reset_required,
      events,
    };
  }

  /** Liveness check (not part of WorldPort). */
  async health(): Promise<{ ok: boolean; serverTick: number; modVersion: string }> {
    const h = await getJson<{ ok: boolean; server_tick: number; mod_version: string }>(this.cfg.baseUrl + '/health', {
      timeoutMs: this.cfg.timeoutMs,
      ...(this.cfg.token ? { token: this.cfg.token } : {}),
    });
    return { ok: h.ok, serverTick: h.server_tick, modVersion: h.mod_version };
  }
}
