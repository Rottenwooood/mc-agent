// Tool surface types. The model-facing surface is SEMANTIC (names/objects, no coordinates);
// every tool returns an ActionResult (framework §9).

import type { ActionResult, ControlPort } from '@mc-agent/contracts';
import type { World } from '@mc-agent/world';
import type { ControlToken } from '@mc-agent/execution';

export interface ToolContext {
  world: World;
  ctrl: ControlPort;
  token: ControlToken;
}

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
