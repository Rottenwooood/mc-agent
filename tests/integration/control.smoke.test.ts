// Tool smoke — NON-LLM. Proves the control adapter connects to a real server and can send
// a low-level player action and receive a raw receipt. Passing this is NOT task completion
// (framework §12). Skips when the server is unreachable.

import { describe, expect, it } from 'vitest';
import { MineflayerControlPort } from '@mc-agent/adapters-mineflayer';
import { TelemetryWorldPort } from '@mc-agent/adapters-telemetry';

const obs = new TelemetryWorldPort();
let live = false;
try {
  live = (await obs.health()).ok;
} catch {
  live = false;
}

describe.skipIf(!live)('tool smoke: mineflayer control (connectivity only)', () => {
  it('connects, sends a low-level action, disconnects', async () => {
    const port = new MineflayerControlPort({ username: 'TestBot' });
    try {
      await port.connect();
      expect(port.ready).toBe(true);
      const r = await port.chat('mc-agent control smoke');
      expect(r.level).toBe('sent');
      expect(r.accepted).toBe(true);
    } finally {
      await port.disconnect();
    }
  });
});
