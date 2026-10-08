// Target model for atomic actions (framework §9). Actions take a semantic target;
// explicit coordinates are only a read-information or an escape/blueprint case.

import type { Vec3 } from './fact.js';

export type Target =
  | { kind: 'self' }
  | { kind: 'block'; block: string; nearest?: boolean; around?: Vec3; within?: number }
  | { kind: 'cell'; pos: Vec3 }
  | { kind: 'entity'; id?: string; type?: string; nearest?: boolean; within?: number }
  | { kind: 'item'; item: string }
  | { kind: 'container'; pos?: Vec3; entityId?: string }
  | { kind: 'object'; ref: string };

export function isCellTarget(t: Target): t is { kind: 'cell'; pos: Vec3 } {
  return t.kind === 'cell';
}
