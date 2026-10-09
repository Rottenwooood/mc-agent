// The model-facing tool surface = every atomic action across all domains + the bounded
// composition executor + (when a skill library is present) the skill library tools.

import type { Predicate, Step, SkillDefinitionInput } from '@mc-agent/contracts';
import { mk, ALL_ACTIONS, actionRegistry, executeAction } from '@mc-agent/execution';
import { runMethod, runSkill } from '@mc-agent/tasks';
import type { SkillLibrary } from '@mc-agent/knowledge';
import type { ToolDef } from './tool.js';

const compositionRegistry = actionRegistry();

const runMethodTool: ToolDef = {
  name: 'run_method',
  title: 'run_method',
  description:
    'Execute a bounded composed method: declared steps over the atomic actions. Control ops: sequence/for_each/repeat/branch. Set exprs: members(handle) / surface(handle) / nearest(match) / area(anchor,size,offset) / set_difference (region/box_cells kept as an unguided fallback). Targets may be object handles (from view/scan_blocks), compass directions, or nearest-block. Sets are recomputed fresh (fill only what is missing); the whole run is judged by its terminal postconditions (block@, inv:, self., entity#, and object handles obj:/ent:). Result is a self-explaining aggregate with subResults.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      steps: { type: 'array', items: { type: 'object' }, description: 'Step[] (action steps and control ops)' },
      postconditions: { type: 'array', items: { type: 'object' }, description: 'Predicate[] terminal postcondition' },
      args: { type: 'object', description: 'Initial variable bindings' },
      budget: { type: 'integer', default: 4096 },
      budgetMs: { type: 'integer', default: 90000, description: 'Wall-clock ceiling; the run returns a verdict when exceeded' },
    },
    required: ['steps'],
    additionalProperties: false,
  },
  handler: (ctx, args) =>
    runMethod(
      ctx,
      compositionRegistry,
      {
        steps: args.steps as Step[],
        ...(args.postconditions ? { postconditions: args.postconditions as Predicate[] } : {}),
        ...(args.name ? { name: String(args.name) } : {}),
      },
      {
        ...(args.args ? { args: args.args as Record<string, unknown> } : {}),
        ...(args.budget ? { budget: Number(args.budget) } : {}),
        ...(args.budgetMs ? { budgetMs: Number(args.budgetMs) } : {}),
      },
    ),
};

function skillTools(library: SkillLibrary): ToolDef[] {
  const defineSkill: ToolDef = {
    name: 'define_skill',
    title: 'define_skill',
    description:
      'Register a reusable high-level skill as a versioned method in the library (bounded vocabulary only: the same steps as run_method, plus optional preconditions/postconditions). It starts as a draft; it is promoted to active only after it passes the admission gate on train+val seeds. Returns the skill name and version.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stable skill name, e.g. chop_log' },
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
      const input: SkillDefinitionInput = {
        name: String(args.name),
        steps: args.steps as Step[],
        ...(args.description ? { description: String(args.description) } : {}),
        ...(args.params ? { params: args.params as SkillDefinitionInput['params'] } : {}),
        ...(args.preconditions ? { preconditions: args.preconditions as Predicate[] } : {}),
        ...(args.postconditions ? { postconditions: args.postconditions as Predicate[] } : {}),
        ...(args.invariants ? { invariants: args.invariants as Predicate[] } : {}),
      };
      const v = library.define(input);
      return mk({
        effectStatus: 'pass',
        controlStatus: 'completed',
        data: { name: input.name, version: v.version, status: v.method.status },
        evidence: [{ claim: 'skill_defined', source: 'observed' }],
      });
    },
  };

  const listSkills: ToolDef = {
    name: 'list_skills',
    title: 'list_skills',
    description:
      'List skills in the library (name, description, active version, status, stats, params). Use this to discover reusable methods; run one with run_skill.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional substring filter on name/description' } },
      additionalProperties: false,
    },
    handler: async (_ctx, args) => {
      const q = args.query ? String(args.query).toLowerCase() : '';
      const all = library.summary();
      const skills = q ? all.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : all;
      return mk({ effectStatus: 'pass', controlStatus: 'completed', data: { count: skills.length, skills } });
    },
  };

  const runSkillTool: ToolDef = {
    name: 'run_skill',
    title: 'run_skill',
    description:
      'Run the active version of a stored skill by name. The skill executes as a bounded method and is judged by its terminal postconditions; the outcome is recorded into the library (with the current world seed/role) for the promotion gate.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        version: { type: 'integer', description: 'Run a specific version (to validate a draft); default: the active version' },
        args: { type: 'object', description: 'Argument bindings for the skill steps' },
        budget: { type: 'integer', default: 4096 },
        budgetMs: { type: 'integer', default: 90000 },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: (ctx, args) =>
      runSkill(ctx, compositionRegistry, library, String(args.name), {
        ...(args.version !== undefined ? { version: Number(args.version) } : {}),
        ...(args.args ? { args: args.args as Record<string, unknown> } : {}),
        ...(args.budget ? { budget: Number(args.budget) } : {}),
        ...(args.budgetMs ? { budgetMs: Number(args.budgetMs) } : {}),
      }),
  };

  const promoteSkill: ToolDef = {
    name: 'promote_skill',
    title: 'promote_skill',
    description:
      'Ask the admission gate to promote a skill version. The gate counts only train+val seeds (test seeds never influence admission); the version is promoted only if it meets the thresholds. Returns the decision.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, version: { type: 'integer', description: 'Default: the newest version' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (_ctx, args) => {
      const name = String(args.name);
      const rec = library.get(name);
      if (!rec) return mk({ effectStatus: 'unobservable', reason: 'precondition_failed', reasonDetail: `unknown skill ${name}` });
      const version = args.version ? Number(args.version) : rec.versions[rec.versions.length - 1]!.version;
      const d = library.promote(name, version);
      return mk({
        effectStatus: d.admit ? 'pass' : 'fail',
        controlStatus: 'completed',
        reason: d.admit ? null : 'effect_not_observed',
        data: d,
        evidence: [{ claim: 'promotion_decision', source: 'observed' }],
      });
    },
  };

  const rollbackSkill: ToolDef = {
    name: 'rollback_skill',
    title: 'rollback_skill',
    description:
      'Roll a skill back to its previous verified version (or to no active version), marking the current one broken. Use when the active skill proves bad on a held-out seed.',
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
        evidence: [{ claim: 'skill_rollback', source: 'observed' }],
      });
    },
  };

  return [defineSkill, listSkills, runSkillTool, promoteSkill, rollbackSkill];
}

export interface BuildToolsOptions {
  /** When present, exposes define_skill / list_skills / run_skill. */
  library?: SkillLibrary;
}

export function buildTools(opts: BuildToolsOptions = {}): ToolDef[] {
  const tools: ToolDef[] = ALL_ACTIONS.map((a) => ({
    name: a.contract.name,
    title: a.contract.name,
    description: a.contract.description,
    inputSchema: a.contract.params as Record<string, unknown>,
    handler: (ctx, args) => executeAction(ctx, a, args),
  }));
  tools.push(runMethodTool);
  if (opts.library) tools.push(...skillTools(opts.library));
  return tools;
}
