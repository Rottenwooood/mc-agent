// Atomic action library types. Every action is a declared contract + a real handler;
// results are self-explaining ActionResults judged on world evidence.

import type { ActionContract, ActionResult, ControlPort, JsonSchema } from '@mc-agent/contracts';
import type { World } from '@mc-agent/world';
import type { ControlToken } from '../token.js';

export interface ActionContext {
  world: World;
  ctrl: ControlPort;
  token: ControlToken;
}

export interface AtomicAction {
  contract: ActionContract;
  run(ctx: ActionContext, args: Record<string, unknown>): Promise<ActionResult>;
}

export function contract(p: Partial<ActionContract> & { name: string; description: string; params: JsonSchema }): ActionContract {
  return {
    preconditions: [],
    verificationMode: 'observation',
    postconditions: [],
    invariants: [],
    effectClass: 'read',
    interruptible: { prepare: true, execute: true, settle: true },
    safeStop: 'release_control',
    timeoutTicks: 200,
    causalScope: { kind: 'voxel', radius: 1 },
    retryPolicy: 'no',
    repairHint: [],
    ...p,
  };
}
