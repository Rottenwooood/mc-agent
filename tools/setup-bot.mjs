#!/usr/bin/env node
// Runner-side setup / disturbance bot (op). Not exposed to the agent. It performs fixtures
// (place a vein, clear a build site) and external disturbances (dig a placed block).
//
//   node tools/setup-bot.mjs <mineflayer-dir> cmd <command...>
//   node tools/setup-bot.mjs <mineflayer-dir> dig <x> <y> <z>
//
// The first arg is a directory that can resolve `mineflayer` (the adapter package).

import path from 'node:path';

const [dir, mode, ...rest] = process.argv.slice(2);
if (!dir || !mode) {
  console.error('usage: setup-bot.mjs <dir-with-mineflayer> cmd|dig ...');
  process.exit(64);
}
const absDir = path.resolve(dir);
process.chdir(absDir);
const { createRequire } = await import('node:module');
const require = createRequire(path.join(absDir, 'setup-bot.cjs'));
const mineflayer = require('mineflayer');

const host = process.env.MC_HOST ?? '127.0.0.1';
const port = Number(process.env.MC_PORT ?? 25565);
const bot = mineflayer.createBot({ host, port, username: 'Setup', auth: 'offline', version: '1.20.1', disableChatSigning: true });

const done = (code) => setTimeout(() => process.exit(code), 200);
bot.on('kicked', (r) => { console.error('kicked', JSON.stringify(r)); done(1); });
bot.on('error', (e) => { console.error('error', String(e)); done(1); });

bot.once('spawn', async () => {
  try {
    if (mode === 'cmd') {
      const command = rest.join(' ');
      bot.chat(command.startsWith('/') ? command : '/' + command);
      await new Promise((r) => setTimeout(r, 700));
    } else if (mode === 'dig') {
      const x = Number(rest[0]);
      const y = Number(rest[1]);
      const z = Number(rest[2]);
      // Op self-teleport next to the target, then genuinely break it (so the event logs actor=Setup).
      bot.chat(`/tp Setup ${x} ${y + 2} ${z}`);
      await new Promise((r) => setTimeout(r, 900));
      const pos = new (require('vec3'))(x, y, z);
      const block = bot.blockAt(pos);
      if (!block) throw new Error('no block at ' + pos);
      await bot.dig(block, true);
      await new Promise((r) => setTimeout(r, 500));
    } else {
      throw new Error('unknown mode ' + mode);
    }
    bot.quit('done');
    done(0);
  } catch (e) {
    console.error('setup error', String(e));
    done(1);
  }
});
