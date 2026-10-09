#!/usr/bin/env node
// Download the matching Fabric API release jar into a mods directory (from Modrinth).
// Fabric API is required by the mcagent mod on both the (integrated) server and the client.

import fs from 'node:fs';
import path from 'node:path';

const destDir = process.argv[2];
const gameVersion = process.argv[3] ?? '1.20.1';
if (!destDir) {
  console.error('usage: fetch-fabric-api.mjs <mods-dir> [gameVersion]');
  process.exit(2);
}
fs.mkdirSync(destDir, { recursive: true });

const url =
  'https://api.modrinth.com/v2/project/fabric-api/version?game_versions=' +
  encodeURIComponent(JSON.stringify([gameVersion])) +
  '&loaders=' +
  encodeURIComponent(JSON.stringify(['fabric']));

const versions = await (await fetch(url, { headers: { 'User-Agent': 'mcagent/1.0' } })).json();
if (!Array.isArray(versions) || versions.length === 0) {
  console.error('fetch-fabric-api: no fabric-api version found for', gameVersion);
  process.exit(1);
}
const v = versions[0];
const file = (v.files ?? []).find((f) => f.primary) ?? v.files?.[0];
if (!file?.url) {
  console.error('fetch-fabric-api: version has no downloadable file');
  process.exit(1);
}
const dest = path.join(destDir, file.filename);
if (fs.existsSync(dest)) {
  console.log('fetch-fabric-api: already present', file.filename);
  process.exit(0);
}
const res = await fetch(file.url, { headers: { 'User-Agent': 'mcagent/1.0' } });
if (!res.ok) {
  console.error('fetch-fabric-api: download failed', res.status);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(dest, buf);
console.log('fetch-fabric-api: installed', file.filename, `(${buf.length} bytes)`);
