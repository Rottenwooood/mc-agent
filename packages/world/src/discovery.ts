// Persistent sparse discovery graph (world-map-and-composition §5) — the second tier of the
// two-tier map. Low frequency, explicitly marked as memory that may be stale, used for
// PLANNING only. It is never a postcondition-evidence source: the local surface shell (and
// the authoritative world ports) are. Revalidate on approach.

import type { Vec3 } from '@mc-agent/contracts';

export type DiscoveryKind = 'resource' | 'structure' | 'waypoint' | 'terrain';

export interface DiscoveryEntry {
  id: string;
  kind: DiscoveryKind;
  pos: Vec3;
  /** e.g. a block id for a resource point, or a free note for a waypoint. */
  label: string;
  source: 'observed' | 'inferred';
  observedTick: number;
  /** 0..1 */
  confidence: number;
  stale: boolean;
}

export interface DiscoveryQuery {
  kind?: DiscoveryKind;
  around?: Vec3;
  radius?: number;
  includeStale?: boolean;
}

export interface DiscoveryGraphJSON {
  ttlTicks: number;
  entries: DiscoveryEntry[];
}

function distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class DiscoveryGraph {
  private readonly entries = new Map<string, DiscoveryEntry>();

  constructor(private ttlTicks = 20 * 60 * 5) {}

  get size(): number {
    return this.entries.size;
  }

  /** Idempotent upsert keyed by kind+label+position; refreshes freshness. */
  record(e: Omit<DiscoveryEntry, 'id' | 'stale'> & { id?: string }): DiscoveryEntry {
    const id = e.id ?? `${e.kind}:${e.label}:${e.pos[0]},${e.pos[1]},${e.pos[2]}`;
    const entry: DiscoveryEntry = {
      id,
      kind: e.kind,
      pos: e.pos,
      label: e.label,
      source: e.source,
      observedTick: e.observedTick,
      confidence: e.confidence,
      stale: false,
    };
    this.entries.set(id, entry);
    return entry;
  }

  get(id: string): DiscoveryEntry | undefined {
    return this.entries.get(id);
  }

  list(q: DiscoveryQuery = {}): DiscoveryEntry[] {
    const out: DiscoveryEntry[] = [];
    for (const e of this.entries.values()) {
      if (q.kind && e.kind !== q.kind) continue;
      if (!q.includeStale && e.stale) continue;
      if (q.around && q.radius !== undefined && distance(q.around, e.pos) > q.radius) continue;
      out.push(e);
    }
    if (q.around) out.sort((a, b) => distance(q.around!, a.pos) - distance(q.around!, b.pos));
    return out;
  }

  /** Mark entries not seen since `now - ttl` as stale (call on a low-frequency sweep). */
  markStaleBefore(now: number): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (!e.stale && now - e.observedTick > this.ttlTicks) {
        e.stale = true;
        n += 1;
      }
    }
    return n;
  }

  /** Re-check an entry on approach; refresh freshness and drop confidence when it is gone. */
  revalidate(id: string, now: number, stillThere: boolean): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (stillThere) {
      e.observedTick = now;
      e.stale = false;
      e.confidence = Math.min(1, e.confidence + 0.1);
    } else {
      e.stale = true;
      e.confidence = Math.max(0, e.confidence - 0.4);
    }
  }

  forget(id: string): boolean {
    return this.entries.delete(id);
  }

  toJSON(): DiscoveryGraphJSON {
    return { ttlTicks: this.ttlTicks, entries: [...this.entries.values()] };
  }

  static fromJSON(data: DiscoveryGraphJSON): DiscoveryGraph {
    const g = new DiscoveryGraph(data.ttlTicks);
    for (const e of data.entries) g.entries.set(e.id, { ...e, pos: [...e.pos] as Vec3 });
    return g;
  }
}
