// Thin MCP stdio bridge: ensures the resident is running, then forwards tools/list and
// tools/call over the Unix socket. It holds no execution logic (framework §0).
//
// The resident is long-lived and may be restarted (code changes), so the bridge reconnects
// on demand: if the socket closes, pending calls reject and the next request re-attaches.

import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { socketPath, type Req, type Res, type ToolSummary } from './protocol.js';

const log = (...a: unknown[]) => console.error('[bridge]', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tryConnect(sockPath: string, timeoutMs = 800): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const s = net.connect(sockPath);
    let done = false;
    const finish = (v: net.Socket | null) => {
      if (done) return;
      done = true;
      if (v) s.off('error', onErr);
      resolve(v);
    };
    const onErr = () => {
      s.destroy();
      finish(null);
    };
    s.once('error', onErr);
    s.once('connect', () => finish(s));
    setTimeout(() => {
      if (!done) {
        s.destroy();
        finish(null);
      }
    }, timeoutMs);
  });
}

async function connectResident(sockPath: string): Promise<net.Socket> {
  let s = await tryConnect(sockPath);
  if (s) return s;
  if (process.env.MCAGENT_SPAWN !== '0') {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const residentMain = path.join(here, 'main-resident.js');
    log('no resident; spawning', residentMain);
    const child = spawn(process.execPath, [residentMain], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  }
  for (let i = 0; i < 100; i++) {
    await sleep(250);
    s = await tryConnect(sockPath);
    if (s) return s;
  }
  throw new Error('resident did not come up at ' + sockPath);
}

interface Pending {
  resolve: (m: Res) => void;
  reject: (e: Error) => void;
}

class ResidentClient {
  private sock: net.Socket | null = null;
  private buf = '';
  private readonly pending = new Map<number, Pending>();
  private id = 1;
  private attaching: Promise<void> | null = null;

  constructor(private readonly sockPath: string) {}

  private async attach(): Promise<void> {
    const sock = await connectResident(this.sockPath);
    this.sock = sock;
    this.buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => this.onData(String(d)));
    sock.on('error', () => this.onClose());
    sock.on('close', () => this.onClose());
  }

  private async ensure(): Promise<void> {
    if (this.sock) return;
    if (!this.attaching) {
      this.attaching = this.attach().finally(() => {
        this.attaching = null;
      });
    }
    await this.attaching;
  }

  private onClose(): void {
    this.sock = null;
    const err = new Error('resident disconnected');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m: Res;
      try {
        m = JSON.parse(line) as Res;
      } catch {
        continue;
      }
      const cb = this.pending.get(m.id);
      if (cb) {
        this.pending.delete(m.id);
        cb.resolve(m);
      }
    }
  }

  private attempt(op: 'list' | 'call', name?: string, args?: Record<string, unknown>): Promise<Res> {
    const sock = this.sock;
    if (!sock) return Promise.reject(new Error('resident disconnected'));
    const id = this.id++;
    const msg: Req = op === 'list' ? { id, op: 'list' } : { id, op: 'call', name: name ?? '', args: args ?? {} };
    sock.write(JSON.stringify(msg) + '\n');
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('resident timeout: ' + op));
      }, 300000);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  async request(op: 'list' | 'call', name?: string, args?: Record<string, unknown>): Promise<Res> {
    await this.ensure();
    try {
      return await this.attempt(op, name, args);
    } catch (e) {
      // One reconnect+retry when the resident connection dropped (e.g. resident restart).
      if (!this.sock || String((e as Error).message).includes('disconnected')) {
        await this.ensure();
        return await this.attempt(op, name, args);
      }
      throw e;
    }
  }
}

export async function startBridge(): Promise<void> {
  const sockPath = socketPath();
  const client = new ResidentClient(sockPath);

  const server = new Server({ name: 'mc-agent', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const r = await client.request('list');
    if (r.ok && 'tools' in r) return { tools: r.tools as unknown as ToolSummary[] };
    return { tools: [] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const r = await client.request('call', name, args);
    if (!r.ok || !('result' in r)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ tool: name, effectStatus: 'unobservable', controlStatus: 'needs_replan', reason: 'resident_error', error: (r as { error?: string }).error }) }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ tool: name, ...(r.result as Record<string, unknown>) }) }], isError: false };
  });

  await server.connect(new StdioServerTransport());
  log('bridge ready -> resident at ' + sockPath);
}
