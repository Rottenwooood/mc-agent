// Resident <-> bridge wire protocol (newline-delimited JSON over a Unix socket).

import path from 'node:path';

export function socketPath(): string {
  return process.env.MCAGENT_SOCK ?? '/tmp/opencode/mc-agent.sock';
}

export interface ListReq {
  id: number;
  op: 'list';
}

export interface CallReq {
  id: number;
  op: 'call';
  name: string;
  args?: Record<string, unknown>;
}

export type Req = ListReq | CallReq;

export interface ToolSummary {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ListRes {
  id: number;
  ok: true;
  tools: ToolSummary[];
}

export interface CallRes {
  id: number;
  ok: true;
  result: unknown;
}

export interface ErrRes {
  id: number;
  ok: false;
  error: string;
}

export type Res = ListRes | CallRes | ErrRes;

export function ensureDirFor(file: string): void {
  // Kept tiny; caller imports fs directly for unlink/listen.
  void path.dirname(file);
}
