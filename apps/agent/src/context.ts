// Assembly: pick adapters, build the world/execution layers and the tool registry.
// apps/agent is the ONLY place that wires concrete backends (framework §3).

import { MineflayerControlPort } from '@mc-agent/adapters-mineflayer';
import { TelemetryWorldPort } from '@mc-agent/adapters-telemetry';
import { World } from '@mc-agent/world';
import { ControlToken } from '@mc-agent/execution';
import { ToolRegistry, buildTools, type ToolContext } from '@mc-agent/interfaces-mcp';

export interface AppContext {
  username: string;
  world: World;
  ctrl: MineflayerControlPort;
  token: ControlToken;
  registry: ToolRegistry;
  toolCtx: ToolContext;
}

export interface CreateOptions {
  username?: string;
}

export async function createContext(opts: CreateOptions = {}): Promise<AppContext> {
  const username = opts.username ?? process.env.MC_USER ?? 'Bot';
  const ctrl = new MineflayerControlPort({ username });
  await ctrl.connect();

  const world = new World(new TelemetryWorldPort(undefined, username));
  const token = new ControlToken();
  const registry = new ToolRegistry();
  const toolCtx: ToolContext = { world, ctrl, token };
  for (const t of buildTools()) registry.register(t);

  return { username, world, ctrl, token, registry, toolCtx };
}
