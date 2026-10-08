// Tool smoke — NON-LLM. It only proves the observation tools connect to a real running
// server and return structurally valid data. Passing this is NOT task completion and must
// never be reported as such (framework §12).
//
// Skips automatically when the observer endpoint is unreachable.

import { describe, expect, it } from 'vitest';
import { isUnknown } from '@mc-agent/contracts';
import { TelemetryWorldPort } from '@mc-agent/adapters-telemetry';

const port = new TelemetryWorldPort();
let live = false;
try {
  live = (await port.health()).ok;
} catch {
  live = false;
}

describe.skipIf(!live)('tool smoke: telemetry over real server (connectivity/structure only)', () => {
  it('health reports a mod version and tick', async () => {
    const h = await port.health();
    expect(h.ok).toBe(true);
    expect(typeof h.serverTick).toBe('number');
    expect(h.modVersion.length).toBeGreaterThan(0);
  });

  it('status resolves to a fact or an explicit unknown', async () => {
    const s = await port.status();
    if (!isUnknown(s)) {
      expect(s.source).toBe('authoritative');
      expect(typeof s.observedTick).toBe('number');
    } else {
      expect(s.reason.length).toBeGreaterThan(0);
    }
  });

  it('query returns authoritative blocks with coverage', async () => {
    const r = await port.query({ min: [-4, 50, -4], max: [4, 90, 4] });
    if (!isUnknown(r)) {
      expect(r.source).toBe('authoritative');
      expect(Array.isArray(r.value)).toBe(true);
      expect(typeof r.coverage.loaded).toBe('boolean');
    } else {
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('events returns an (epoch, seq) cursor', async () => {
    const e = await port.events();
    expect(typeof e.cursor.epoch).toBe('number');
    expect(typeof e.cursor.seq).toBe('number');
    expect(Array.isArray(e.events)).toBe(true);
  });
});
