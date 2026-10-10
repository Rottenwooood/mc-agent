// Perception actions (world-map-and-composition §12).
// Two primary tools: `view` (near per-block, cropped) and `scan_blocks` (semantic objects).
// `relations` is a fallback re-check; `recall` reads planning-only memory. Coordinates are
// returned as samples but are not the primary address.

import type { ActionResult, Target, Vec3 } from '@mc-agent/contracts';
import { compassFrom, isUnknown } from '@mc-agent/contracts';
import {
  aggregateObjects,
  buildView,
  distance,
  entityHandle,
  exposedCells,
  isFluid,
  isHazardous,
  type DiscoveryKind,
  type WorldObject,
} from '@mc-agent/world';
import { mk, pass, fail } from '../result.js';
import type { ActionContext, AtomicAction } from './types.js';
import { contract } from './types.js';
import { resolveTarget } from './target.js';

const norm = (b: string): string => (b.includes(':') ? b : 'minecraft:' + b);
const REACH = 4.5;

const INTERACTABLE = new Set([
  'minecraft:chest', 'minecraft:trapped_chest', 'minecraft:ender_chest', 'minecraft:barrel',
  'minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker', 'minecraft:crafting_table',
  'minecraft:anvil', 'minecraft:chipped_anvil', 'minecraft:damaged_anvil', 'minecraft:enchanting_table',
  'minecraft:brewing_stand', 'minecraft:hopper', 'minecraft:dispenser', 'minecraft:dropper',
  'minecraft:beacon', 'minecraft:lectern', 'minecraft:campfire', 'minecraft:soul_campfire',
  'minecraft:composter', 'minecraft:loom', 'minecraft:cartography_table', 'minecraft:fletching_table',
  'minecraft:grindstone', 'minecraft:smithing_table', 'minecraft:stonecutter', 'minecraft:bell',
  'minecraft:respawn_anchor', 'minecraft:cauldron', 'minecraft:jukebox', 'minecraft:note_block',
  'minecraft:decorated_pot', 'minecraft:lever', 'minecraft:repeater', 'minecraft:comparator',
]);

function nearObjects(cells: readonly { pos: Vec3; block: string }[], self: Vec3): WorldObject[] {
  const byLabel = new Map<string, { pos: Vec3; block: string }[]>();
  for (const c of cells) {
    const a = byLabel.get(c.block) ?? [];
    a.push(c);
    byLabel.set(c.block, a);
  }
  const out: WorldObject[] = [];
  for (const cs of byLabel.values()) out.push(...aggregateObjects(cs, () => true, self, { reach: REACH }));
  out.sort((a, b) => a.edgeDistance - b.edgeDistance);
  return out;
}

async function reachableFor(ctx: ActionContext, o: WorldObject): Promise<boolean | null> {
  if (o.touchable) return true;
  if (o.edgeDistance > 16) return null;
  try {
    return await ctx.ctrl.canReach(o.anchor, { range: 2 });
  } catch {
    return null;
  }
}

function objectBrief(o: WorldObject): Record<string, unknown> {
  return {
    handle: o.handle,
    kind: INTERACTABLE.has(o.label) ? 'interactable' : isFluid(o.label) ? 'liquid' : 'block',
    label: o.label,
    size: o.size,
    dir: o.dir,
    center_distance: o.centerDistance,
    edge_distance: o.edgeDistance,
    touchable: o.touchable,
    sample: o.anchor,
  };
}

// ---- view ----

const view: AtomicAction = {
  contract: contract({
    name: 'view',
    description:
      'Near per-block view: a cropped 3D array of the blocks exposed to air/water around the bot. Letters map (via legend) to block ids; "#" is a known buried cell; "." air/water; "?" fog; "@" the player. Compass-aligned (rows west→east, columns north→south, layers down→up). Only the box that contains blocks is returned (air margins cropped). Also lists nearby object handles (handle/kind/label/compass dir only — sizes are authoritative via scan_blocks or members(handle)).',
    params: {
      type: 'object',
      properties: { radius: { type: 'integer', default: 8 }, height: { type: 'integer', default: 4 } },
      additionalProperties: false,
    },
    effectClass: 'read',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const radius = Number(args.radius ?? 8);
    const height = Number(args.height ?? 4);
    const self = await ctx.world.selfPos();
    if (!self) return fail('precondition_failed', { reasonDetail: 'no self position' });
    const c: Vec3 = [Math.round(self[0]), Math.round(self[1]), Math.round(self[2])];
    const box = {
      min: [c[0] - radius - 1, c[1] - height - 1, c[2] - radius - 1] as Vec3,
      max: [c[0] + radius + 1, c[1] + height + 1, c[2] + radius + 1] as Vec3,
    };
    const r = await ctx.world.query(box, { maxItems: 65536 });
    if (isUnknown(r)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
    const v = buildView(r.value, self, { radius, height, truncated: r.coverage.truncated });
    const objects = nearObjects(exposedCells(r.value), self)
      .slice(0, 24)
      .map((o) => ({
        handle: o.handle,
        kind: INTERACTABLE.has(o.label) ? 'interactable' : isFluid(o.label) ? 'liquid' : 'block',
        label: o.label,
        dir: o.dir,
        edge_distance: o.edgeDistance,
        touchable: o.touchable,
      }));
    return pass({ data: { ...v, objects }, evidence: [{ claim: 'view', source: 'authoritative' }] });
  },
};

// ---- scan_blocks ----

function matchBlockIds(
  match: unknown,
): { kind: 'any' } | { kind: 'block'; block: string } | { kind: 'tag'; tag: string } {
  if (!match || match === 'any') return { kind: 'any' };
  // Bare strings are accepted for convenience: "#tag" -> tag, anything else -> block id.
  if (typeof match === 'string') {
    const s = match.trim();
    if (s.startsWith('#')) return { kind: 'tag', tag: s.slice(1) };
    if (s.length > 0) return { kind: 'block', block: s };
    return { kind: 'any' };
  }
  const o = match as Record<string, unknown>;
  if (o.kind === 'any') return { kind: 'any' };
  if (o.block) return { kind: 'block', block: String(o.block) };
  if (o.tag) {
    const t = String(o.tag);
    return { kind: 'tag', tag: t.startsWith('#') ? t.slice(1) : t };
  }
  return { kind: 'any' };
}

const scanBlocks: AtomicAction = {
  contract: contract({
    name: 'scan_blocks',
    description:
      'Scan for semantic OBJECTS around the bot: aggregates air/water-exposed, connected, same-kind blocks into objects (handle + label + size + center_distance + edge_distance + compass dir + touchable/reachable). Also lists interactable blocks, entities and liquids. match may be a block/tag or "any" (category scan). Default radius 24; server-side filtered, low latency. Coordinates are only a sample.',
    params: {
      type: 'object',
      properties: {
        match: { description: 'block/tag selector {block}|{tag}, or "any" for a category scan' },
        radius: { type: 'number', default: 24 },
        neighbor: { type: 'string', enum: ['face', 'edge'], default: 'face' },
      },
      additionalProperties: false,
    },
    effectClass: 'read',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const self = await ctx.world.selfPos();
    if (!self) return fail('precondition_failed', { reasonDetail: 'no self position' });
    const radius = Number(args.radius ?? 24);
    const c: Vec3 = [Math.round(self[0]), Math.round(self[1]), Math.round(self[2])];
    const box = {
      min: [c[0] - radius - 1, c[1] - radius - 1, c[2] - radius - 1] as Vec3,
      max: [c[0] + radius + 1, c[1] + radius + 1, c[2] + radius + 1] as Vec3,
    };
    const mt = matchBlockIds(args.match);
    let blockIds: string[];
    if (mt.kind === 'block') {
      blockIds = [norm(mt.block)];
    } else if (mt.kind === 'tag') {
      const tt = await ctx.world.tagTable();
      if (isUnknown(tt)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
      blockIds = tt.value.blocks[norm(mt.tag)] ?? [];
      if (blockIds.length === 0) return pass({ data: { blocks: [], interactables: [], entities: [], liquids: [], count: 0 } });
    } else {
      // "any" = category scan (ores via #*_ores, logs, interactables, fluids) — a bounded
      // server-side filter, never a full exposed-face dump (which truncates at radius 24).
      const tt = await ctx.world.tagTable();
      const cat = new Set<string>();
      if (!isUnknown(tt)) {
        for (const [tag, ids] of Object.entries(tt.value.blocks)) if (/_ores$/.test(tag)) for (const id of ids) cat.add(id);
        for (const id of tt.value.blocks['minecraft:logs'] ?? []) cat.add(id);
      }
      for (const id of INTERACTABLE) cat.add(id);
      cat.add('minecraft:water');
      cat.add('minecraft:lava');
      blockIds = [...cat];
      if (blockIds.length === 0) return pass({ data: { blocks: [], interactables: [], entities: [], liquids: [], count: 0 } });
    }
    const r = await ctx.world.query(box, { exposedOnly: true, blockIds, maxItems: 40000 });
    if (isUnknown(r)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
    const solids = r.value.filter((x) => !isFluid(x.block));
    const fluidCells = r.value.filter((x) => isFluid(x.block));
    const objs = nearObjects(solids, self);
    const blocks = objs.filter((o) => !INTERACTABLE.has(o.label));
    const interactables = objs.filter((o) => INTERACTABLE.has(o.label));
    const liquids = nearObjects(fluidCells, self);
    const ents = await ctx.world.entities(radius);
    const entities = isUnknown(ents)
      ? []
      : ents.value.map((e) => {
          const d = Number(distance(self, e.pos).toFixed(2));
          return {
            handle: entityHandle(e.id),
            label: e.type,
            hostile: e.hostile === true,
            dir: compassFrom(self, e.pos),
            center_distance: d,
            edge_distance: d,
            touchable: d <= REACH,
            sample: e.pos,
          };
        });

    const pack = async (o: WorldObject): Promise<Record<string, unknown>> => ({
      ...objectBrief(o),
      reachable: await reachableFor(ctx, o),
    });
    const brief = async (list: WorldObject[], cap = 16): Promise<Record<string, unknown>[]> => {
      const out: Record<string, unknown>[] = [];
      for (const o of list.slice(0, cap)) out.push(await pack(o));
      return out;
    };
    const blockList = await brief(blocks);
    const interactableList = await brief(interactables);
    const liquidList = await brief(liquids);
    return pass({
      data: {
        blocks: blockList,
        interactables: interactableList,
        entities,
        liquids: liquidList,
        count: blockList.length + interactableList.length + entities.length + liquidList.length,
        truncated: r.coverage.truncated,
      },
      evidence: [{ claim: 'scan_objects', source: 'authoritative' }],
    });
  },
};

// ---- relations (fallback re-check) ----

const relations: AtomicAction = {
  contract: contract({
    name: 'relations',
    description:
      'Fallback re-check of one target (handle | compass direction | nearest matching block): distance, touchable, reachable (client path), line of sight (client), adjacent air, support, hazardous.',
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
    const within = dist !== null && dist <= REACH;
    let reachable: boolean | null = null;
    let los: boolean | null = null;
    try {
      reachable = within ? true : await ctx.ctrl.canReach(pos, { range: 2 });
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
        subject: rt.value.subject ?? null,
        distance: dist === null ? null : Number(dist.toFixed(2)),
        touchable: within,
        reachable,
        line_of_sight: los,
        adjacent_air: isUnknown(adj) ? null : adj.value,
        support: isUnknown(supp) ? null : supp.value,
        hazardous: isUnknown(haz) ? null : haz.value,
      },
      evidence: [{ claim: 'relations', source: 'authoritative' }],
    });
  },
};

// ---- kept simple perceptions ----

const observe: AtomicAction = {
  contract: contract({
    name: 'observe',
    description: 'Authoritative self state, inventory and nearby entities (names; no action coordinates).',
    params: { type: 'object', properties: {}, additionalProperties: false },
    effectClass: 'read',
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
  contract: contract({ name: 'get_self_status', description: 'Authoritative self position, health, food, dimension, on-ground.', params: { type: 'object', properties: {}, additionalProperties: false }, effectClass: 'read' }),
  async run(ctx): Promise<ActionResult> {
    const s = await ctx.world.status();
    return isUnknown(s) ? mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' }) : pass({ data: s.value });
  },
};

const getInventory: AtomicAction = {
  contract: contract({ name: 'get_inventory', description: 'Authoritative inventory contents {item,count}.', params: { type: 'object', properties: {}, additionalProperties: false }, effectClass: 'read' }),
  async run(ctx): Promise<ActionResult> {
    const inv = await ctx.world.inventory();
    return isUnknown(inv) ? mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' }) : pass({ data: inv.value.map((i) => ({ item: i.item, count: i.count })) });
  },
};

const scanEntities: AtomicAction = {
  contract: contract({ name: 'scan_entities', description: 'Nearby entities (observed), optionally filtered by type substring, with compass direction and distance.', params: { type: 'object', properties: { radius: { type: 'number', default: 24 }, types: { type: 'string' } }, additionalProperties: false }, effectClass: 'read' }),
  async run(ctx, args): Promise<ActionResult> {
    const r = await ctx.world.entities(Number(args.radius ?? 24));
    if (isUnknown(r)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
    const self = await ctx.world.selfPos();
    const filters = String(args.types ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const entities = r.value
      .filter((e) => filters.length === 0 || filters.some((f) => e.type.includes(f)))
      .map((e) => ({ id: e.id, type: e.type, hostile: e.hostile === true, dir: self ? compassFrom(self, e.pos) : null, distance: self ? Number(distance(self, e.pos).toFixed(2)) : null }));
    return pass({ data: { count: entities.length, entities } });
  },
};

const findNearest: AtomicAction = {
  contract: contract({ name: 'find_nearest', description: 'Nearest block of an id near the bot: presence, compass direction, distance, in-reach. (Prefer scan_blocks for grouped objects.)', params: { type: 'object', properties: { block: { type: 'string' }, within: { type: 'integer', default: 48 } }, required: ['block'], additionalProperties: false }, effectClass: 'read' }),
  async run(ctx, args): Promise<ActionResult> {
    const block = String(args.block);
    const r = await ctx.world.findNearestBlock(block, Number(args.within ?? 48));
    if (isUnknown(r)) return mk({ effectStatus: 'unobservable', reason: 'insufficient_evidence' });
    if (!r.value) return pass({ data: { found: false, block } });
    const self = await ctx.world.selfPos();
    ctx.world.discoveries.record({ kind: 'resource', pos: r.value.pos, label: norm(block), source: 'observed', observedTick: r.observedTick, confidence: 0.6 });
    return pass({ data: { found: true, block, dir: self ? compassFrom(self, r.value.pos) : null, distance: Number(r.value.distance.toFixed(2)), in_reach: r.value.distance <= REACH } });
  },
};

const raycast: AtomicAction = {
  contract: contract({ name: 'raycast', description: 'What the bot is looking at (observed): block and/or entity under the crosshair.', params: { type: 'object', properties: { max_distance: { type: 'number', default: 5 } }, additionalProperties: false }, effectClass: 'read' }),
  async run(ctx, args): Promise<ActionResult> {
    return pass({ data: await ctx.ctrl.raycast(Number(args.max_distance ?? 5)), evidence: [{ claim: 'raycast', source: 'observed' }] });
  },
};

const inspectContainer: AtomicAction = {
  contract: contract({ name: 'inspect_container', description: 'Read a container’s contents (observed): open, read slots, close.', params: { type: 'object', properties: { target: { type: 'object' } }, required: ['target'], additionalProperties: false }, effectClass: 'read' }),
  async run(ctx, args): Promise<ActionResult> {
    const rt = await resolveTarget(ctx, args.target as Target);
    const pos = rt.ok ? rt.value.containerPos ?? rt.value.pos : undefined;
    if (!pos) return fail('precondition_failed', { reasonDetail: rt.ok ? 'no container position' : rt.reason });
    return pass({ data: { items: await ctx.ctrl.containerContents(pos) }, evidence: [{ claim: 'container_contents', source: 'observed' }] });
  },
};

const lookupRecipe: AtomicAction = {
  contract: contract({ name: 'lookup_recipe', description: 'Crafting recipes for an item (ingredients, result, table requirement).', params: { type: 'object', properties: { item: { type: 'string' }, table: { type: 'boolean', default: false } }, required: ['item'], additionalProperties: false }, effectClass: 'read' }),
  async run(ctx, args): Promise<ActionResult> {
    return pass({ data: await ctx.ctrl.lookupRecipe(String(args.item), args.table === true), evidence: [{ claim: 'recipes', source: 'observed' }] });
  },
};

const getWorldInfo: AtomicAction = {
  contract: contract({ name: 'get_world_info', description: 'Time of day, weather and dimension (observed).', params: { type: 'object', properties: {}, additionalProperties: false }, effectClass: 'read' }),
  async run(ctx): Promise<ActionResult> {
    return pass({ data: await ctx.ctrl.worldInfo(), evidence: [{ claim: 'world_info', source: 'observed' }] });
  },
};

const recall: AtomicAction = {
  contract: contract({
    name: 'recall',
    description: 'Remembered objects beyond the current scan (planning only; may be stale — re-validate by approaching). Memory, never a verification source.',
    params: { type: 'object', properties: { radius: { type: 'number', default: 64 }, kind: { type: 'string', enum: ['resource', 'structure', 'waypoint', 'terrain'] }, include_stale: { type: 'boolean', default: false }, limit: { type: 'integer', default: 32 } }, additionalProperties: false },
    effectClass: 'read',
  }),
  async run(ctx, args): Promise<ActionResult> {
    const self = await ctx.world.status();
    const now = isUnknown(self) ? 0 : self.observedTick;
    if (now > 0) ctx.world.discoveries.markStaleBefore(now);
    const around = isUnknown(self) ? undefined : self.value.pos;
    const entries = ctx.world.discoveries
      .list({ ...(around ? { around } : {}), radius: Number(args.radius ?? 64), ...(args.kind ? { kind: String(args.kind) as DiscoveryKind } : {}), includeStale: args.include_stale === true })
      .slice(0, Number(args.limit ?? 32));
    return pass({
      data: {
        source: 'memory',
        count: entries.length,
        entries: entries.map((e) => ({ label: e.label, dir: around ? compassFrom(around, e.pos) : null, distance: around ? Number(distance(around, e.pos).toFixed(1)) : null, stale: e.stale, confidence: Number(e.confidence.toFixed(2)) })),
      },
      evidence: [{ claim: 'discovery_map', source: 'inferred' }],
    });
  },
};

export const perceptionActions: AtomicAction[] = [
  view,
  scanBlocks,
  relations,
  observe,
  getSelfStatus,
  getInventory,
  scanEntities,
  findNearest,
  raycast,
  inspectContainer,
  lookupRecipe,
  getWorldInfo,
  recall,
];
