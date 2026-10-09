// Atomic action library types. Every action is a declared contract + a real handler;
// results are self-explaining ActionResults judged on world evidence.

import type { ActionContract, ActionResult, ControlPort, JsonSchema } from '@mc-agent/contracts';
import type { SurfaceShell, World } from '@mc-agent/world';
import type { ControlToken } from '../token.js';
import type { ReflexShield } from '../reflex.js';
import type { EffectScope, VerificationWindow, VerifyOutcome } from '../contract/signature.js';

export interface ActionContext {
  world: World;
  ctrl: ControlPort;
  token: ControlToken;
  /** L1 reflex shield; when present, actions run guarded (see guard.ts). */
  reflex?: ReflexShield;
  /** Locally maintained surface shell (present when the resident drives it). */
  shell?: SurfaceShell;
}

export interface AtomicAction {
  contract: ActionContract;
  run(ctx: ActionContext, args: Record<string, unknown>): Promise<ActionResult>;
  /** Where this action can causally change the world (anchors the L3 signature diff). */
  scope?(ctx: ActionContext, args: Record<string, unknown>): Promise<EffectScope | null>;
  /** Independent postcondition check; the engine uses it to judge and to reconcile timeouts. */
  verify?(ctx: ActionContext, args: Record<string, unknown>, win: VerificationWindow): Promise<VerifyOutcome | null>;
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
