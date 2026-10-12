// ControlPort implementation over the client-controller mod: drives the local player of a real,
// open Minecraft client through the mod's local HTTP API. Only the backend changes — upper layers
// (execution / tasks / tools) are untouched.
//
// Raw receipts only; never a success judgement (that is execution + world evidence).

import type {
  AttackOptions,
  BodyState,
  ControlPort,
  ControlReceipt,
  ItemStack,
  MoveOptions,
  Vec3,
} from '@mc-agent/contracts';
import { PortError, controlConfigFromEnv, getJson, postJson, type ControlConfig } from '@mc-agent/foundation';
import type { WireAction, WireHealth } from './wire.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ClientModControlPort implements ControlPort {
  constructor(private readonly cfg: ControlConfig = controlConfigFromEnv()) {}

  private httpOpts(): { timeoutMs: number; token?: string } {
    return this.cfg.token ? { timeoutMs: this.cfg.timeoutMs, token: this.cfg.token } : { timeoutMs: this.cfg.timeoutMs };
  }

  private call(op: string, args: Record<string, unknown>): Promise<WireAction> {
    return postJson<WireAction>(this.cfg.baseUrl + '/action', { op, args }, this.httpOpts());
  }

  private async control(op: string, args: Record<string, unknown> = {}): Promise<ControlReceipt> {
    const r = await this.call(op, args);
    if (!r.ok) throw new PortError('MOD_ERROR', `${op}: ${r.error ?? 'mod error'}`);
    const receipt: ControlReceipt = { accepted: r.accepted === true, level: (r.level as ControlReceipt['level']) ?? 'sent' };
    if (r.note !== undefined) receipt.note = r.note;
    if (r.progress !== undefined) receipt.raw = r.progress;
    return receipt;
  }

  private async read<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.call(op, args);
    if (!r.ok) throw new PortError('MOD_ERROR', `${op}: ${r.error ?? 'mod error'}`);
    return r.result as T;
  }

  /** Liveness (not part of ControlPort). */
  async health(): Promise<WireHealth> {
    return getJson<WireHealth>(this.cfg.baseUrl + '/health', this.httpOpts());
  }

  // ---- lifecycle ----

  async connect(): Promise<void> {
    const deadline = Date.now() + 60000;
    let last = '';
    while (Date.now() < deadline) {
      try {
        const h = await this.health();
        if (h.in_world) return;
        last = `client not in a world (screen=${h.screen || 'none'})`;
      } catch (e) {
        last = String((e as Error)?.message ?? e);
      }
      await sleep(1000);
    }
    throw new PortError('NOT_CONNECTED', `client controller not ready: ${last}`);
  }

  async disconnect(): Promise<void> {
    // Never kick the real client; nothing to do.
  }

  async bodyState(): Promise<BodyState> {
    // A real client is joined/left by the human, not by us: report state, but never controllable.
    let connected = false;
    try {
      connected = (await this.health()).in_world === true;
    } catch {
      connected = false;
    }
    const username = process.env.MC_USER;
    return { connected, controllable: false, server: 'client-mod', ...(username ? { username } : {}) };
  }

  // ---- movement ----

  goto(pos: Vec3, opts: MoveOptions = {}): Promise<ControlReceipt> {
    return this.control('goto', {
      pos,
      ...(opts.range !== undefined ? { range: opts.range } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.allowModify !== undefined ? { allowModify: opts.allowModify } : {}),
    });
  }

  follow(entityId: string, distance: number, durationMs?: number): Promise<ControlReceipt> {
    return this.control('follow', {
      entityId: Number(entityId),
      distance,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }

  flee(entityId: string, distance: number, timeoutMs?: number): Promise<ControlReceipt> {
    return this.control('flee', {
      entityId: Number(entityId),
      distance,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  lookAt(pos: Vec3): Promise<ControlReceipt> {
    return this.control('lookAt', { pos });
  }

  wait(ticks: number): Promise<ControlReceipt> {
    return this.control('wait', { ticks });
  }

  steer(controls: string[], durationMs: number): Promise<ControlReceipt> {
    return this.control('steer', { controls, durationMs });
  }

  stopMotion(): Promise<ControlReceipt> {
    return this.control('stopMotion');
  }

  // ---- blocks ----

  dig(pos: Vec3, opts?: { breakThrough?: boolean }): Promise<ControlReceipt> {
    return this.control('dig', { pos, ...(opts?.breakThrough !== undefined ? { breakThrough: opts.breakThrough } : {}) });
  }

  place(pos: Vec3, face: Vec3, item?: string): Promise<ControlReceipt> {
    return this.control('place', { pos, face, ...(item !== undefined ? { item } : {}) });
  }

  use(pos: Vec3): Promise<ControlReceipt> {
    return this.control('use', { pos });
  }

  // ---- entities / combat ----

  attack(entityId: string, opts: AttackOptions = {}): Promise<ControlReceipt> {
    return this.control('attack', {
      entityId: Number(entityId),
      ...(opts.weapon !== undefined ? { weapon: opts.weapon } : {}),
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    });
  }

  interactEntity(entityId: string, item?: string): Promise<ControlReceipt> {
    return this.control('interactEntity', { entityId: Number(entityId), ...(item !== undefined ? { item } : {}) });
  }

  useItemOn(item: string, target: { pos?: Vec3; entityId?: string }): Promise<ControlReceipt> {
    return this.control('useItemOn', {
      item,
      ...(target.pos ? { pos: target.pos } : {}),
      ...(target.entityId ? { entityId: Number(target.entityId) } : {}),
    });
  }

  // ---- inventory ----

  equip(item: string, destination?: string): Promise<ControlReceipt> {
    return this.control('equip', { item, ...(destination !== undefined ? { destination } : {}) });
  }

  unequip(destination?: string): Promise<ControlReceipt> {
    return this.control('unequip', { ...(destination !== undefined ? { destination } : {}) });
  }

  drop(item: string, count: number): Promise<ControlReceipt> {
    return this.control('drop', { item, count });
  }

  transfer(
    item: string,
    count: number,
    opts: { from: 'inventory' | 'container'; to: 'inventory' | 'container'; pos?: Vec3 },
  ): Promise<ControlReceipt> {
    return this.control('transfer', {
      item,
      count,
      from: opts.from,
      to: opts.to,
      ...(opts.pos ? { pos: opts.pos } : {}),
    });
  }

  consume(item: string): Promise<ControlReceipt> {
    return this.control('consume', { item });
  }

  useItem(item: string, releaseMs?: number): Promise<ControlReceipt> {
    return this.control('useItem', { item, ...(releaseMs !== undefined ? { releaseMs } : {}) });
  }

  // ---- containers / production ----

  openContainer(pos: Vec3): Promise<ControlReceipt> {
    return this.control('openContainer', { pos });
  }

  closeContainer(): Promise<ControlReceipt> {
    return this.control('closeContainer');
  }

  craft(item: string, count: number, tablePos?: Vec3): Promise<ControlReceipt> {
    return this.control('craft', { item, count, ...(tablePos ? { tablePos } : {}) });
  }

  smelt(item: string, count: number, opts: { fuel?: string; pos?: Vec3 } = {}): Promise<ControlReceipt> {
    return this.control('smelt', {
      item,
      count,
      ...(opts.fuel !== undefined ? { fuel: opts.fuel } : {}),
      ...(opts.pos ? { pos: opts.pos } : {}),
    });
  }

  enchant(item: string, choice: number, pos?: Vec3): Promise<ControlReceipt> {
    return this.control('enchant', { item, choice, ...(pos ? { pos } : {}) });
  }

  anvilCombine(item1: string, item2: string, name?: string): Promise<ControlReceipt> {
    return this.control('anvilCombine', { item1, item2, ...(name !== undefined ? { name } : {}) });
  }

  trade(entityId: string, index: number, times: number): Promise<ControlReceipt> {
    return this.control('trade', { entityId: Number(entityId), index, times });
  }

  // ---- meta ----

  chat(message: string): Promise<ControlReceipt> {
    return this.control('chat', { message });
  }

  runCommand(command: string): Promise<ControlReceipt> {
    return this.control('runCommand', { command });
  }

  // ---- client-side reads (observed; never authoritative) ----

  raycast(maxDistance?: number): Promise<{ block?: { pos: Vec3; name: string }; entity?: { id: string; type: string } }> {
    return this.read('raycast', { ...(maxDistance !== undefined ? { maxDistance } : {}) });
  }

  lookupRecipe(
    item: string,
    table?: boolean,
  ): Promise<{ result: { item: string; count: number }; ingredients: { item: string; count: number }[]; requiresTable: boolean }[]> {
    return this.read('lookupRecipe', { item, ...(table !== undefined ? { table } : {}) });
  }

  worldInfo(): Promise<{ time: number; raining: boolean; dimension: string }> {
    return this.read('worldInfo');
  }

  containerContents(pos: Vec3): Promise<ItemStack[]> {
    return this.read('containerContents', { pos });
  }

  canReach(pos: Vec3, opts: MoveOptions = {}): Promise<boolean> {
    return this.read('canReach', {
      pos,
      ...(opts.range !== undefined ? { range: opts.range } : {}),
      ...(opts.allowModify !== undefined ? { allowModify: opts.allowModify } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  canSee(pos: Vec3): Promise<boolean> {
    return this.read('canSee', { pos });
  }
}
