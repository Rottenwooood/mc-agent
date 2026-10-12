// The model-facing tool surface = every atomic (primary) action across all domains + the
// bounded composition executor + (when a library is present) the secondary-action lifecycle
// tools and the skill (text) tools.

import type { Predicate, Step, SecondaryActionDefinitionInput } from '@mc-agent/contracts';
import { mk, ALL_ACTIONS, actionRegistry, executeAction } from '@mc-agent/execution';
import { runMethod, tryAction, validateMethod } from '@mc-agent/tasks';
import type { ActionLibrary, SkillLibrary } from '@mc-agent/knowledge';
import type { ToolDef, ToolContext } from './tool.js';

const compositionRegistry = actionRegistry();

/** Names a secondary action may not take (they belong to primary/management tools). */
const RESERVED_TOOL_NAMES = new Set<string>([
  ...ALL_ACTIONS.map((a) => a.contract.name),
  'run_method',
  'define_action',
  'list_actions',
  'try_action',
  'activate_action',
  'rollback_action',
  'retire_action',
  'write_skill',
  'list_skills',
  'read_skill',
]);

/** JSON Schema for a run_method step (action step {action,args?} or control step {op,...}). */
const SET_SCHEMA = {
  type: 'object',
  description:
    'A set expression (recomputed fresh against the world). Block/cell domains: {op:"members",handle} (all cells of an object — mine a vein/tree), {op:"surface",handle}, {op:"nearest",match} (block/tag), {op:"area",anchor,size,offset?}, {op:"box_cells",box}, {op:"component",seed,match}, {op:"region",box,filter?}, {op:"set_difference",a,b}. Non-block domains (elements are records, project a field with {"from":"s","field":"count"}): {op:"inventory"} -> {slot,item,count}; {op:"container",handle} -> {slot,item,count}; {op:"entities",match:{type,hostile,within}} -> {id,type,pos,hostile,distance}.',
  properties: {
    op: { enum: ['members', 'surface', 'nearest', 'area', 'component', 'region', 'box_cells', 'set_difference', 'inventory', 'container', 'entities'] },
    handle: { type: 'string', description: 'obj:... handle (members/surface/container)' },
    match: { description: 'block: a block id, or {block}|{tag}|{anyOf} (nearest/component). entities: {type,hostile,within}.' },
    anchor: { description: "obj:... handle or 'self' (area)" },
    size: { type: 'array', items: { type: 'integer' }, description: '[dx,dy,dz] (area)' },
    offset: { type: 'array', items: { type: 'integer' }, description: '[dx,dy,dz] (area)' },
    seed: { description: '[x,y,z] (component)' },
    box: { description: '{min:[x,y,z],max:[x,y,z]} (region/box_cells)' },
  },
  required: ['op'],
};
const STEP_SCHEMA = {
  type: 'object',
  description:
    'A step: an ACTION step {action:"<tool>", args:{...}} OR a CONTROL step {op:"sequence"|"for_each"|"repeat"|"branch", ...}. For for_each: {op:"for_each", set:<SetExpr>, as:"c", body:[Step...]}; reference the loop var inside args with {"from":"c"} — and one field of an element with {"from":"c","field":"count"} (cells: field x|y|z).',
  properties: {
    action: { type: 'string', description: 'Action/tool name, e.g. set_block, go_to, craft, collect.' },
    args: { type: 'object', description: 'Args for the action. {"from":"c"} references the for_each var; {"from":"c","field":"item"} projects a field.' },
    save: { type: 'string' },
    op: { enum: ['sequence', 'for_each', 'repeat', 'branch'] },
    steps: { type: 'array', items: { type: 'object' }, description: 'sequence: child steps' },
    set: SET_SCHEMA,
    as: { type: 'string', description: 'for_each loop variable name' },
    body: { type: 'array', items: { type: 'object' }, description: 'for_each/repeat: child steps' },
    count: { description: 'repeat count' },
    until: { type: 'object', description: 'repeat until predicate' },
    if: { type: 'object', description: 'branch condition predicate' },
    then: { type: 'array', items: { type: 'object' } },
    else: { type: 'array', items: { type: 'object' } },
  },
};

const RUN_METHOD_DESCRIPTION = [
  'Execute a bounded composed method over the atomic actions — THE way to act on a SERIES (e.g. mine a whole vein/tree). The whole run is judged by its terminal `postconditions`.',
  '',
  'A step is EITHER:',
  '  - an ACTION step  { "action": "<tool>", "args": { ... } }   e.g. {"action":"set_block","args":{...}}',
  '  - a CONTROL step  { "op": "sequence"|"for_each"|"repeat"|"branch", ... }',
  '      for_each: { "op":"for_each", "set": <SetExpr>, "as":"c", "body":[Step...] }  — body iterates the cells; inside, reference the loop var with {"from":"c"}.',
  '',
  'SetExpr (for_each `set`, recomputed fresh):',
  '  { "op":"members", "handle":"obj:..." }   all cells of an object  <- mine a vein/tree with this',
  '  { "op":"surface", "handle":"obj:..." }   its air/water-exposed cells',
  '  { "op":"nearest", "match":"minecraft:stone" }   nearest object matching a block/tag',
  '  { "op":"area", "anchor":"obj:...|self", "size":[dx,dy,dz], "offset":[dx,dy,dz] }',
  '  { "op":"box_cells", "box":{"min":[x,y,z],"max":[x,y,z]} }',
  '  NON-BLOCK domains (elements are records; project a field with {"from":"s","field":"count"}):',
  '  { "op":"inventory" }                        every inventory slot -> {slot,item,count}',
  '  { "op":"container", "handle":"obj:..." }    every slot of a container -> {slot,item,count}',
  '  { "op":"entities", "match":{"type":"...","hostile":true,"within":32} }   -> {id,type,pos,hostile,distance}',
  '',
  'postconditions (terminal, authoritative): subject `block@x,y,z` (is/!=), `inv:<item>` (>=/>/is/...), `self.hp|food`, `entity#<id>`, `obj:<handle>` (gone/present/size_ge/size_is).',
  '',
  'validate:true -> only STRUCTURALLY validate (no execution): known action names, set ops + their required fields, control-step shape, and predicates. Use it to check a method before running it.',
  '',
  'EXAMPLE 1 — mine a whole object, then collect the drops:',
  '{"steps":[',
  '  {"op":"for_each","set":{"op":"members","handle":"obj:block:minecraft:spruce_log:12,73,9"},"as":"c","body":[',
  '    {"action":"set_block","args":{"target":{"kind":"cell","pos":{"from":"c"}},"block":"minecraft:air","navigate":true,"allowModify":true,"breakThrough":true}}]},',
  '  {"action":"collect","args":{"radius":8}}]}',
  '',
  'EXAMPLE 2 — same, with a terminal postcondition:',
  '{"steps":[{"op":"for_each","set":{"op":"members","handle":"obj:..."},"as":"c","body":[{"action":"set_block","args":{"target":{"kind":"cell","pos":{"from":"c"}},"block":"minecraft:air","navigate":true,"allowModify":true,"breakThrough":true}}]}],',
  ' "postconditions":[{"subject":"inv:minecraft:coal","predicate":">=","value":1}]}',
  '',
  'EXAMPLE 3 — drop every inventory stack (a SERIES over the inventory domain; no new tool):',
  '{"steps":[{"op":"for_each","set":{"op":"inventory"},"as":"s","body":[',
  '  {"action":"drop","args":{"item":{"from":"s","field":"item"},"count":{"from":"s","field":"count"}}}]}]}',
].join('\n');

function makeRunMethodTool(library?: ActionLibrary): ToolDef {
  return {
    name: 'run_method',
    title: 'run_method',
    description: RUN_METHOD_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        steps: { type: 'array', items: STEP_SCHEMA, description: 'Step[]: action steps {action,args?} and control steps {op,...}' },
        postconditions: { type: 'array', items: { type: 'object' }, description: 'Predicate[] terminal postcondition' },
        args: { type: 'object', description: 'Initial variable bindings' },
        budget: { type: 'integer', default: 4096 },
        budgetMs: { type: 'integer', default: 90000, description: 'Wall-clock ceiling; the run returns a verdict when exceeded' },
        validate: { type: 'boolean', default: false, description: 'If true, only STRUCTURALLY validate steps/sets/predicates and RETURN without executing.' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const method = {
        steps: args.steps as Step[],
        ...(args.postconditions ? { postconditions: args.postconditions as Predicate[] } : {}),
        ...(args.name ? { name: String(args.name) } : {}),
      };
      if (args.validate === true) {
        const v = validateMethod(method, {
          actions: compositionRegistry,
          ...(library ? { isSecondary: (n: string) => !!library.active(n) } : {}),
        });
        return mk({
          effectStatus: v.valid ? 'pass' : 'fail',
          reason: v.valid ? null : 'precondition_failed',
          reasonDetail: v.valid
            ? `valid method (${v.steps} step${v.steps === 1 ? '' : 's'})`
            : v.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
          data: v,
          evidence: [{ claim: 'method_validation', source: 'observed' }],
        });
      }
      return runMethod(
        ctx,
        compositionRegistry,
        method,
        {
          ...(args.args ? { args: args.args as Record<string, unknown> } : {}),
          ...(args.budget ? { budget: Number(args.budget) } : {}),
          ...(args.budgetMs ? { budgetMs: Number(args.budgetMs) } : {}),
          // A step may call an ACTIVE secondary action (hierarchical composition) when a library exists.
          ...(library
            ? { callSecondary: (c: ToolContext, acts: typeof compositionRegistry, nm: string, a: Record<string, unknown>, d: number) => tryAction(c, acts, library, nm, { args: a, depth: d }) }
            : {}),
        },
      );
    },
  };
}

function secondaryActionTools(library: ActionLibrary): ToolDef[] {
  const defineAction: ToolDef = {
    name: 'define_action',
    title: 'define_action',
    description:
      'Register a new version of a secondary action (a reusable, CALLABLE composition over the bounded vocabulary). It starts as a draft; it is activated only after the online gate (real uses, pass rate, recent window) passes. Never edits an active version in place — it creates a new version.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stable action name, e.g. get_wood' },
        description: { type: 'string' },
        params: { type: 'object', description: 'Declared parameter schema (informational)' },
        preconditions: { type: 'array', items: { type: 'object' } },
        steps: { type: 'array', items: { type: 'object' }, description: 'Step[] (same vocabulary as run_method)' },
        postconditions: { type: 'array', items: { type: 'object' } },
        invariants: { type: 'array', items: { type: 'object' } },
      },
      required: ['name', 'steps'],
      additionalProperties: false,
    },
    handler: async (_ctx, args) => {
      const input: SecondaryActionDefinitionInput = {
        name: String(args.name),
        steps: args.steps as Step[],
        ...(args.description ? { description: String(args.description) } : {}),
        ...(args.params ? { params: args.params as SecondaryActionDefinitionInput['params'] } : {}),
        ...(args.preconditions ? { preconditions: args.preconditions as Predicate[] } : {}),
        ...(args.postconditions ? { postconditions: args.postconditions as Predicate[] } : {}),
        ...(args.invariants ? { invariants: args.invariants as Predicate[] } : {}),
      };
      if (RESERVED_TOOL_NAMES.has(input.name)) {
        return mk({ effectStatus: 'fail', reason: 'precondition_failed', reasonDetail: `name ${input.name} is reserved by a primary/management tool` });
      }
      const v = library.define(input);
      return mk({
        effectStatus: 'pass',
        controlStatus: 'completed',
        data: { name: input.name, version: v.version, status: v.status },
        evidence: [{ claim: 'action_defined', source: 'observed' }],
      });
    },
  };

  const listActions: ToolDef = {
    name: 'list_actions',
    title: 'list_actions',
    description:
      'List secondary actions (name, description, active version, status, uses, pass rate, recent pass rate, whether a rollback is required, params). Discover reusable actions; run one with try_action.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional substring filter on name/description' } },
      additionalProperties: false,
    },
    handler: async (_ctx, args) => {
      const q = args.query ? String(args.query).toLowerCase() : '';
      const all = library.summary();
      const actions = q ? all.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)) : all;
      return mk({ effectStatus: 'pass', controlStatus: 'completed', data: { count: actions.length, actions } });
    },
  };

  const tryActionTool: ToolDef = {
    name: 'try_action',
    title: 'try_action',
    description:
      'Run a secondary action by name (active version, or a specific version to validate a draft). Executes as a bounded method, judged by its terminal postconditions; the online outcome is recorded into the library for the activation gate.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        version: { type: 'integer', description: 'Run a specific version (to validate a draft); default: the active version' },
        args: { type: 'object', description: 'Argument bindings for the action steps' },
        budget: { type: 'integer', default: 4096 },
        budgetMs: { type: 'integer', default: 90000 },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: (ctx, args) =>
      tryAction(ctx, compositionRegistry, library, String(args.name), {
        ...(args.version !== undefined ? { version: Number(args.version) } : {}),
        ...(args.args ? { args: args.args as Record<string, unknown> } : {}),
        ...(args.budget ? { budget: Number(args.budget) } : {}),
        ...(args.budgetMs ? { budgetMs: Number(args.budgetMs) } : {}),
      }),
  };

  const activateAction: ToolDef = {
    name: 'activate_action',
    title: 'activate_action',
    description:
      'Ask the online gate to activate a secondary-action version. The gate counts real uses only (min uses, pass rate, recent window, no net regressions); it activates only if it passes. Returns the decision.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, version: { type: 'integer', description: 'Default: the newest version' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (_ctx, args) => {
      const name = String(args.name);
      const rec = library.get(name);
      if (!rec) return mk({ effectStatus: 'unobservable', reason: 'precondition_failed', reasonDetail: `unknown action ${name}` });
      const version = args.version ? Number(args.version) : rec.versions[rec.versions.length - 1]!.version;
      const d = library.activate(name, version);
      return mk({
        effectStatus: d.activate ? 'pass' : 'fail',
        controlStatus: 'completed',
        reason: d.activate ? null : 'effect_not_observed',
        data: d,
        evidence: [{ claim: 'activation_decision', source: 'observed' }],
      });
    },
  };

  const rollbackAction: ToolDef = {
    name: 'rollback_action',
    title: 'rollback_action',
    description:
      'Roll a secondary action back to its previous superseded version (or to no active version), marking the current one broken. Use when the active version regresses or fails repeatedly.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, reason: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (_ctx, args) => {
      const name = String(args.name);
      const before = library.active(name)?.version ?? null;
      const ok = library.rollback(name, String(args.reason ?? 'manual rollback'));
      return mk({
        effectStatus: ok ? 'pass' : 'fail',
        controlStatus: 'completed',
        data: { name, from: before, to: library.active(name)?.version ?? null },
        evidence: [{ claim: 'action_rollback', source: 'observed' }],
      });
    },
  };

  const retireAction: ToolDef = {
    name: 'retire_action',
    title: 'retire_action',
    description: 'Retire a secondary action (its active version becomes retired; it is no longer default).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' } }, required: ['name'], additionalProperties: false },
    handler: async (_ctx, args) => {
      const ok = library.retire(String(args.name), String(args.reason ?? 'retired'));
      return mk({ effectStatus: ok ? 'pass' : 'fail', controlStatus: 'completed', evidence: [{ claim: 'action_retired', source: 'observed' }] });
    },
  };

  return [defineAction, listActions, tryActionTool, activateAction, rollbackAction, retireAction];
}

function skillTools(library: SkillLibrary): ToolDef[] {
  const writeSkill: ToolDef = {
    name: 'write_skill',
    title: 'write_skill',
    description:
      'Write or update a skill: a TEXT note (methodology, pitfalls, reminders) in the coding-agent style. Skills are guidance, NOT callable tools; retrieve them on demand with read_skill.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        text: { type: 'string', description: 'The methodology / pitfalls / reminders.' },
      },
      required: ['name', 'text'],
      additionalProperties: false,
    },
    handler: async (_ctx, args) => {
      const n = library.write({
        name: String(args.name),
        text: String(args.text),
        ...(args.description ? { description: String(args.description) } : {}),
        ...(args.tags ? { tags: args.tags as string[] } : {}),
      });
      return mk({ effectStatus: 'pass', controlStatus: 'completed', data: { name: n.name, updated: n.updated } });
    },
  };

  const listSkills: ToolDef = {
    name: 'list_skills',
    title: 'list_skills',
    description: 'List skill notes (name, description, tags). On-demand retrieval: read the relevant one with read_skill.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional substring filter' } }, additionalProperties: false },
    handler: async (_ctx, args) => {
      const notes = library.search(args.query ? String(args.query) : undefined);
      return mk({
        effectStatus: 'pass',
        controlStatus: 'completed',
        data: { count: notes.length, skills: notes.map((n) => ({ name: n.name, description: n.description, tags: n.tags })) },
      });
    },
  };

  const readSkill: ToolDef = {
    name: 'read_skill',
    title: 'read_skill',
    description: 'Read a skill note’s full text (methodology / pitfalls / reminders) to inject it into context.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    handler: async (_ctx, args) => {
      const n = library.get(String(args.name));
      if (!n) return mk({ effectStatus: 'unobservable', reason: 'precondition_failed', reasonDetail: `unknown skill ${args.name}` });
      return mk({ effectStatus: 'pass', controlStatus: 'completed', data: n });
    },
  };

  return [writeSkill, listSkills, readSkill];
}

export interface BuildToolsOptions {
  /** When present, exposes the secondary-action lifecycle tools. */
  actionLibrary?: ActionLibrary;
  /** When present, exposes the skill (text) tools. */
  skillLibrary?: SkillLibrary;
}

export function buildTools(opts: BuildToolsOptions = {}): ToolDef[] {
  const tools: ToolDef[] = ALL_ACTIONS.map((a) => ({
    name: a.contract.name,
    title: a.contract.name,
    description: a.contract.description,
    inputSchema: a.contract.params as Record<string, unknown>,
    handler: (ctx, args) => executeAction(ctx, a, args),
  }));
  tools.push(makeRunMethodTool(opts.actionLibrary));
  if (opts.actionLibrary) tools.push(...secondaryActionTools(opts.actionLibrary));
  if (opts.skillLibrary) tools.push(...skillTools(opts.skillLibrary));
  return tools;
}

/**
 * The first-class tool for an ACTIVE secondary action: registered into the tool surface so it is
 * called exactly like a primary action (dynamic registration / tools/list_changed). Returns null
 * if the action has no active version.
 */
export function secondaryActionToolDef(library: ActionLibrary, name: string): ToolDef | null {
  const rec = library.get(name);
  if (!rec || rec.activeVersion === null) return null;
  const v = library.version(name, rec.activeVersion);
  if (!v) return null;
  const properties: Record<string, unknown> = {
    ...(v.method.params ?? {}),
    budget: { type: 'integer', default: 4096 },
    budgetMs: { type: 'integer', default: 90000 },
  };
  return {
    name,
    title: name,
    description: `${v.method.description ?? `Secondary action ${name}`} (agent-created; active v${v.version})`,
    inputSchema: { type: 'object', properties, additionalProperties: false },
    handler: (ctx, args) => {
      const { budget, budgetMs, ...bindings } = args;
      return tryAction(ctx, compositionRegistry, library, name, {
        args: bindings,
        ...(budget ? { budget: Number(budget) } : {}),
        ...(budgetMs ? { budgetMs: Number(budgetMs) } : {}),
      });
    },
  };
}
