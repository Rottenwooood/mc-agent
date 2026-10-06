'use strict';

// Thin client for the read-only Fabric observer mod (authoritative server facts).
const BASE = process.env.MCAGENT_OBSERVER || 'http://127.0.0.1:8765';

async function get(path) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  if (!res.ok) throw new Error(`observer ${res.status}: ${text}`);
  return JSON.parse(text);
}

const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

module.exports = {
  BASE,
  health: () => get('/health'),
  self: (player) => get('/self?' + q({ player })),
  block: (x, y, z) => get('/block?' + q({ x, y, z })),
  nearest: (player, block, r = 32) => get('/nearest?' + q({ player, block, r })),
  blocks: (x, y, z, r = 8, limit = 512) => get('/blocks?' + q({ x, y, z, r, limit })),
  events: (since = 0, max = 256) => get('/events?' + q({ since, max })),
};
