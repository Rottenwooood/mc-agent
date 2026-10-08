// The model-facing tool surface = every atomic action across all domains, exposed with
// its declared contract. No hand-written ad-hoc tools.

import { ALL_ACTIONS, guardedRun } from '@mc-agent/execution';
import type { ToolDef } from './tool.js';

export function buildTools(): ToolDef[] {
  return ALL_ACTIONS.map((a) => ({
    name: a.contract.name,
    title: a.contract.name,
    description: a.contract.description,
    inputSchema: a.contract.params as Record<string, unknown>,
    handler: (ctx, args) => guardedRun(ctx, a, args),
  }));
}
