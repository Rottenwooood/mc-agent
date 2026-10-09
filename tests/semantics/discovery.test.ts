import { describe, expect, it } from 'vitest';
import { DiscoveryGraph } from '@mc-agent/world';

describe('discovery graph (two-tier map, planning-only memory)', () => {
  it('records, dedupes by kind+label+pos, and queries near', () => {
    const g = new DiscoveryGraph(100);
    g.record({ kind: 'resource', pos: [0, 64, 0], label: 'minecraft:coal_ore', source: 'observed', observedTick: 0, confidence: 0.5 });
    g.record({ kind: 'resource', pos: [0, 64, 0], label: 'minecraft:coal_ore', source: 'observed', observedTick: 5, confidence: 0.6 });
    g.record({ kind: 'resource', pos: [40, 64, 0], label: 'minecraft:iron_ore', source: 'observed', observedTick: 5, confidence: 0.5 });
    expect(g.size).toBe(2);
    const near = g.list({ around: [0, 64, 0], radius: 10 });
    expect(near).toHaveLength(1);
    expect(near[0]!.label).toBe('minecraft:coal_ore');
  });

  it('marks entries stale past the ttl and can revalidate on approach', () => {
    const g = new DiscoveryGraph(100);
    const e = g.record({ kind: 'waypoint', pos: [1, 2, 3], label: 'base', source: 'observed', observedTick: 0, confidence: 0.8 });
    expect(g.markStaleBefore(50)).toBe(0);
    expect(g.markStaleBefore(200)).toBe(1);
    expect(g.list()[0]).toBeUndefined(); // stale hidden by default
    expect(g.list({ includeStale: true })).toHaveLength(1);
    g.revalidate(e.id, 220, true);
    expect(g.get(e.id)!.stale).toBe(false);
    g.revalidate(e.id, 300, false);
    expect(g.get(e.id)!.stale).toBe(true);
    expect(g.get(e.id)!.confidence).toBeLessThan(0.8);
  });

  it('round-trips through JSON (cross-session persistence)', () => {
    const g = new DiscoveryGraph(100);
    g.record({ kind: 'resource', pos: [5, 6, 7], label: 'minecraft:iron_ore', source: 'observed', observedTick: 9, confidence: 0.7 });
    const restored = DiscoveryGraph.fromJSON(g.toJSON());
    expect(restored.size).toBe(1);
    expect(restored.list()[0]!.pos).toEqual([5, 6, 7]);
  });
});
