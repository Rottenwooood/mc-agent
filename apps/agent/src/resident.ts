// Resident process: the single owner of the bot, world client, execution and tools.
// Bridges connect to it so any number of model sessions share one body (framework §0).

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createContext, type AppContext } from './context.js';
import { socketPath, type Req, type Res } from './protocol.js';

function writeLine(conn: net.Socket, msg: Res): void {
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

  const server = net.createServer((conn) => {
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
