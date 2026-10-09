import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClientModControlPort } from '@mc-agent/adapters-client-mod';

/**
 * The client-controller mod speaks a tiny local HTTP contract (docs/client-controller.md §4).
 * These tests stand up a mock of that contract and assert the adapter builds the right requests
 * and parses receipts / results / errors. No real Minecraft client is involved.
 */

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

type Responder = (op: string, args: Record<string, unknown>) => { status?: number; body: unknown };

let server: http.Server;
let baseUrl: string;
let recorded: Recorded[];
let responder: Responder;
let healthInWorld: boolean;

beforeEach(async () => {
  recorded = [];
  healthInWorld = true;
  responder = () => ({ body: { ok: true, accepted: true, level: 'observed' } });
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      recorded.push({ method: req.method ?? '', path: req.url ?? '', body });
      if ((req.url ?? '').startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            mc: '1.20.1',
            mod_version: '0.1.0',
            in_world: healthInWorld,
            player: 'Bot',
            dimension: 'minecraft:overworld',
            screen: healthInWorld ? '' : 'TitleScreen',
            port: 8766,
          }),
        );
        return;
      }
      const { op, args } = body as { op: string; args: Record<string, unknown> };
      const r = responder(op, args);
      res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const port = (): ClientModControlPort => new ClientModControlPort({ baseUrl, timeoutMs: 5000 });

describe('ClientModControlPort request construction', () => {
  it('maps movement primitives to ops with the right args', async () => {
    const c = port();
    await c.goto([10, 64, -3], { range: 2, allowModify: false });
    await c.lookAt([1, 2, 3]);
    await c.wait(40);
    await c.steer(['forward', 'jump'], 500);
    await c.stopMotion();
    await c.follow('42', 3, 1000);
    await c.flee('42', 8);

    expect(recorded.map((r) => (r.body as { op: string }).op)).toEqual([
      'goto',
      'lookAt',
      'wait',
      'steer',
      'stopMotion',
      'follow',
      'flee',
    ]);
    const goto = recorded[0].body as { args: Record<string, unknown> };
    expect(goto.args).toMatchObject({ pos: [10, 64, -3], range: 2, allowModify: false });
    const follow = recorded[5].body as { args: Record<string, unknown> };
    expect(follow.args).toMatchObject({ entityId: 42, distance: 3, durationMs: 1000 });
  });

  it('maps block/entity/inventory primitives', async () => {
    const c = port();
    await c.dig([1, 2, 3]);
    await c.place([1, 2, 3], [0, 1, 0], 'minecraft:oak_planks');
    await c.use([1, 2, 3]);
    await c.attack('7', { weapon: 'minecraft:iron_sword', durationMs: 2000 });
    await c.interactEntity('7', 'minecraft:wheat');
    await c.useItemOn('minecraft:bone_meal', { pos: [1, 2, 3] });
    await c.equip('minecraft:iron_pickaxe', 'hand');
    await c.drop('minecraft:dirt', 4);
    await c.transfer('minecraft:coal', 8, { from: 'inventory', to: 'container', pos: [1, 2, 3] });

    const byOp = (op: string) => (recorded.find((r) => (r.body as { op: string }).op === op)?.body as { args: Record<string, unknown> }).args;
    expect(byOp('dig')).toEqual({ pos: [1, 2, 3] });
    expect(byOp('place')).toMatchObject({ pos: [1, 2, 3], face: [0, 1, 0], item: 'minecraft:oak_planks' });
    expect(byOp('attack')).toMatchObject({ entityId: 7, weapon: 'minecraft:iron_sword', durationMs: 2000 });
    expect(byOp('transfer')).toMatchObject({ item: 'minecraft:coal', count: 8, from: 'inventory', to: 'container', pos: [1, 2, 3] });
  });

  it('maps production primitives', async () => {
    const c = port();
    await c.craft('minecraft:stick', 4, [5, 6, 7]);
    await c.smelt('minecraft:iron_ingot', 2, { fuel: 'minecraft:coal', pos: [1, 2, 3] });
    await c.enchant('minecraft:diamond_sword', 1);
    await c.anvilCombine('minecraft:diamond_sword', 'minecraft:diamond', 'Blade');
    await c.trade('9', 0, 3);

    const byOp = (op: string) => (recorded.find((r) => (r.body as { op: string }).op === op)?.body as { args: Record<string, unknown> }).args;
    expect(byOp('craft')).toMatchObject({ item: 'minecraft:stick', count: 4, tablePos: [5, 6, 7] });
    expect(byOp('smelt')).toMatchObject({ item: 'minecraft:iron_ingot', count: 2, fuel: 'minecraft:coal' });
    expect(byOp('anvilCombine')).toMatchObject({ item1: 'minecraft:diamond_sword', item2: 'minecraft:diamond', name: 'Blade' });
    expect(byOp('trade')).toMatchObject({ entityId: 9, index: 0, times: 3 });
  });
});

describe('ClientModControlPort response handling', () => {
  it('returns a raw receipt and never invents success', async () => {
    responder = () => ({ body: { ok: true, accepted: false, level: 'sent', note: 'busy: goto' } });
    const r = await port().dig([1, 2, 3]);
    expect(r.accepted).toBe(false);
    expect(r.level).toBe('sent');
    expect(r.note).toBe('busy: goto');
  });

  it('parses read results', async () => {
    responder = (op) => {
      if (op === 'worldInfo') return { body: { ok: true, result: { time: 1000, raining: false, dimension: 'minecraft:overworld' } } };
      if (op === 'canSee') return { body: { ok: true, result: true } };
      if (op === 'raycast') return { body: { ok: true, result: { block: { pos: [1, 2, 3], name: 'minecraft:stone' } } } };
      return { body: { ok: true, result: [] } };
    };
    const c = port();
    expect(await c.worldInfo()).toEqual({ time: 1000, raining: false, dimension: 'minecraft:overworld' });
    expect(await c.canSee([1, 2, 3])).toBe(true);
    expect((await c.raycast(6)).block?.name).toBe('minecraft:stone');
  });

  it('throws on a mod error envelope', async () => {
    responder = () => ({ body: { ok: false, error: 'unknown op: nope' } });
    await expect(port().dig([1, 2, 3])).rejects.toThrow(/unknown op/);
  });

  it('connect() waits until the client is in a world', async () => {
    healthInWorld = false;
    const c = port();
    const pending = c.connect();
    setTimeout(() => {
      healthInWorld = true;
    }, 1100);
    await expect(pending).resolves.toBeUndefined();
  });
});
