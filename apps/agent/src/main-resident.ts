// Entry point for the resident process.

import { startResident } from './resident.js';

const resident = await startResident();
console.error(`[resident] listening at ${resident.sockPath}; bot ${resident.ctx.username} connected`);

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
