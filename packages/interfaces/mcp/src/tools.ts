// M1 tool surface: minimal, semantic, no coordinates exposed to the model.
// Full surface (general queries, bounded composition, dynamic tools, replace) arrives later.

import { isUnknown } from '@mc-agent/contracts';
import { gatherBlock, mk, pass } from '@mc-agent/execution';
import type { ToolDef } from './tool.js';

export function buildTools(): ToolDef[] {
  return [
    {
      name: 'observe',
      title: 'Observe own state, inventory and nearby entities',
      description: 'Authoritative self state, inventory contents and nearby entities (names, no coordinates).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const self = await ctx.world.status();
        const inv = await ctx.world.inventory();
        const ents = await ctx.world.entities(16);
        return pass({
          data: {
            self: isUnknown(self) ? null : self.value,
            inventory: isUnknown(inv) ? [] : inv.value.map((i) => ({ item: i.item, count: i.count })),
            entities: isUnknown(ents) ? [] : ents.value.map((e) => ({ type: e.type })),
          },
        });
      },
    },
    {
      name: 'find_block',
      title: 'Find the nearest block of a type',
      description: 'Locate the nearest block of a given id near the bot. Returns presence, distance and whether it is within reach — no coordinates.',
      inputSchema: {
        type: 'object',
        properties: { block: { type: 'string' }, radius: { type: 'integer', default: 48 } },
        required: ['block'],
        additionalProperties: false,
      },
      handler: async (ctx, args) => {
        const block = String(args.block);
        const radius = Number(args.radius ?? 48);
        const found = await ctx.world.findNearestBlock(block, radius);
        if (isUnknown(found)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
        if (!found.value) return pass({ data: { found: false, block } });
        const d = found.value.distance;
        return pass({ data: { found: true, block, distance: Number(d.toFixed(2)), in_reach: d <= 4.5 } });
      },
    },
    {
      name: 'gather_block',
      title: 'Gather a number of blocks into the inventory',
      description: 'Find, approach, mine and pick up N blocks of a type. Verified against the authoritative inventory.',
      inputSchema: {
        type: 'object',
        properties: { block: { type: 'string' }, count: { type: 'integer', default: 1 }, radius: { type: 'integer', default: 48 } },
        required: ['block'],
        additionalProperties: false,
      },
      handler: async (ctx, args) =>
        gatherBlock(ctx.world, ctx.ctrl, ctx.token, {
          block: String(args.block),
          count: Number(args.count ?? 1),
          ...(args.radius != null ? { radius: Number(args.radius) } : {}),
        }),
    },
  ];
}
