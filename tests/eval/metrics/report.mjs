#!/usr/bin/env node
// M5 metrics: aggregate one or more benchmark reports (report.json) into the required metrics.
// Reports are produced by tests/eval/runner.mjs. Independent verifier verdicts drive completion.
//
//   node tests/eval/metrics/report.mjs /tmp/opencode/bench/report.json [more.json ...]
//
// Metrics: completion rate; non-pass split (timed_out / failed); cost (wall clock, tool events).
// (False-success rate needs a system-emitted task verdict channel; deferred.)

import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: report.mjs <report.json> [...]'); process.exit(64); }

const reports = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const episodes = reports.flatMap((r) => r.episodes ?? []);

const by = (key) => {
  const m = new Map();
  for (const e of episodes) {
    const k = e[key];
    if (!m.has(k)) m.set(k, { cases: 0, pass: 0, timedOut: 0, wallMs: 0, toolCalls: 0 });
    const g = m.get(k);
    g.cases += 1;
    if (e.pass) g.pass += 1;
    if (e.timedOut) g.timedOut += 1;
    g.wallMs += e.wallMs ?? 0;
    g.toolCalls += e.toolCalls ?? 0;
  }
  return Object.fromEntries([...m.entries()].map(([k, v]) => [k, { ...v, completionRate: v.cases ? v.pass / v.cases : 0 }]));
};

const cases = episodes.length;
const completed = episodes.filter((e) => e.pass).length;
const timedOut = episodes.filter((e) => e.timedOut).length;
const failed = episodes.filter((e) => !e.pass && !e.timedOut).length;

const out = {
  files,
  model: reports[0]?.model ?? null,
  cases,
  completed,
  completionRate: cases ? completed / cases : 0,
  nonPass: { timed_out: timedOut, failed },
  cost: {
    wallMs: episodes.reduce((a, e) => a + (e.wallMs ?? 0), 0),
    toolEvents: episodes.reduce((a, e) => a + (e.toolCalls ?? 0), 0),
  },
  byTask: by('task'),
  bySeed: by('seed'),
};
console.log(JSON.stringify(out, null, 2));
process.exit(0);
