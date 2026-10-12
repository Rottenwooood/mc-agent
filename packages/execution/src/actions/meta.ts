// Meta atomic actions (chat / commands).

import type { ActionResult } from '@mc-agent/contracts';
import { pass, fail } from '../result.js';
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

export const metaActions: AtomicAction[] = [chat, runCommand];
