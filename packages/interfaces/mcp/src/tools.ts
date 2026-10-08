// The model-facing tool surface = every atomic action across all domains + the bounded
// composition executor. No hand-written high-level actions.

import type { Predicate, Step } from '@mc-agent/contracts';
import { ALL_ACTIONS, actionRegistry, executeAction } from '@mc-agent/execution';
import { runMethod } from '@mc-agent/tasks';
import type { ToolDef } from './tool.js';

const compositionRegistry = actionRegistry();

const runMethodTool: ToolDef = {
  name: 'run_method',
  title: 'run_method',
  description:
    'Execute a bounded composed method: declared steps over the atomic actions. Control ops: sequence/for_each/repeat/branch. Set exprs: set_difference/component/region. Sets are recomputed fresh (fill only what is missing); the whole run is judged by its terminal postconditions. Result is a self-explaining aggregate with subResults.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      steps: { type: 'array', items: { type: 'object' }, description: 'Step[] (action steps and control ops)' },
      postconditions: { type: 'array', items: { type: 'object' }, description: 'Predicate[] terminal postcondition' },
      args: { type: 'object', description: 'Initial variable bindings' },
      budget: { type: 'integer', default: 4096 },
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
      },
    ),
};

export function buildTools(): ToolDef[] {
  const tools: ToolDef[] = ALL_ACTIONS.map((a) => ({
    name: a.contract.name,
    title: a.contract.name,
    description: a.contract.description,
    inputSchema: a.contract.params as Record<string, unknown>,
    handler: (ctx, args) => executeAction(ctx, a, args),
  }));
  tools.push(runMethodTool);
  return tools;
}
