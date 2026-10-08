// ControlPort over Mineflayer. Player-legal actions only; returns raw receipts and never
// judges success (that is the execution/contract engine's job, using world evidence).
// A receipt's evidence level is at most 'observed' (client-side); 'attributed' is decided
// later from server events.

import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import mcDataFactory from 'minecraft-data';
import vec3 from 'vec3';
import type { ControlPort, ControlReceipt, Vec3 } from '@mc-agent/contracts';
import { PortError } from '@mc-agent/foundation';

// Third-party plugin surfaces are dynamically attached; keep them loosely typed here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { pathfinder, Movements, goals } = pathfinderPkg as any;

const V = (p: Vec3): unknown => new (vec3 as unknown as new (x: number, y: number, z: number) => unknown)(p[0], p[1], p[2]);

export interface MineflayerOptions {
  host?: string;
  port?: number;
  username?: string;
  version?: string;
}

function accepted(level: ControlReceipt['level'], note?: string, raw?: unknown): ControlReceipt {
  const r: ControlReceipt = { accepted: true, level };
  if (note !== undefined) r.note = note;
  if (raw !== undefined) r.raw = raw;
  return r;
}

function rejected(note: string): ControlReceipt {
  return { accepted: false, level: 'sent', note };
}

export class MineflayerControlPort implements ControlPort {
  private bot: any = null;

  constructor(private readonly opts: MineflayerOptions = {}) {}

  get ready(): boolean {
    return this.bot !== null && this.bot.entity != null;
  }

  async connect(): Promise<void> {
    if (this.bot) return;
    const bot = mineflayer.createBot({
      host: this.opts.host ?? process.env.MC_HOST ?? '127.0.0.1',
      port: this.opts.port ?? Number(process.env.MC_PORT ?? 25565),
      username: this.opts.username ?? process.env.MC_USER ?? 'Bot',
      version: this.opts.version ?? process.env.MC_VERSION ?? '1.20.1',
      auth: 'offline',
      disableChatSigning: true,
    } as mineflayer.BotOptions);

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => resolve();
      bot.once('spawn', onSpawn);
      bot.once('error', (e: unknown) => reject(new PortError('CONNECT', String(e))));
      bot.once('kicked', (r: unknown) => reject(new PortError('KICKED', JSON.stringify(r))));
      bot.once('end', (r: unknown) => reject(new PortError('ENDED', String(r))));
    });

    bot.loadPlugin(pathfinder as never);
    const mcData = mcDataFactory(bot.version);
    const moves = new Movements(bot, mcData);
    // Protected movement by default: no digging/scaffolding/parkour while pathing.
    moves.canDig = false;
    moves.allow1by1towers = false;
    moves.allowParkour = false;
    moves.allowSprinting = true;
    bot.pathfinder.setMovements(moves);
    this.bot = bot;
  }

  async disconnect(): Promise<void> {
    const bot = this.bot;
    this.bot = null;
    if (bot) {
      try { bot.quit('disconnect'); } catch { /* ignore */ }
    }
  }

  private require(): any {
    if (!this.bot) throw new PortError('NOT_CONNECTED', 'bot not connected');
    return this.bot;
  }

  async goto(pos: Vec3, opts?: { range?: number; timeoutMs?: number }): Promise<ControlReceipt> {
    const bot = this.require();
    try {
      await bot.pathfinder.goto(new goals.GoalNear(pos[0], pos[1], pos[2], opts?.range ?? 1));
      return accepted('observed', 'path resolved');
    } catch (e) {
      return rejected(String((e as Error)?.message ?? e));
    }
  }

  async dig(pos: Vec3): Promise<ControlReceipt> {
    const bot = this.require();
    const block = bot.blockAt(V(pos));
    if (!block) return rejected('no block at position');
    try {
      await bot.dig(block);
      return accepted('observed', 'dig completed');
    } catch (e) {
      return rejected(String((e as Error)?.message ?? e));
    }
  }

  async place(pos: Vec3, face: Vec3, item?: string): Promise<ControlReceipt> {
    const bot = this.require();
    if (item) {
      const eq = await this.equip(item, 'hand');
      if (!eq.accepted) return eq;
    }
    const ref = bot.blockAt(V([pos[0] - face[0], pos[1] - face[1], pos[2] - face[2]]));
    if (!ref) return rejected('no reference block for face');
    try {
      await bot.placeBlock(ref, V(face));
      return accepted('observed', 'placed');
    } catch (e) {
      return rejected(String((e as Error)?.message ?? e));
    }
  }

  async use(pos: Vec3): Promise<ControlReceipt> {
    const bot = this.require();
    const block = bot.blockAt(V(pos));
    if (!block) return rejected('no block at position');
    try {
      await bot.activateBlock(block);
      return accepted('observed', 'activated');
    } catch (e) {
      return rejected(String((e as Error)?.message ?? e));
    }
  }

  async equip(item: string, destination = 'hand'): Promise<ControlReceipt> {
    const bot = this.require();
    const short = item.includes(':') ? (item.split(':')[1] ?? item) : item;
    const it = bot.registry.itemsByName[short];
    if (!it) return rejected('unknown item ' + item);
    try {
      await bot.equip(it.id, destination);
      return accepted('observed', 'equipped ' + short);
    } catch (e) {
      return rejected(String((e as Error)?.message ?? e));
    }
  }

  async craft(item: string, count: number): Promise<ControlReceipt> {
    const bot = this.require();
    const short = item.includes(':') ? (item.split(':')[1] ?? item) : item;
    const it = bot.registry.itemsByName[short];
    if (!it) return rejected('unknown item ' + item);
    try {
      const recipes = bot.recipesFor(it.id, null, count, null);
      if (!recipes.length) return rejected('no recipe / missing ingredients');
      await bot.craft(recipes[0], count, null);
      return accepted('observed', 'crafted');
    } catch (e) {
      return rejected(String((e as Error)?.message ?? e));
    }
  }

  async chat(message: string): Promise<ControlReceipt> {
    const bot = this.require();
    try {
      bot.chat(message);
      return accepted('sent', 'chat sent');
    } catch (e) {
      return rejected(String((e as Error)?.message ?? e));
    }
  }
}
