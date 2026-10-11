// Entry point for the resident process.

import { startResident } from './resident.js';

const resident = await startResident();
console.error(`[resident] listening at ${resident.sockPath} (user ${resident.ctx.username}; body connecting…)`);

const stop = async () => {
  try {
    await resident.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop);
