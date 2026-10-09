#!/usr/bin/env node
// G3 independent verifier (online secondary-action lifecycle). Re-derives the activation gate
// from the RAW recorded stats (not by trusting the stored decision) and checks the invariants:
// online-only evidence, activation after enough real uses, and rollback of a regressed version.
//
//   node tests/eval/g3-verifier.mjs [--action get_wood] [--library /tmp/opencode/g3-actions.json]
// Exit: 0 = pass, 2 = fail.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const NAME = opt('action', 'get_wood');
const LIB = opt('library', process.env.MCAGENT_ACTIONS ?? '/tmp/opencode/g3-actions.json');

const data = JSON.parse(readFileSync(LIB, 'utf8'));
const th = data.thresholds ?? {};
const rec = (data.actions ?? []).find((a) => a.name === NAME);
const out = (o, code) => { console.log(JSON.stringify(o, null, 2)); process.exit(code); };
if (!rec) out({ pass: false, reason: 'action not found', action: NAME }, 2);

const ver = (n) => rec.versions.find((v) => v.version === n);
const v1 = ver(1);
const v2 = ver(2);
if (!v1 || !v2) out({ pass: false, reason: 'missing version 1 or 2' }, 2);

const rate = (s) => (s.uses ? s.pass / s.uses : 0);
const recentRate = (s) => {
  const w = (s.recent ?? []).slice(-(th.recentWindow ?? 5));
  return w.length ? w.filter((o) => o === 'pass').length / w.length : 1;
};
// Independent gate recompute (same policy, computed here, not read from the stored decision).
const gateWouldActivate = (s) =>
  s.uses >= (th.minUses ?? 3) &&
  rate(s) >= (th.minPassRate ?? 0.6) &&
  recentRate(s) >= (th.minRecentPassRate ?? 0.6) &&
  s.regressions <= s.repairs;

const history = rec.history ?? [];
const has = (action, version) => history.some((h) => h.action === action && h.version === version);
// online-only: no seed/role fields anywhere
const onlineOnly = !JSON.stringify(rec).match(/"seed"|"role"/);

const checks = {
  v1_defined: has('define', 1),
  v2_defined: has('define', 2),
  v1_activated: has('activate', 1),
  v2_activated: has('activate', 2),
  rollback_present: has('rollback', 2),
  v2_broken: v2.status === 'broken',
  active_is_v1: rec.activeVersion === 1,
  v1_enough_uses: v1.stats.uses >= 3 && v1.stats.pass >= 3,
  v1_gate_would_activate: gateWouldActivate(v1.stats),
  v2_gate_would_activate: gateWouldActivate(v2.stats),
  v2_has_failures: v2.stats.fail >= 2,
  online_only: onlineOnly,
};

const pass = Object.values(checks).every(Boolean);
out(
  {
    pass,
    action: NAME,
    activeVersion: rec.activeVersion,
    v1: { status: v1.status, uses: v1.stats.uses, pass: v1.stats.pass, fail: v1.stats.fail, recent: v1.stats.recent, repairs: v1.stats.repairs, regressions: v1.stats.regressions },
    v2: { status: v2.status, uses: v2.stats.uses, pass: v2.stats.pass, fail: v2.stats.fail, recent: v2.stats.recent, repairs: v2.stats.repairs, regressions: v2.stats.regressions },
    history: history.map((h) => `${h.action}:${h.version}`),
    checks,
  },
  pass ? 0 : 2,
);
