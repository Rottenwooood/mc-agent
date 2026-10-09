// Assembly: pick adapters, build the world/execution layers and the tool registry.
// apps/agent is the ONLY place that wires concrete backends (framework §3).
//
// It also drives the local surface shell in the background (event patches + window shift +
// low-frequency fallback), so perception is fresh without the model asking for it.

import { MineflayerControlPort } from '@mc-agent/adapters-mineflayer';
import { TelemetryWorldPort } from '@mc-agent/adapters-telemetry';
import { SurfaceShell, World } from '@mc-agent/world';
import { ControlToken, ReflexShield } from '@mc-agent/execution';
import { ToolRegistry, buildTools, type ToolContext } from '@mc-agent/interfaces-mcp';
import { SkillLibrary } from '@mc-agent/knowledge';
import type { EventCursor, SeedRole } from '@mc-agent/contracts';
import { join } from 'node:path';

export interface AppContext {
  username: string;
  world: World;
  ctrl: MineflayerControlPort;
  token: ControlToken;
  reflex?: ReflexShield;
  shell: SurfaceShell;
  registry: ToolRegistry;
  toolCtx: ToolContext;
  library: SkillLibrary;
}

export interface CreateOptions {
  username?: string;
}

/** Event patches + window shift (2s) and a full low-frequency sweep (30s). */
function startMaintenance(world: World, shell: SurfaceShell): void {
  let cursor: EventCursor | undefined;
  let lastChunk = '';
  const shift = setInterval(() => {
    void (async () => {
      try {
        const self = await world.selfPos();
        if (!self) return;
        const chunk = `${Math.floor(self[0] / 16)},${Math.floor(self[2] / 16)}`;
        if (chunk !== lastChunk) {
          lastChunk = chunk;
          await shell.recenter(self);
        }
        const page = await world.events(cursor, 256);
        if (page.resetRequired) {
          cursor = page.cursor;
          await shell.refresh(self);
        } else {
          if (page.events.length > 0) await shell.applyEvents(page.events);
          cursor = page.cursor;
        }
      } catch {
        /* maintenance must never throw */
      }
    })();
  }, 2000);
  shift.unref();

  const sweep = setInterval(() => {
    void (async () => {
      try {
        const self = await world.selfPos();
        if (self) await shell.refresh(self);
      } catch {
        /* ignore */
      }
    })();
  }, 30000);
  sweep.unref();
}

export async function createContext(opts: CreateOptions = {}): Promise<AppContext> {
  const username = opts.username ?? process.env.MC_USER ?? 'Bot';
  const ctrl = new MineflayerControlPort({ username });
  await ctrl.connect();

  const world = new World(new TelemetryWorldPort(undefined, username));
  const token = new ControlToken();
  const shell = new SurfaceShell(world);
  const reflex = process.env.MCAGENT_REFLEX === '0' ? undefined : new ReflexShield(world);
  const skillsPath = process.env.MCAGENT_SKILLS ?? join(process.cwd(), '.mc-agent', 'skills.json');
  const library = SkillLibrary.open(skillsPath);
  const seed = process.env.MCAGENT_SEED
    ? { value: process.env.MCAGENT_SEED, role: (process.env.MCAGENT_SEED_ROLE as SeedRole | undefined) ?? 'train' }
    : undefined;
  const registry = new ToolRegistry();
  const toolCtx: ToolContext = { world, ctrl, token, shell, ...(reflex ? { reflex } : {}), ...(seed ? { seed } : {}) };
  for (const t of buildTools({ library })) registry.register(t);

  startMaintenance(world, shell);

  return { username, world, ctrl, token, ...(reflex ? { reflex } : {}), shell, registry, toolCtx, library };
}
