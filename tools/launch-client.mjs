#!/usr/bin/env node
// Minimal launcher for the Axolotl-managed Fabric client profile. It reads the resolved version
// manifest that the launcher already downloaded (libraries / client jar / assets / natives) and
// starts Minecraft, optionally auto-connecting to a server via --quickPlayMultiplayer.
//
// This exists so the agent can start the real client reproducibly (no GUI clicking) for the
// client-controller adapter. It does not download anything; everything must already be present.
//
// Usage:
//   node tools/launch-client.mjs [--profile <dir>] [--server host:port] [--username NAME]
//                                [--version 1.20.1-0.19.5] [--width N --height N] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const HOME = os.homedir();
const AXOLOTL = process.env.MCAGENT_AXOLOTL ?? path.join(HOME, '.local/share/red.ghs.axolotl');
const META = path.join(AXOLOTL, 'meta');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const version = args.version ?? '1.20.1-0.19.5';
const profileDir = path.resolve(
  args.profile ?? path.join(AXOLOTL, 'profiles/1.20.1-Fabric 0.19.5'),
);
const versionDir = path.join(META, 'versions', version);
const versionJson = path.join(versionDir, `${version}.json`);
const assetsDir = path.join(META, 'assets');
const librariesDir = path.join(META, 'libraries');
const username = args.username ?? 'Agent';
const server = typeof args.server === 'string' ? args.server : null;

if (!fs.existsSync(versionJson)) {
  console.error(`launch-client: missing version manifest ${versionJson}`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(versionJson, 'utf8'));

// ---- OS/feature rule evaluation ----------------------------------------------------------

const osName = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';
const osArch = { x64: 'x86_64', arm64: 'arm64', ia32: 'x86' }[process.arch] ?? process.arch;

function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== osName) return false;
    if (rule.os.arch && rule.os.arch !== osArch) return false;
    if (rule.os.version && !new RegExp(rule.os.version).test(os.release())) return false;
  }
  if (rule.features) {
    for (const [k, v] of Object.entries(rule.features)) {
      if ((features[k] ?? false) !== v) return false;
    }
  }
  return true;
}

function allowed(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let ok = false;
  for (const r of rules) {
    if (ruleMatches(r, features)) ok = r.action === 'allow';
  }
  return ok;
}

// ---- classpath ----------------------------------------------------------------------------

const classpath = [];
const missingLibs = [];
let clientJar = null;

function mavenPath(name) {
  const parts = String(name).split(':');
  const [group, artifact, version, classifier] = parts;
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.jar`;
  return path.join(librariesDir, group.replace(/\./g, '/'), artifact, version, file);
}

for (const lib of manifest.libraries ?? []) {
  if (!allowed(lib.rules)) continue;
  const art = lib.downloads?.artifact;
  const p = art?.path ? path.join(librariesDir, art.path) : lib.name ? mavenPath(lib.name) : null;
  if (p && fs.existsSync(p)) {
    classpath.push(p);
  } else if (p) {
    missingLibs.push(p);
  }
}
// The client jar sits next to the manifest.
for (const cand of [`${version}.jar`, 'client.jar']) {
  const p = path.join(versionDir, cand);
  if (fs.existsSync(p)) {
    clientJar = p;
    break;
  }
}
if (!clientJar) {
  console.error(`launch-client: no client jar in ${versionDir}`);
  process.exit(2);
}
classpath.push(clientJar);

// ---- natives (flatten any .so we find into a temp dir) -------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcagent-natives-'));
const nativeSrc = args.natives ?? path.join(META, 'natives', version, osName, process.arch === 'x64' ? 'x64' : process.arch);
function copyNatives(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) copyNatives(p);
    else if (entry.name.endsWith('.so') || entry.name.endsWith('.dylib') || entry.name.endsWith('.dll')) {
      fs.copyFileSync(p, path.join(tmp, entry.name));
    }
  }
}
copyNatives(nativeSrc);
// Also pull natives out of the -natives-* jars on the classpath (belt and braces).
for (const jar of classpath) {
  if (!/-natives-/.test(path.basename(jar))) continue;
  try {
    execFileSync('unzip', ['-o', '-j', jar, '*.so', '-d', tmp], { stdio: 'ignore' });
  } catch {
    /* no .so in this jar */
  }
}

// ---- auth (offline) ------------------------------------------------------------------------

function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const subs = {
  natives_directory: tmp,
  launcher_name: 'mcagent',
  launcher_version: '1.0',
  classpath: classpath.join(path.delimiter),
  auth_player_name: username,
  version_name: version,
  game_directory: profileDir,
  assets_root: assetsDir,
  assets_index_name: manifest.assetIndex?.id ?? manifest.assets ?? '5',
  auth_uuid: offlineUuid(username).replace(/-/g, ''),
  auth_access_token: '0',
  clientid: '',
  auth_xuid: '',
  user_type: 'legacy',
  version_type: 'release',
  resolution_width: args.width ?? '854',
  resolution_height: args.height ?? '480',
};

function subst(s) {
  return String(s).replace(/\$\{([^}]+)\}/g, (_, k) => (k in subs ? subs[k] : ''));
}

const features = {
  is_demo_user: false,
  has_custom_resolution: Boolean(args.width || args.height),
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: Boolean(server),
  is_quick_play_realms: false,
};

function collect(list) {
  const out = [];
  for (const entry of list ?? []) {
    if (typeof entry === 'string') {
      out.push(subst(entry));
    } else if (entry && entry.value !== undefined && allowed(entry.rules, features)) {
      const v = Array.isArray(entry.value) ? entry.value : [entry.value];
      for (const x of v) out.push(subst(x));
    }
  }
  return out;
}

const jvmArgs = collect(manifest.arguments?.jvm);
const gameArgs = collect(manifest.arguments?.game);
if (server && !gameArgs.includes('--quickPlayMultiplayer')) {
  gameArgs.push('--quickPlayMultiplayer', server);
}
// Fixed window + no demo; keep it simple.
const memArgs = [`-Xmx${args.xmx ?? '2G'}`, `-Xms${args.xms ?? '512M'}`];

const javaBin = args.java ?? path.join(META, 'java_versions', 'mojang-java-runtime-gamma-linux-71651340afda', 'bin', 'java');
const mainClass = manifest.mainClass ?? 'net.fabricmc.loader.impl.launch.knot.KnotClient';
const finalArgs = [...memArgs, ...jvmArgs, mainClass, ...gameArgs];

if (args['dry-run']) {
  console.log('java', javaBin);
  console.log('gameDir', profileDir);
  console.log('classpath entries', classpath.length, 'clientJar', clientJar);
  if (missingLibs.length) console.log('missing libs:\n  ' + missingLibs.join('\n  '));
  console.log('natives', tmp);
  console.log('args', finalArgs.join(' '));
  process.exit(0);
}

console.log(`[launch-client] java=${javaBin}`);
console.log(`[launch-client] gameDir=${profileDir} server=${server ?? '(none)'} user=${username}`);
const child = spawn(javaBin, finalArgs, { cwd: profileDir, stdio: 'inherit', env: process.env });
child.on('exit', (code) => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(code ?? 0);
});
