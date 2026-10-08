// Tool surface types. The model-facing surface IS the atomic action library (all domains);
// every tool returns an ActionResult.

import type { ActionResult } from '@mc-agent/contracts';
import type { ActionContext } from '@mc-agent/execution';

export type ToolContext = ActionContext;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(ctx: ToolContext, args: Record<string, unknown>): Promise<ActionResult>;
}

/** Simple in-memory registry supporting runtime add/remove (used by the resident). */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    this.tools.set(def.name, def);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }
}
