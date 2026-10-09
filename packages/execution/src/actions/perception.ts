// Perception atomic actions. Read-only; authoritative facts come from World, client-only
// reads (raycast/recipes/world info/container contents) are labelled observed.

import type { ActionResult, Match, Target, Vec3 } from '@mc-agent/contracts';
import { isUnknown } from '@mc-agent/contracts';
import { distance, isHazardous, type DiscoveryKind } from '@mc-agent/world';
import { mk, pass, fail } from '../result.js';
import type { AtomicAction } from './types.js';
import { contract } from './types.js';
import { resolveTarget } from './target.js';

const observe: AtomicAction = {
  contract: contract({
    name: 'observe',
    description: 'Authoritative self state, inventory and nearby entities (names; no action coordinates).',
    params: { type: 'object', properties: {}, additionalProperties: false },
  }),
  async run(ctx): Promise<ActionResult> {
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
};

const getSelfStatus: AtomicAction = {
  contract: contract({
    name: 'get_self_status',
    description: 'Authoritative self position, health, food, dimension, on-ground.',
    params: { type: 'object', properties: {}, additionalProperties: false },
  }),
  async run(ctx): Promise<ActionResult> {
    const s = await ctx.world.status();
    return isUnknown(s) ? mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' }) : pass({ data: s.value });
  },
};

const getInventory: AtomicAction = {
  contract: contract({
    name: 'get_inventory',
    description: 'Authoritative inventory contents {item,count}.',
    params: { type: 'object', properties: {}, additionalProperties: false },
  }),
  async run(ctx): Promise<ActionResult> {
    const inv = await ctx.world.inventory();
    return isUnknown(inv) ? mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' }) : pass({ data: inv.value.map((i) => ({ item: i.item, count: i.count })) });
  },
};

const scanBlocks: AtomicAction = {
  contract: contract({
    name: 'scan_blocks',
    description: 'Non-air blocks in a bounded region around the bot (or a given centre), optionally filtered by block id. Positions are read-only info.',
    params: { type: 'object', properties: { radius: { type: 'integer', default: 8 }, around: { type: 'array', items: { type: 'integer' } }, filter_block: { type: 'string' }, limit: { type: 'integer', default: 256 } }, additionalProperties: false },
  }),
  async run(ctx, args): Promise<ActionResult> {
    const radius = Number(args.radius ?? 8);
    const center = (Array.isArray(args.around) ? (args.around as Vec3) : undefined) ?? (await ctx.world.selfPos());
    if (!center) return fail('precondition_failed', { reasonDetail: 'no centre' });
    const box = {
      min: [center[0] - radius, center[1] - radius, center[2] - radius] as Vec3,
      max: [center[0] + radius, center[1] + radius, center[2] + radius] as Vec3,
    };
    const r = await ctx.world.query(box);
    if (isUnknown(r)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
    const filter = args.filter_block != null ? String(args.filter_block) : undefined;
    const limit = Number(args.limit ?? 256);
    const cells = filter ? r.value.filter((c) => c.block === filter) : r.value;
    const blocks = cells.slice(0, limit).map((c) => ({ pos: c.pos, block: c.block }));
    return pass({ data: { count: cells.length, blocks, truncated: cells.length > blocks.length } });
  },
};

const scanEntities: AtomicAction = {
  contract: contract({
    name: 'scan_entities',
    description: 'Nearby entities (observed), optionally filtered by type substring, with distance from the bot.',
    params: { type: 'object', properties: { radius: { type: 'number', default: 24 }, types: { type: 'string' }, limit: { type: 'integer', default: 64 } }, additionalProperties: false },
  }),
  async run(ctx, args): Promise<ActionResult> {
    const r = await ctx.world.entities(Number(args.radius ?? 24));
    if (isUnknown(r)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
    const self = await ctx.world.selfPos();
    const filters = String(args.types ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const limit = Number(args.limit ?? 64);
    const found = r.value
      .filter((e) => !filters.length || filters.some((f) => e.type.includes(f)))
      .map((e) => ({ id: e.id, type: e.type, distance: self ? Number(distance(self, e.pos).toFixed(2)) : null }))
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
      .slice(0, limit);
    return pass({ data: { count: found.length, entities: found }, evidence: [{ claim: 'scan_entities', source: 'authoritative' }] });
  },
};

const findNearest: AtomicAction = {
  contract: contract({
    name: 'find_nearest',
    description: 'Nearest block of an id, or nearest entity of a type, near the bot. Returns presence/distance, no action coordinates.',
    params: { type: 'object', properties: { kind: { type: 'string', enum: ['block', 'entity'], default: 'block' }, block: { type: 'string' }, entity: { type: 'string' }, within: { type: 'integer', default: 48 } }, additionalProperties: false },
  }),
  async run(ctx, args): Promise<ActionResult> {
    const kind = String(args.kind ?? 'block');
    const within = Number(args.within ?? 48);
    if (kind === 'block') {
      const block = String(args.block ?? '');
      const r = await ctx.world.findNearestBlock(block, within);
      if (isUnknown(r)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
      if (!r.value) return pass({ data: { found: false, block } });
      // Remember it in the (planning-only) discovery map.
      ctx.world.discoveries.record({
        kind: 'resource',
        pos: r.value.pos,
        label: block,
        source: 'observed',
        observedTick: r.observedTick,
        confidence: 0.6,
      });
      return pass({ data: { found: true, block, distance: Number(r.value.distance.toFixed(2)), in_reach: r.value.distance <= 4.5 } });
    }
    const ents = await ctx.world.entities(within);
    if (isUnknown(ents)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
    const self = await ctx.world.selfPos();
    const type = args.entity != null ? String(args.entity) : undefined;
    const cands = ents.value.filter((e) => !type || e.type.includes(type));
    if (!cands.length) return pass({ data: { found: false, entity: type ?? 'any' } });
    let best = cands[0]!;
    let bd = self ? distance(self, best.pos) : Infinity;
    for (const e of cands) {
      const d = self ? distance(self, e.pos) : Infinity;
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return pass({ data: { found: true, type: best.type, distance: Number(bd.toFixed(2)) } });
  },
};

const raycast: AtomicAction = {
  contract: contract({
    name: 'raycast',
    description: 'What the bot is looking at (observed): block and/or entity under the crosshair.',
    params: { type: 'object', properties: { max_distance: { type: 'number', default: 5 } }, additionalProperties: false },
  }),
  async run(ctx, args): Promise<ActionResult> {
    return pass({ data: await ctx.ctrl.raycast(Number(args.max_distance ?? 5)), evidence: [{ claim: 'raycast', source: 'observed' }] });
  },
};

const inspectBlock: AtomicAction = {
  contract: contract({
    name: 'inspect_block',
    description: 'Authoritative block id for a target cell (nearest block of a type, or an explicit cell).',
    params: { type: 'object', properties: { target: { type: 'object' } }, required: ['target'], additionalProperties: false },
  }),
  async run(ctx, args): Promise<ActionResult> {
    const rt = await resolveTarget(ctx, args.target as Target);
    if (!rt.ok || !rt.value.pos) return fail('precondition_failed', { reasonDetail: rt.ok ? 'no position' : rt.reason });
    const b = await ctx.world.blockAt(rt.value.pos);
    return isUnknown(b) ? mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' }) : pass({ data: { block: b.value } });
  },
};

const inspectContainer: AtomicAction = {
  contract: contract({
    name: 'inspect_container',
    description: 'Read a container\u2019s contents (observed): open, read slots, close.',
    params: { type: 'object', properties: { target: { type: 'object' } }, required: ['target'], additionalProperties: false },
    effectClass: 'read',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const rt = await resolveTarget(ctx, args.target as Target);
    const pos = rt.ok ? rt.value.containerPos : undefined;
    if (!pos) return fail('precondition_failed', { reasonDetail: rt.ok ? 'no container position' : rt.reason });
    const items = await ctx.ctrl.containerContents(pos);
    return pass({ data: { items }, evidence: [{ claim: 'container_contents', source: 'observed' }] });
  },
};

const lookupRecipe: AtomicAction = {
  contract: contract({
    name: 'lookup_recipe',
    description: 'Crafting recipes for an item (ingredients, result, table requirement).',
    params: { type: 'object', properties: { item: { type: 'string' }, table: { type: 'boolean', default: false } }, required: ['item'], additionalProperties: false },
  }),
  async run(ctx, args): Promise<ActionResult> {
    return pass({ data: await ctx.ctrl.lookupRecipe(String(args.item), args.table === true), evidence: [{ claim: 'recipes', source: 'observed' }] });
  },
};

const getWorldInfo: AtomicAction = {
  contract: contract({
    name: 'get_world_info',
    description: 'Time of day, weather and dimension (observed).',
    params: { type: 'object', properties: {}, additionalProperties: false },
  }),
  async run(ctx): Promise<ActionResult> {
    return pass({ data: await ctx.ctrl.worldInfo(), evidence: [{ claim: 'world_info', source: 'observed' }] });
  },
};

const recall: AtomicAction = {
  contract: contract({
    name: 'recall',
    description:
      'Places remembered in the discovery map near the bot (planning only; may be stale — revalidate by approaching). This is memory, never a verification source.',
    params: {
      type: 'object',
      properties: {
        radius: { type: 'number', default: 48 },
        kind: { type: 'string', enum: ['resource', 'structure', 'waypoint', 'terrain'] },
        include_stale: { type: 'boolean', default: false },
        limit: { type: 'integer', default: 32 },
      },
      additionalProperties: false,
    },
  }),
  async run(ctx, args): Promise<ActionResult> {
    const self = await ctx.world.status();
    const now = isUnknown(self) ? 0 : self.observedTick;
    if (now > 0) ctx.world.discoveries.markStaleBefore(now);
    const around = isUnknown(self) ? undefined : self.value.pos;
    const entries = ctx.world.discoveries
      .list({
        ...(around ? { around } : {}),
        radius: Number(args.radius ?? 48),
        ...(args.kind ? { kind: String(args.kind) as DiscoveryKind } : {}),
        includeStale: args.include_stale === true,
      })
      .slice(0, Number(args.limit ?? 32));
    return pass({
      data: {
        count: entries.length,
        entries: entries.map((e) => ({
          kind: e.kind,
          label: e.label,
          distance: around ? Number(distance(around, e.pos).toFixed(1)) : null,
          stale: e.stale,
          confidence: Number(e.confidence.toFixed(2)),
        })),
      },
      evidence: [{ claim: 'discovery_map', source: 'inferred' }],
    });
  },
};

const scanComponent: AtomicAction = {
  contract: contract({
    name: 'scan_component',
    description:
      'Connected component of matching cells reachable from a seed (e.g. "a tree" over a log and the #logs tag, or a vein over an ore). Returns size, bounding box and exposure — not a hand-named structure.',
    params: {
      type: 'object',
      properties: {
        seed: { type: 'object', description: 'Seed target (a cell or the nearest matching block)' },
        match: { type: 'object', description: 'Match: {kind:"block",block} or {kind:"tag",tag}' },
        neighbor: { type: 'string', enum: ['face', 'edge'], default: 'face' },
        radius: { type: 'integer', default: 32 },
      },
      required: ['seed', 'match'],
      additionalProperties: false,
    },
  }),
  async run(ctx, args): Promise<ActionResult> {
    const rt = await resolveTarget(ctx, args.seed as Target);
    if (!rt.ok || !rt.value.pos) return fail('precondition_failed', { reasonDetail: rt.ok ? 'seed has no position' : rt.reason });
    const r = await ctx.world.connected(rt.value.pos, args.match as Match, {
      radius: Number(args.radius ?? 32),
      ...(args.neighbor === 'edge' ? { neighbor: 'edge' as const } : {}),
    });
    if (isUnknown(r)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
    return pass({
      data: { size: r.value.size, exposed: r.value.exposed, bbox: r.value.bbox },
      evidence: [{ claim: 'connected_component', source: 'authoritative' }],
    });
  },
};

const scanSurface: AtomicAction = {
  contract: contract({
    name: 'scan_surface',
    description:
      'Surface-shell derived layers near the bot: exposed faces, standable surfaces and hazardous faces (fresh local shell when maintained, otherwise an authoritative query).',
    params: {
      type: 'object',
      properties: { radius: { type: 'integer', default: 12 }, center: { type: 'array', items: { type: 'integer' } } },
      additionalProperties: false,
    },
  }),
  async run(ctx, args): Promise<ActionResult> {
    const radius = Number(args.radius ?? 12);
    const center = (Array.isArray(args.center) ? (args.center as Vec3) : undefined) ?? (await ctx.world.selfPos());
    if (!center) return fail('precondition_failed', { reasonDetail: 'no centre' });
    const box = {
      min: [center[0] - radius, center[1] - radius, center[2] - radius] as Vec3,
      max: [center[0] + radius, center[1] + radius, center[2] + radius] as Vec3,
    };
    const tags = await ctx.world.tagTable();
    const tt = isUnknown(tags) ? undefined : tags.value;
    if (ctx.shell) {
      const faces = ctx.shell.facesIn(box);
      return pass({
        data: {
          source: 'shell',
          exposed_faces: faces.length,
          standable: ctx.shell.standableIn(box).slice(0, 64),
          hazardous: ctx.shell.hazardousIn(box, tt).map((f) => ({ pos: f.pos, block: f.block })).slice(0, 64),
        },
        evidence: [{ claim: 'surface_shell', source: 'authoritative' }],
      });
    }
    const r = await ctx.world.exposedFaces(box);
    if (isUnknown(r)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
    const st = await ctx.world.standableSurfaces(box);
    return pass({
      data: {
        source: 'query',
        exposed_faces: r.value.length,
        standable: isUnknown(st) ? [] : st.value.slice(0, 64),
        hazardous: r.value.filter((f) => isHazardous(f.block, tt)).map((f) => ({ pos: f.pos, block: f.block })),
      },
      evidence: [{ claim: 'exposed_faces', source: 'authoritative' }],
    });
  },
};

const checkRelations: AtomicAction = {
  contract: contract({
    name: 'check_relations',
    description:
      'Relations of a target: within reach, reachable (client path check), line of sight (client), adjacent air, support, hazardous (authoritative). Cheap affordances so the agent need not call-then-fail.',
    params: { type: 'object', properties: { target: { type: 'object' } }, required: ['target'], additionalProperties: false },
    effectClass: 'read',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const rt = await resolveTarget(ctx, args.target as Target);
    if (!rt.ok || !rt.value.pos) return fail('precondition_failed', { reasonDetail: rt.ok ? 'no position' : rt.reason });
    const pos = rt.value.pos;
    const self = await ctx.world.selfPos();
    const dist = self ? distance(self, pos) : null;
    const [adj, supp, haz] = await Promise.all([ctx.world.adjacentAir(pos), ctx.world.support(pos), ctx.world.hazardous(pos)]);
    const withinReach = dist !== null && dist <= 4.5;
    let reachable: boolean | null = null;
    let los: boolean | null = null;
    try {
      reachable = withinReach ? true : await ctx.ctrl.canReach(pos, { range: 2 });
    } catch {
      reachable = null;
    }
    try {
      los = await ctx.ctrl.canSee(pos);
    } catch {
      los = null;
    }
    return pass({
      data: {
        distance: dist === null ? null : Number(dist.toFixed(2)),
        within_reach: withinReach,
        reachable,
        line_of_sight: los,
        adjacent_air: isUnknown(adj) ? null : adj.value,
        support: isUnknown(supp) ? null : supp.value,
        hazardous: isUnknown(haz) ? null : haz.value,
      },
      evidence: [
        { claim: 'reachable', source: 'observed' },
        { claim: 'adjacent_air/support/hazardous', source: 'authoritative' },
      ],
    });
  },
};

export const perceptionActions: AtomicAction[] = [
  observe,
  getSelfStatus,
  getInventory,
  scanBlocks,
  scanEntities,
  findNearest,
  raycast,
  inspectBlock,
  inspectContainer,
  lookupRecipe,
  getWorldInfo,
  recall,
  scanComponent,
  scanSurface,
  checkRelations,
];
