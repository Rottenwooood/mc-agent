// Meta atomic actions (chat / commands).

import type { ActionResult, ConnectOptions } from '@mc-agent/contracts';
import { mk, pass, fail } from '../result.js';
import type { AtomicAction } from './types.js';
import { contract } from './types.js';

const chat: AtomicAction = {
  contract: contract({
    name: 'chat',
    description: 'Send a chat message (or /command) as the bot. Server permission applies (control action).',
    params: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
    controlOnly: true,
  }),
  async run(ctx, args): Promise<ActionResult> {
    const r = await ctx.ctrl.chat(String(args.message));
    return r.accepted ? pass({ evidence: [{ claim: 'chat_sent', source: 'observed' }], attribution: 'self_temporal' }) : fail('effect_not_observed', { reasonDetail: r.note });
  },
};

const runCommand: AtomicAction = {
  contract: contract({
    name: 'run_command',
    description:
      'Run a Minecraft command as the bot (control action — the server decides permission and effect; this tool does not verify the outcome, but any world change still appears in `changes`).',
    params: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    effectClass: 'consumable',
    controlOnly: true,
  }),
  async run(ctx, args): Promise<ActionResult> {
    const r = await ctx.ctrl.runCommand(String(args.command));
    return r.accepted ? pass({ evidence: [{ claim: 'command_sent', source: 'observed' }] }) : fail('effect_not_observed', { reasonDetail: r.note });
  },
};

// ---- body lifecycle (join / leave the server) ----

const joinServer: AtomicAction = {
  contract: contract({
    name: 'join_server',
    description:
      'Join (or rejoin) a game server as the body — use after a disconnect, a kick or a server restart (the body does not auto-reconnect), or to switch server/identity. Pass server/username/version to override the configured target; omit them to rejoin the configured server (no-op if already there). Control action: no world effect claimed.',
    params: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'host[:port], e.g. 127.0.0.1:25565 (default: the configured server)' },
        username: { type: 'string', description: 'bot/player name (default: the configured user)' },
        version: { type: 'string', description: 'protocol version, e.g. 1.20.1 (default: configured)' },
      },
      additionalProperties: false,
    },
    effectClass: 'idempotent',
    controlOnly: true,
  }),
  async run(ctx, args): Promise<ActionResult> {
    const st = await ctx.ctrl.bodyState();
    if (!st.controllable) {
      return fail('precondition_failed', { reasonDetail: 'this control backend does not control join/leave (a real client is joined by the human)' });
    }
    const opts: ConnectOptions = {};
    if (typeof args.server === 'string' && args.server) {
      const [host, port] = args.server.split(':');
      if (host) opts.host = host;
      if (port && Number.isFinite(Number(port))) opts.port = Number(port);
    }
    if (typeof args.username === 'string' && args.username) opts.username = args.username;
    if (typeof args.version === 'string' && args.version) opts.version = args.version;
    // Any explicit target/identity means "(re)join THIS" — not the idempotent no-op path.
    const switching = Object.keys(opts).length > 0;
    if (st.connected && !switching) return mk({ effectStatus: 'no_op', reason: null, reasonDetail: 'already connected' });
    try {
      if (st.connected) await ctx.ctrl.disconnect(); // switching target/identity requires leaving first
      await ctx.ctrl.connect(opts);
      const after = await ctx.ctrl.bodyState();
      return pass({ evidence: [{ claim: 'body_connected', source: 'observed', value: after }], data: after });
    } catch (e) {
      return fail('effect_not_observed', { reasonDetail: `join failed: ${String((e as Error)?.message ?? e)}` });
    }
  },
};

const leaveServer: AtomicAction = {
  contract: contract({
    name: 'leave_server',
    description:
      'Leave the game server (disconnect the body). Control action: it does not claim a world effect. (No-op if not connected; unsupported on a backend that does not control join/leave.)',
    params: { type: 'object', properties: {}, additionalProperties: false },
    effectClass: 'idempotent',
    controlOnly: true,
  }),
  async run(ctx): Promise<ActionResult> {
    const st = await ctx.ctrl.bodyState();
    if (!st.controllable) {
      return fail('precondition_failed', { reasonDetail: 'this control backend does not control join/leave (a real client is joined/left by the human)' });
    }
    if (!st.connected) return mk({ effectStatus: 'no_op', reason: null, reasonDetail: 'not connected' });
    try {
      await ctx.ctrl.disconnect();
      return pass({ evidence: [{ claim: 'body_disconnected', source: 'observed' }] });
    } catch (e) {
      return fail('effect_not_observed', { reasonDetail: `leave failed: ${String((e as Error)?.message ?? e)}` });
    }
  },
};

export const metaActions: AtomicAction[] = [chat, runCommand, joinServer, leaveServer];
