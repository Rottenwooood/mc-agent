#!/usr/bin/env node
// G3 independent verifier. Re-derives the admission decision from the RAW per-seed attempt
// records (not by trusting the library's stored verdict) and checks the invariants the gate
// promises: train/val-only admission, held-out replay, and rollback of a bad version.
//
//   node tests/eval/g3-verifier.mjs [--skill get_wood] [--library /tmp/opencode/g3-skills.json]
// Exit: 0 = pass, 2 = fail, 64 = usage.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SKILL = opt('skill', 'get_wood');
const LIB = opt('library', process.env.MCAGENT_SKILLS ?? '/tmp/opencode/g3-skills.json');

const data = JSON.parse(readFileSync(LIB, 'utf8'));
const rec = (data.skills ?? []).find((s) => s.name === SKILL);
const fail = (msg, extra = {}) => { console.log(JSON.stringify({ pass: false, reason: msg, ...extra }, null, 2)); process.exit(2); };

if (!rec) fail('skill not found', { skill: SKILL });

const ver = (n) => rec.versions.find((v) => v.version === n);
const v1 = ver(1);
const v2 = ver(2);
if (!v1 || !v2) fail('missing version 1 or 2');

// Independent re-derivation from the raw seed->outcome map (roles kept separate).
const seedsByRole = (v, role) =>
  Object.entries(v.stats.seedOutcome)
    .filter(([k]) => k.startsWith(role + ':'))
    .map(([k, o]) => ({ seed: k.slice(role.length + 1), outcome: o }));
const passRate = (arr) => (arr.length ? arr.filter((x) => x.outcome === 'pass').length / arr.length : 0);

const v1Train = seedsByRole(v1, 'train');
const v1Val = seedsByRole(v1, 'val');
const v1Test = seedsByRole(v1, 'test');
const v2Val = seedsByRole(v2, 'val');
const v2Test = seedsByRole(v2, 'test');

const history = rec.history ?? [];
const has = (action, version) => history.some((h) => h.action === action && h.version === version);

const checks = {
  v1_admitted: has('admit', 1),
  v2_admitted: has('admit', 2),
  rollback_present: has('rollback', 2),
  // Seed isolation: the validation sets recorded for admission contain NO test seeds.
  val_seeds_exclude_test: !(v1.validation?.valSeeds ?? []).some((s) => v1Test.some((t) => t.seed === s)),
  train_seeds_exclude_test: !(v1.validation?.trainSeeds ?? []).some((s) => v1Test.some((t) => t.seed === s)),
  // Independent gate recompute for v1 (train+val only).
  v1_gate_would_admit: v1Train.some((x) => x.outcome === 'pass') && v1Val.length >= 2 && passRate(v1Val) >= 0.6,
  // Held-out replay: v1 passes on a test seed; v2 fails on a test seed.
  v1_test_pass: v1Test.some((x) => x.outcome === 'pass'),
  v2_test_fail: v2Test.some((x) => x.outcome === 'fail'),
  // Rollback effect: the bad version is marked broken and the good one is active again.
  v2_broken: v2.method.status === 'broken',
  active_is_v1: rec.activeVersion === 1,
};

const pass = Object.values(checks).every(Boolean);
console.log(
  JSON.stringify(
    {
      pass,
      skill: SKILL,
      activeVersion: rec.activeVersion,
      v1: { status: v1.method.status, train: v1Train, val: v1Val, test: v1Test },
      v2: { status: v2.method.status, val: v2Val, test: v2Test },
      history: history.map((h) => `${h.action}:${h.version}`),
      checks,
    },
    null,
    2,
  ),
);
process.exit(pass ? 0 : 2);
