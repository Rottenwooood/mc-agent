// ControlPort over Mineflayer — the FULL player-legal primitive set across all domains.
// Returns raw receipts and never judges success (that is execution + world evidence).
// Navigation is protected by default (no terrain modification while pathing); callers may
// opt in via `allowModify`, which is the same switch as "allowed to scaffold".

import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import mcDataFactory from 'minecraft-data';
import vec3 from 'vec3';
import type { AttackOptions, ControlPort, ControlReceipt, ItemStack, MoveOptions, Vec3 } from '@mc-agent/contracts';
import { PortError } from '@mc-agent/foundation';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { pathfinder, Movements, goals } = pathfinderPkg as any;
const V = (p: Vec3): any => new (vec3 as any)(p[0], p[1], p[2]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bound a single client operation so a stuck action cannot hold the body. */
const OP_TIMEOUT_MS = 8000;
const race = <T>(p: Promise<T>, label: string, ms = OP_TIMEOUT_MS): Promise<T> =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(label + ' timeout'))) as Promise<T>]);

export interface MineflayerOptions {
  host?: string;
  port?: number;
  username?: string;
  version?: string;
}

const ok = (level: ControlReceipt['level'], note?: string, raw?: unknown): ControlReceipt => {
  const r: ControlReceipt = { accepted: true, level };
  if (note !== undefined) r.note = note;
  if (raw !== undefined) r.raw = raw;
  return r;
};
const no = (note: string): ControlReceipt => ({ accepted: false, level: 'sent', note });

function short(item: string): string {
  return item.includes(':') ? (item.split(':')[1] ?? item) : item;
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
      bot.once('spawn', () => resolve());
      bot.once('error', (e: unknown) => reject(new PortError('CONNECT', String(e))));
      bot.once('kicked', (r: unknown) => reject(new PortError('KICKED', JSON.stringify(r))));
      bot.once('end', (r: unknown) => reject(new PortError('ENDED', String(r))));
    });

    bot.loadPlugin(pathfinder);
    this.setMovements(bot, false);
    this.bot = bot;
  }

  private setMovements(bot: any, allowModify: boolean): void {
    const mcData = mcDataFactory(bot.version);
    const moves = new Movements(bot, mcData);
    moves.canDig = allowModify;
    moves.allow1by1towers = allowModify;
    moves.allowParkour = false;
    moves.allowSprinting = true;
    bot.pathfinder.setMovements(moves);
  }

  async disconnect(): Promise<void> {
    const bot = this.bot;
    this.bot = null;
    if (bot) {
      try { bot.quit('disconnect'); } catch { /* ignore */ }
    }
  }

  private b(): any {
    if (!this.bot) throw new PortError('NOT_CONNECTED', 'bot not connected');
    return this.bot;
  }

  private itemId(item: string): unknown | null {
    const it = this.b().registry.itemsByName[short(item)];
    return it ? it.id : null;
  }

  // ---- movement ----

  async goto(pos: Vec3, opts: MoveOptions = {}): Promise<ControlReceipt> {
    const bot = this.b();
    this.setMovements(bot, opts.allowModify === true);
    const range = opts.range ?? 1;
    const timeoutMs = opts.timeoutMs ?? 12000;
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(pos[0], pos[1], pos[2], range)),
        sleep(timeoutMs).then(() => Promise.reject(new Error('goto timeout'))),
      ]);
      return ok('observed', 'path resolved');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async follow(entityId: string, distance: number, durationMs = 5000): Promise<ControlReceipt> {
    const bot = this.b();
    const e = bot.entities[Number(entityId)];
    if (!e) return no('entity not found');
    try {
      bot.pathfinder.setGoal(new goals.GoalFollow(e, distance), true);
      await sleep(durationMs);
      bot.pathfinder.stop();
      return ok('observed', 'followed');
    } catch (err) {
      return no(String((err as Error)?.message ?? err));
    }
  }

  async flee(entityId: string, distance: number, timeoutMs = 15000): Promise<ControlReceipt> {
    const bot = this.b();
    const e = bot.entities[Number(entityId)];
    if (!e) return no('entity not found');
    const dx = bot.entity.position.x - e.position.x;
    const dz = bot.entity.position.z - e.position.z;
    const len = Math.max(0.001, Math.hypot(dx, dz));
    const gx = Math.round(bot.entity.position.x + (dx / len) * distance);
    const gz = Math.round(bot.entity.position.z + (dz / len) * distance);
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalXZ(gx, gz)),
        sleep(timeoutMs).then(() => Promise.reject(new Error('flee timeout'))),
      ]);
      return ok('observed', 'fled');
    } catch (err) {
      return no(String((err as Error)?.message ?? err));
    }
  }

  async lookAt(pos: Vec3): Promise<ControlReceipt> {
    try {
      await race(this.b().lookAt(V(pos), true), 'look_at');
      return ok('observed', 'looked');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async wait(ticks: number): Promise<ControlReceipt> {
    try {
      await this.b().waitForTicks(Math.max(0, Math.floor(ticks)));
      return ok('observed', 'waited');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async steer(controls: string[], durationMs: number): Promise<ControlReceipt> {
    const bot = this.b();
    const set = new Set(controls);
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
      try { bot.setControlState(c, set.has(c)); } catch { /* ignore */ }
    }
    await sleep(durationMs);
    try { bot.clearControlStates(); } catch { /* ignore */ }
    return ok('observed', 'steered');
  }

  async stopMotion(): Promise<ControlReceipt> {
    const bot = this.b();
    try { bot.pathfinder.stop(); } catch { /* ignore */ }
    try { bot.clearControlStates(); } catch { /* ignore */ }
    try { bot.deactivateItem(); } catch { /* ignore */ }
    return ok('observed', 'motion stopped');
  }

  // ---- blocks ----

  async dig(pos: Vec3): Promise<ControlReceipt> {
    const bot = this.b();
    const block = bot.blockAt(V(pos));
    if (!block) return no('no block at position');
    try {
      // Tool-requiring blocks drop nothing without the right tool; equip the best available.
      const tool = bot.pathfinder?.bestHarvestTool ? bot.pathfinder.bestHarvestTool(block) : null;
      if (tool && tool.name) {
        await this.equip(tool.name, 'hand');
      }
      await race(bot.dig(block), 'dig');
      return ok('observed', 'dig completed');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async place(pos: Vec3, face: Vec3, item?: string): Promise<ControlReceipt> {
    const bot = this.b();
    if (item) {
      const eq = await this.equip(item, 'hand');
      if (!eq.accepted) return eq;
    }
    const ref = bot.blockAt(V([pos[0] - face[0], pos[1] - face[1], pos[2] - face[2]]));
    if (!ref) return no('no reference block for face');
    try {
      await race(bot.placeBlock(ref, V(face)), 'place');
      return ok('observed', 'placed');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async use(pos: Vec3): Promise<ControlReceipt> {
    const bot = this.b();
    const block = bot.blockAt(V(pos));
    if (!block) return no('no block at position');
    try {
      await race(bot.activateBlock(block), 'use');
      return ok('observed', 'activated');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  // ---- entities / combat ----

  async attack(entityId: string, opts: AttackOptions = {}): Promise<ControlReceipt> {
    const bot = this.b();
    if (opts.weapon) {
      const eq = await this.equip(opts.weapon, 'hand');
      if (!eq.accepted) return eq;
    }
    const e = bot.entities[Number(entityId)];
    if (!e) return no('entity not found');
    const deadline = Date.now() + (opts.durationMs ?? 5000);
    while (Date.now() < deadline) {
      const cur = bot.entities[Number(entityId)];
      if (!cur) break;
      try { bot.attack(cur); } catch { /* ignore */ }
      await sleep(600);
    }
    return ok('observed', 'attacked');
  }

  async interactEntity(entityId: string, item?: string): Promise<ControlReceipt> {
    const bot = this.b();
    const e = bot.entities[Number(entityId)];
    if (!e) return no('entity not found');
    try {
      if (item) {
        const eq = await this.equip(item, 'hand');
        if (!eq.accepted) return eq;
        await race(bot.useOn(e), 'use_on');
      } else {
        await race(bot.activateEntity(e), 'interact_entity');
      }
      return ok('observed', 'interacted');
    } catch (err) {
      return no(String((err as Error)?.message ?? err));
    }
  }

  async useItemOn(item: string, target: { pos?: Vec3; entityId?: string }): Promise<ControlReceipt> {
    const bot = this.b();
    const eq = await this.equip(item, 'hand');
    if (!eq.accepted) return eq;
    try {
      if (target.entityId) {
        const e = bot.entities[Number(target.entityId)];
        if (!e) return no('entity not found');
        await race(bot.useOn(e), 'use_item_on_entity');
      } else if (target.pos) {
        const block = bot.blockAt(V(target.pos));
        if (!block) return no('no block at position');
        await race(bot.activateBlock(block), 'use_item_on_block');
      } else {
        return no('missing target');
      }
      return ok('observed', 'used item');
    } catch (err) {
      return no(String((err as Error)?.message ?? err));
    }
  }

  // ---- inventory ----

  async equip(item: string, destination = 'hand'): Promise<ControlReceipt> {
    const id = this.itemId(item);
    if (id == null) return no('unknown item ' + item);
    const bot = this.b();
    const name = short(item);
    // Already holding it: mineflayer's equip never resolves in this case.
    if (destination === 'hand' && bot.heldItem && (bot.heldItem.name === name || bot.heldItem.type === id)) {
      return ok('observed', 'already equipped ' + name);
    }
    // Item sitting in the quick bar: just change the selection (synchronous, avoids window clicks).
    const QUICK_BAR_START = 36;
    const found = bot.inventory?.findInventoryItem?.(id as number);
    if (destination === 'hand' && found && found.slot >= QUICK_BAR_START && found.slot < QUICK_BAR_START + 9) {
      bot.setQuickBarSlot(found.slot - QUICK_BAR_START);
      return ok('observed', 'equipped ' + name);
    }
    try {
      await race(bot.equip(id, destination), 'equip');
      return ok('observed', 'equipped ' + name);
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async unequip(destination = 'hand'): Promise<ControlReceipt> {
    try {
      await race(this.b().unequip(destination), 'unequip');
      return ok('observed', 'unequipped');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async drop(item: string, count: number): Promise<ControlReceipt> {
    const id = this.itemId(item);
    if (id == null) return no('unknown item ' + item);
    try {
      await race(this.b().toss(id, null, Math.max(1, count)), 'drop');
      return ok('observed', 'dropped');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async transfer(item: string, count: number, opts: { from: 'inventory' | 'container'; to: 'inventory' | 'container'; pos?: Vec3 }): Promise<ControlReceipt> {
    const bot = this.b();
    const id = this.itemId(item);
    if (id == null) return no('unknown item ' + item);
    if (!opts.pos) return no('transfer needs container position');
    let win: any;
    try {
      win = await bot.openContainer(bot.blockAt(V(opts.pos)));
      if (opts.from === 'inventory' && opts.to === 'container') await race(win.deposit(id, null, count), 'transfer_deposit');
      else if (opts.from === 'container' && opts.to === 'inventory') await race(win.withdraw(id, null, count), 'transfer_withdraw');
      else return no('invalid direction');
      return ok('observed', 'transferred');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    } finally {
      try { if (win) await win.close(); } catch { /* ignore */ }
    }
  }

  async consume(item: string): Promise<ControlReceipt> {
    const eq = await this.equip(item, 'hand');
    if (!eq.accepted) return eq;
    try {
      await race(this.b().consume(), 'consume');
      return ok('observed', 'consumed');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async useItem(item: string, releaseMs = 1000): Promise<ControlReceipt> {
    const eq = await this.equip(item, 'hand');
    if (!eq.accepted) return eq;
    const bot = this.b();
    try {
      bot.activateItem();
      await sleep(releaseMs);
      bot.deactivateItem();
      return ok('observed', 'used item');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  // ---- containers / production ----

  async openContainer(pos: Vec3): Promise<ControlReceipt> {
    const bot = this.b();
    const block = bot.blockAt(V(pos));
    if (!block) return no('no block at position');
    try {
      await race(bot.openContainer(block), 'open_container');
      return ok('observed', 'opened');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async closeContainer(): Promise<ControlReceipt> {
    const bot = this.b();
    if (!bot.currentWindow) return ok('observed', 'no window');
    try {
      await race(bot.closeWindow(bot.currentWindow), 'close_container');
      return ok('observed', 'closed');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async craft(item: string, count: number, tablePos?: Vec3): Promise<ControlReceipt> {
    const bot = this.b();
    const id = this.itemId(item);
    if (id == null) return no('unknown item ' + item);
    const table = tablePos ? bot.blockAt(V(tablePos)) : null;
    try {
      const recipes = bot.recipesFor(id, null, count, table);
      if (!recipes.length) return no('no recipe / missing ingredients');
      await race(bot.craft(recipes[0], count, table), 'craft', 30000);
      return ok('observed', 'crafted');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async smelt(item: string, count: number, opts: { fuel?: string; pos?: Vec3 } = {}): Promise<ControlReceipt> {
    const bot = this.b();
    const id = this.itemId(item);
    if (id == null) return no('unknown item ' + item);
    const block = opts.pos ? bot.blockAt(V(opts.pos)) : bot.findBlock({ matching: bot.registry.blocksByName.furnace?.id, maxDistance: 8 });
    if (!block) return no('no furnace');
    let win: any;
    try {
      win = await bot.openFurnace(block);
      await win.putInput(id, null, count);
      if (opts.fuel) {
        const fuel = this.itemId(opts.fuel);
        if (fuel != null) await win.putFuel(fuel, null, 1);
      }
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (win.outputItem()) break;
      }
      await win.takeOutput();
      return ok('observed', 'smelted');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    } finally {
      try { if (win) await win.close(); } catch { /* ignore */ }
    }
  }

  async enchant(item: string, choice: number, pos?: Vec3): Promise<ControlReceipt> {
    const bot = this.b();
    const id = this.itemId(item);
    if (id == null) return no('unknown item ' + item);
    const block = pos ? bot.blockAt(V(pos)) : bot.findBlock({ matching: bot.registry.blocksByName.enchanting_table?.id, maxDistance: 8 });
    if (!block) return no('no enchanting table');
    let win: any;
    try {
      win = await bot.openEnchantmentTable(block);
      await race(win.putTargetItem(id), 'enchant_put');
      await race(win.enchant(choice), 'enchant');
      await sleep(500);
      await race(win.takeTargetItem(), 'enchant_take');
      return ok('observed', 'enchanted');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    } finally {
      try { if (win) await win.close(); } catch { /* ignore */ }
    }
  }

  async anvilCombine(item1: string, item2: string, name?: string): Promise<ControlReceipt> {
    const bot = this.b();
    const a = this.itemId(item1);
    const b = this.itemId(item2);
    if (a == null || b == null) return no('unknown item');
    const block = bot.findBlock({ matching: bot.registry.blocksByName.anvil?.id, maxDistance: 8 });
    if (!block) return no('no anvil');
    let win: any;
    try {
      win = await bot.openAnvil(block);
      await race(win.combine(a, b, name), 'anvil');
      return ok('observed', 'combined');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    } finally {
      try { if (win) await win.close(); } catch { /* ignore */ }
    }
  }

  async trade(entityId: string, index: number, times: number): Promise<ControlReceipt> {
    const bot = this.b();
    const e = bot.entities[Number(entityId)];
    if (!e) return no('entity not found');
    try {
      const villager = await bot.openVillager(e);
      await race(bot.trade(villager, index, times), 'trade', 30000);
      return ok('observed', 'traded');
    } catch (err) {
      return no(String((err as Error)?.message ?? err));
    }
  }

  // ---- meta ----

  async chat(message: string): Promise<ControlReceipt> {
    try {
      this.b().chat(message);
      return ok('sent', 'chat sent');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  async runCommand(command: string): Promise<ControlReceipt> {
    const cmd = command.startsWith('/') ? command : '/' + command;
    try {
      this.b().chat(cmd);
      return ok('sent', 'command sent');
    } catch (e) {
      return no(String((e as Error)?.message ?? e));
    }
  }

  // ---- client-side reads ----

  async raycast(maxDistance = 5): Promise<{ block?: { pos: Vec3; name: string }; entity?: { id: string; type: string } }> {
    const bot = this.b();
    const b = bot.blockAtCursor(maxDistance);
    const e = bot.entityAtCursor(maxDistance);
    const out: { block?: { pos: Vec3; name: string }; entity?: { id: string; type: string } } = {};
    if (b) out.block = { pos: [b.position.x, b.position.y, b.position.z], name: b.name };
    if (e) out.entity = { id: String(e.id), type: e.name ?? 'unknown' };
    return out;
  }

  async lookupRecipe(item: string, table = false): Promise<{ result: { item: string; count: number }; ingredients: { item: string; count: number }[]; requiresTable: boolean }[]> {
    const bot = this.b();
    const id = this.itemId(item);
    if (id == null) return [];
    const recipes = bot.recipesAll(id, null, table ? true : null);
    return recipes.map((r: any) => ({
      result: { item: 'minecraft:' + (bot.registry.items[r.result.id]?.name ?? r.result.id), count: r.result.count },
      ingredients: (r.ingredients ?? []).map((i: any) => ({ item: 'minecraft:' + (bot.registry.items[i.id]?.name ?? i.id), count: i.count })),
      requiresTable: !!r.requiresTable,
    }));
  }

  async worldInfo(): Promise<{ time: number; raining: boolean; dimension: string }> {
    const bot = this.b();
    return { time: bot.time.timeOfDay, raining: bot.isRaining, dimension: bot.game.dimension };
  }

  async containerContents(pos: Vec3): Promise<ItemStack[]> {
    const bot = this.b();
    const block = bot.blockAt(V(pos));
    if (!block) return [];
    let win: any;
    try {
      win = await bot.openContainer(block);
      return win.containerItems().map((i: any) => ({ slot: i.slot, item: 'minecraft:' + i.name, count: i.count }));
    } finally {
      try { if (win) await win.close(); } catch { /* ignore */ }
    }
  }

  async canReach(pos: Vec3, opts: MoveOptions = {}): Promise<boolean> {
    const bot = this.b();
    this.setMovements(bot, opts.allowModify === true);
    try {
      const res = bot.pathfinder.getPathTo(
        bot.pathfinder.movements,
        new goals.GoalNear(pos[0], pos[1], pos[2], opts.range ?? 1),
        opts.timeoutMs ?? 5000,
      );
      return res.status === 'success';
    } catch {
      return false;
    }
  }

  async canSee(pos: Vec3): Promise<boolean> {
    const bot = this.b();
    try {
      const target = bot.blockAt(V(pos));
      if (!target) return false;
      return bot.canSeeBlock(target);
    } catch {
      return false;
    }
  }
}
