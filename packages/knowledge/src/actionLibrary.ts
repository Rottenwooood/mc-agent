// Secondary-action library (二级动作库): named, versioned, CALLABLE compositions over the
// bounded vocabulary, with an online activation gate and version rollback.
//
// Design (approved 2026-10-09): online only — evidence comes from real use, never from an
// offline seed split. The system enforces the lifecycle; the agent only proposes transitions.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ActivationDecision,
  ActivationThresholds,
  AttemptOutcome,
  SecondaryActionAttempt,
  SecondaryActionDefinitionInput,
  SecondaryActionHistoryEntry,
  SecondaryActionRecord,
  SecondaryActionStats,
  SecondaryActionVersion,
  Method,
} from '@mc-agent/contracts';

export const DEFAULT_THRESHOLDS: ActivationThresholds = {
  minUses: 3,
  minPassRate: 0.6,
  recentWindow: 5,
  minRecentPassRate: 0.6,
};

const RECENT_CAP = 50;

const emptyStats = (): SecondaryActionStats => ({
  uses: 0,
  pass: 0,
  fail: 0,
  unknown: 0,
  recent: [],
  repairs: 0,
  regressions: 0,
  lastUsedAt: null,
});

const now = (): string => new Date().toISOString();

export interface ActionLibraryJSON {
  thresholds: ActivationThresholds;
  actions: SecondaryActionRecord[];
}

export interface SecondaryActionSummary {
  name: string;
  description: string;
  activeVersion: number | null;
  status: string;
  versions: number;
  uses: number;
  passRate: number;
  recentPassRate: number;
  rollbackRequired: boolean;
  params: string[];
}

/**
 * In-memory, JSON-persisted secondary-action library. Pure w.r.t. the world: the executor
 * records outcomes into it.
 */
export class ActionLibrary {
  private readonly actions = new Map<string, SecondaryActionRecord>();
  private readonly thresholds: ActivationThresholds;
  private readonly path?: string;

  constructor(opts: { thresholds?: Partial<ActivationThresholds>; actions?: SecondaryActionRecord[]; path?: string } = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
    for (const a of opts.actions ?? []) this.actions.set(a.name, a);
    if (opts.path) this.path = opts.path;
  }

  // ---- registration ----

  /** Register a new candidate version (status `draft`). Never edits an active version in place. */
  define(input: SecondaryActionDefinitionInput): SecondaryActionVersion {
    const existing = this.actions.get(input.name);
    const version = existing ? existing.versions.length + 1 : 1;
    const method: Method = {
      id: `${input.name}@${version}`,
      version,
      name: input.name,
      description: input.description,
      params: input.params ?? {},
      preconditions: input.preconditions ?? [],
      postconditions: input.postconditions ?? [],
      invariants: input.invariants ?? [],
      steps: input.steps,
      failurePolicy: { retry: 'safe_only', repair: 'local_step', onFail: 'hand_back' },
      provenance: { source: 'llm', created: now() },
    };
    const rec: SecondaryActionRecord =
      existing ?? { name: input.name, description: input.description ?? '', activeVersion: null, versions: [], history: [] };
    if (input.description) rec.description = input.description;
    rec.versions.push({ version, method, status: 'draft', stats: emptyStats() });
    rec.history.push({ at: now(), action: 'define', version });
    this.actions.set(input.name, rec);
    this.persist();
    return rec.versions[rec.versions.length - 1]!;
  }

  get(name: string): SecondaryActionRecord | undefined {
    return this.actions.get(name);
  }

  list(): SecondaryActionRecord[] {
    return [...this.actions.values()];
  }

  version(name: string, version: number): SecondaryActionVersion | undefined {
    return this.actions.get(name)?.versions.find((v) => v.version === version);
  }

  active(name: string): SecondaryActionVersion | undefined {
    const rec = this.actions.get(name);
    if (!rec || rec.activeVersion === null) return undefined;
    return rec.versions.find((v) => v.version === rec.activeVersion);
  }

  summary(): SecondaryActionSummary[] {
    return this.list().map((rec) => {
      const active = rec.activeVersion !== null ? rec.versions.find((v) => v.version === rec.activeVersion) : undefined;
      const s = active?.stats;
      return {
        name: rec.name,
        description: rec.description,
        activeVersion: rec.activeVersion,
        status: active?.status ?? 'draft',
        versions: rec.versions.length,
        uses: s?.uses ?? 0,
        passRate: s && s.uses > 0 ? s.pass / s.uses : 0,
        recentPassRate: recentPassRate(s?.recent ?? [], this.thresholds.recentWindow),
        rollbackRequired: !!rec.rollbackRequired,
        params: Object.keys(active?.method.params ?? {}),
      };
    });
  }

  // ---- outcome recording ----

  record(name: string, version: number, attempt: SecondaryActionAttempt): void {
    const v = this.version(name, version);
    if (!v) return;
    const s = v.stats;
    s.uses += 1;
    if (attempt.outcome === 'pass') s.pass += 1;
    else if (attempt.outcome === 'fail') s.fail += 1;
    else s.unknown += 1;
    s.recent.push(attempt.outcome);
    if (s.recent.length > RECENT_CAP) s.recent = s.recent.slice(-RECENT_CAP);
    if (attempt.repair) s.repairs += 1;
    if (attempt.regression) s.regressions += 1;
    s.lastUsedAt = attempt.at ?? now();

    // System marks rollback-required when the ACTIVE version regresses or fails twice in a row.
    const rec = this.actions.get(name)!;
    if (rec.activeVersion === version) {
      const last2 = s.recent.slice(-2);
      if (attempt.regression || (last2.length === 2 && last2.every((o) => o === 'fail'))) {
        rec.rollbackRequired = {
          version,
          reason: attempt.regression ? 'regression observed' : 'consecutive failures',
          at: s.lastUsedAt,
        };
      }
    }
    this.persist();
  }

  // ---- activation gate (online evidence only) ----

  evaluate(name: string, version: number): ActivationDecision {
    const v = this.version(name, version);
    const stats = v?.stats ?? emptyStats();
    if (!v) return { activate: false, version, reason: 'unknown version', stats };

    const reasons: string[] = [];
    const rate = stats.uses > 0 ? stats.pass / stats.uses : 0;
    const recent = recentPassRate(stats.recent, this.thresholds.recentWindow);
    if (stats.uses < this.thresholds.minUses) reasons.push(`uses ${stats.uses} < ${this.thresholds.minUses}`);
    else if (rate < this.thresholds.minPassRate) reasons.push(`pass rate ${rate.toFixed(2)} < ${this.thresholds.minPassRate}`);
    if (stats.recent.length > 0 && recent < this.thresholds.minRecentPassRate) reasons.push(`recent pass rate ${recent.toFixed(2)} < ${this.thresholds.minRecentPassRate}`);
    if (stats.regressions > stats.repairs) reasons.push(`net regressions (${stats.regressions} > ${stats.repairs})`);

    const activate = reasons.length === 0;
    return {
      activate,
      version,
      reason: activate ? `activated: uses ${stats.uses}, pass ${stats.pass}/${stats.uses}, recent ${(recent * 100).toFixed(0)}%` : reasons.join('; '),
      stats,
    };
  }

  /** Evaluate then, if it passes, activate. Previous active version becomes `superseded`. */
  activate(name: string, version: number): ActivationDecision {
    const d = this.evaluate(name, version);
    if (!d.activate) return d;
    const rec = this.actions.get(name);
    const v = this.version(name, version);
    if (!rec || !v) return { activate: false, version, reason: 'unknown', stats: d.stats };
    if (rec.activeVersion !== null && rec.activeVersion !== version) {
      const prev = rec.versions.find((x) => x.version === rec.activeVersion);
      if (prev) prev.status = 'superseded';
    }
    v.status = 'active';
    rec.activeVersion = version;
    delete rec.rollbackRequired;
    rec.history.push({ at: now(), action: 'activate', version, reason: d.reason });
    this.persist();
    return d;
  }

  // ---- rollback / retirement ----

  /** Active → `broken`; revert to the most recent `superseded` version (or none). */
  rollback(name: string, reason: string): boolean {
    const rec = this.actions.get(name);
    if (!rec) return false;
    const current = rec.activeVersion;
    const prev = [...rec.versions]
      .filter((v) => v.status === 'superseded' && (current === null || v.version < current))
      .sort((a, b) => b.version - a.version)[0];
    if (current !== null) {
      const cv = rec.versions.find((v) => v.version === current);
      if (cv) cv.status = 'broken';
    }
    rec.activeVersion = prev ? prev.version : null;
    if (prev) prev.status = 'active';
    delete rec.rollbackRequired;
    rec.history.push({ at: now(), action: 'rollback', version: current ?? 0, reason });
    this.persist();
    return true;
  }

  retire(name: string, reason: string): boolean {
    const rec = this.actions.get(name);
    if (!rec) return false;
    const version = rec.activeVersion ?? 0;
    if (rec.activeVersion !== null) {
      const v = rec.versions.find((x) => x.version === rec.activeVersion);
      if (v) v.status = 'retired';
    }
    rec.activeVersion = null;
    delete rec.rollbackRequired;
    rec.history.push({ at: now(), action: 'retire', version, reason });
    this.persist();
    return true;
  }

  history(name: string): SecondaryActionHistoryEntry[] {
    return this.actions.get(name)?.history ?? [];
  }

  // ---- persistence ----

  toJSON(): ActionLibraryJSON {
    return { thresholds: this.thresholds, actions: this.list() };
  }

  static fromJSON(data: ActionLibraryJSON): ActionLibrary {
    return new ActionLibrary({ thresholds: data.thresholds, actions: data.actions });
  }

  static load(path: string): ActionLibrary {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as ActionLibraryJSON;
      return new ActionLibrary({ thresholds: data.thresholds, actions: data.actions, path });
    } catch {
      return new ActionLibrary({ path });
    }
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.toJSON(), null, 2));
  }

  private persist(): void {
    if (this.path) this.save(this.path);
  }
}

function recentPassRate(recent: AttemptOutcome[], window: number): number {
  const w = recent.slice(-window);
  if (w.length === 0) return 1;
  return w.filter((o) => o === 'pass').length / w.length;
}
