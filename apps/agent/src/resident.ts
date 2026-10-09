// Resident process: the single owner of the bot, world client, execution and tools.
// Bridges connect to it so any number of model sessions share one body (framework §0).
//
// M4: active secondary actions are registered as FIRST-CLASS tools (called exactly like primary
// actions). When the active set changes (activate/rollback/retire), the resident re-syncs the
// tool surface and notifies every connected bridge so it can emit tools/list_changed.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { secondaryActionToolDef } from '@mc-agent/interfaces-mcp';
import { createContext, type AppContext } from './context.js';
import { socketPath, type Req, type Res, type ResidentMsg } from './protocol.js';

function writeLine(conn: net.Socket, msg: ResidentMsg): void {
  try {
    conn.write(JSON.stringify(msg) + '\n');
  } catch {
    /* peer gone */
  }
}

export interface Resident {
  ctx: AppContext;
  sockPath: string;
  close(): Promise<void>;
}

export async function startResident(): Promise<Resident> {
  const ctx = await createContext();
  const sockPath = socketPath();
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* no stale socket */
  }

  const connections = new Set<net.Socket>();
  const dynamicTools = new Set<string>();
  let toolSignature = '';

  /** Register/unregister first-class tools for active secondary actions; notify on change. */
  function syncDynamicTools(): void {
    const active = ctx.actionLibrary.list().filter((r) => r.activeVersion !== null);
    const sig = active.map((r) => `${r.name}@${r.activeVersion}`).sort().join(',');
    for (const name of [...dynamicTools]) {
      if (!active.some((r) => r.name === name)) {
        ctx.registry.unregister(name);
        dynamicTools.delete(name);
      }
    }
    for (const r of active) {
      const def = secondaryActionToolDef(ctx.actionLibrary, r.name);
      if (def) {
        ctx.registry.register(def);
        dynamicTools.add(r.name);
      }
    }
    if (sig !== toolSignature) {
      toolSignature = sig;
      for (const conn of connections) writeLine(conn, { op: 'tools_changed' });
    }
  }

  syncDynamicTools();

  const server = net.createServer((conn) => {
    connections.add(conn);
    conn.setEncoding('utf8');
    let buf = '';
    conn.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: Req;
        try {
          msg = JSON.parse(line) as Req;
        } catch {
          continue;
        }
        void handle(conn, msg);
      }
    });
    conn.on('error', () => {});
    conn.on('close', () => connections.delete(conn));
  });

  async function handle(conn: net.Socket, msg: Req): Promise<void> {
    try {
      if (msg.op === 'list') {
        writeLine(conn, {
          id: msg.id,
          ok: true,
          tools: ctx.registry.list().map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })),
        });
        return;
      }
      if (msg.op === 'call') {
        const tool = ctx.registry.get(msg.name);
        if (!tool) {
          writeLine(conn, { id: msg.id, ok: false, error: 'unknown_tool: ' + msg.name });
          return;
        }
        const result = await tool.handler(ctx.toolCtx, msg.args ?? {});
        writeLine(conn, { id: msg.id, ok: true, result });
        // A call may have changed the active set (define/activate/rollback/retire).
        syncDynamicTools();
        return;
      }
      writeLine(conn, { id: (msg as { id: number }).id, ok: false, error: 'bad_op' });
    } catch (e) {
      writeLine(conn, { id: msg.id, ok: false, error: String((e as Error)?.message ?? e) });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve());
  });

  return {
    ctx,
    sockPath,
    close: async () => {
      server.close();
      await ctx.ctrl.disconnect();
    },
  };
}
