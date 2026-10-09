// The skill library: named, versioned, validated methods; the promotion gate with hard
// train/val/test seed isolation; interventional net-effect counters; and version rollback.
//
// Design (framework §7, research 07 §3, research 10 §4):
//  - a skill is a Method plus stats/validation;
//  - admission requires the method to pass on TRAIN and on held-out VAL seeds (distinct seeds);
//  - TEST seeds are report-only and must never influence admission (enforced here);
//  - every promotion/rollback is versioned and reversible.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Method,
  PromotionDecision,
  PromotionThresholds,
  RoleStats,
  SeedRole,
  SkillAttempt,
  SkillDefinitionInput,
  SkillHistoryEntry,
  SkillRecord,
  SkillVersion,
  SkillVersionStats,
} from '@mc-agent/contracts';
import { SEED_ROLES } from '@mc-agent/contracts';

export const DEFAULT_THRESHOLDS: PromotionThresholds = {
  minValSeeds: 2,
  minTrainPassRate: 0.5,
  minValPassRate: 0.6,
};

const emptyRole = (): RoleStats => ({ attempts: 0, pass: 0, fail: 0, unknown: 0 });

const emptyStats = (): SkillVersionStats => ({
  attempts: 0,
  pass: 0,
  fail: 0,
  unknown: 0,
  byRole: { train: emptyRole(), val: emptyRole(), test: emptyRole() },
  seedOutcome: {},
  repairs: 0,
  regressions: 0,
  lastAt: null,
});

const now = (): string => new Date().toISOString();
const roleKey = (role: SeedRole, seed: string): string => `${role}:${seed}`;

export interface SkillLibraryJSON {
  thresholds: PromotionThresholds;
  skills: SkillRecord[];
}

export interface SkillSummary {
  name: string;
  description: string;
  activeVersion: number | null;
  versions: number;
  status: string;
  stats: SkillVersionStats | null;
  params: string[];
  postconditions: number;
}

/**
 * In-memory, JSON-persisted skill library. Pure with respect to the world: it never touches
 * game state — the executor records outcomes into it.
 */
export class SkillLibrary {
  private readonly skills = new Map<string, SkillRecord>();
  private readonly thresholds: PromotionThresholds;
  private readonly path?: string;

  constructor(opts: { thresholds?: Partial<PromotionThresholds>; skills?: SkillRecord[]; path?: string } = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
    for (const s of opts.skills ?? []) this.skills.set(s.name, s);
    if (opts.path) this.path = opts.path;
  }

  // ---- registration ----

  /** Register a new candidate version (status `draft`, provenance `llm`). */
  define(input: SkillDefinitionInput): SkillVersion {
    const existing = this.skills.get(input.name);
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
      stats: { success: 0, fail: 0, lastStatus: null, lastAt: null },
      status: 'draft',
      provenance: { source: 'llm', created: now() },
    };
    const rec: SkillRecord =
      existing ?? { name: input.name, description: input.description ?? '', activeVersion: null, versions: [], history: [] };
    if (input.description) rec.description = input.description;
    rec.versions.push({ version, method, stats: emptyStats(), validation: null });
    rec.history.push({ at: now(), action: 'define', version });
    this.skills.set(input.name, rec);
    this.persist();
    return rec.versions[rec.versions.length - 1]!;
  }

  get(name: string): SkillRecord | undefined {
    return this.skills.get(name);
  }

  list(): SkillRecord[] {
    return [...this.skills.values()];
  }

  version(name: string, version: number): SkillVersion | undefined {
    return this.skills.get(name)?.versions.find((v) => v.version === version);
  }

  active(name: string): SkillVersion | undefined {
    const rec = this.skills.get(name);
    if (!rec || rec.activeVersion === null) return undefined;
    return rec.versions.find((v) => v.version === rec.activeVersion);
  }

  /** Summaries for discovery (what the model sees). */
  summary(): SkillSummary[] {
    return this.list().map((rec) => {
      const active = rec.activeVersion !== null ? rec.versions.find((v) => v.version === rec.activeVersion) : undefined;
      return {
        name: rec.name,
        description: rec.description,
        activeVersion: rec.activeVersion,
        versions: rec.versions.length,
        status: active?.method.status ?? 'draft',
        stats: active?.stats ?? null,
        params: Object.keys(active?.method.params ?? {}),
        postconditions: active?.method.postconditions.length ?? 0,
      };
    });
  }

  // ---- outcome recording ----

  record(name: string, version: number, attempt: SkillAttempt): void {
    const v = this.version(name, version);
    if (!v) return;
    const s = v.stats;
    s.attempts += 1;
    s.byRole[attempt.role].attempts += 1;
    if (attempt.outcome === 'pass') {
      s.pass += 1;
      s.byRole[attempt.role].pass += 1;
    } else if (attempt.outcome === 'fail') {
      s.fail += 1;
      s.byRole[attempt.role].fail += 1;
    } else {
      s.unknown += 1;
      s.byRole[attempt.role].unknown += 1;
    }
    s.seedOutcome[roleKey(attempt.role, attempt.seed)] = attempt.outcome;
    if (attempt.repair) s.repairs += 1;
    if (attempt.regression) s.regressions += 1;
    s.lastAt = attempt.at ?? now();
    v.method.stats = { success: s.pass, fail: s.fail, lastStatus: attempt.outcome, lastAt: s.lastAt };
    this.persist();
  }

  // ---- admission gate ----

  /**
   * Evaluate a candidate for admission using TRAIN + VAL only. Distinct seeds decide (not
   * attempts). TEST seeds are ignored here by construction — they must never influence a
   * selection decision (seed isolation).
   */
  evaluate(name: string, version: number): PromotionDecision {
    const v = this.version(name, version);
    const train = v?.stats.byRole.train ?? emptyRole();
    const val = v?.stats.byRole.val ?? emptyRole();
    if (!v) return { admit: false, version, reason: 'unknown version', train, val };

    const trainRate = train.attempts > 0 ? train.pass / train.attempts : 0;
    const valSeedOutcomes = this.seedOutcomes(v, 'val');
    const valSeeds = valSeedOutcomes.length;
    const valPass = valSeedOutcomes.filter((o) => o.outcome === 'pass').length;
    const valRate = valSeeds > 0 ? valPass / valSeeds : 0;

    const reasons: string[] = [];
    if (train.attempts === 0) reasons.push('no train attempts');
    else if (trainRate < this.thresholds.minTrainPassRate) reasons.push(`train pass rate ${trainRate.toFixed(2)} < ${this.thresholds.minTrainPassRate}`);
    if (valSeeds < this.thresholds.minValSeeds) reasons.push(`only ${valSeeds} val seed(s) < ${this.thresholds.minValSeeds}`);
    else if (valRate < this.thresholds.minValPassRate) reasons.push(`val pass rate ${valRate.toFixed(2)} < ${this.thresholds.minValPassRate}`);

    const admit = reasons.length === 0;
    return {
      admit,
      version,
      reason: admit ? `admitted: train ${train.pass}/${train.attempts}, val ${valPass}/${valSeeds}` : reasons.join('; '),
      train,
      val,
    };
  }

  /** Evaluate then, if it passes, promote (status `verified`, becomes active). */
  promote(name: string, version: number): PromotionDecision {
    const d = this.evaluate(name, version);
    if (d.admit) this.admit(name, version, d.reason);
    return d;
  }

  private admit(name: string, version: number, reason: string): void {
    const rec = this.skills.get(name);
    const v = this.version(name, version);
    if (!rec || !v) return;
    v.method.status = 'verified';
    v.validation = {
      trainSeeds: this.seedOutcomes(v, 'train').map((o) => o.seed),
      valSeeds: this.seedOutcomes(v, 'val').map((o) => o.seed),
      passed: true,
      at: now(),
    };
    rec.activeVersion = version;
    rec.history.push({ at: now(), action: 'admit', version, reason });
    this.persist();
  }

  // ---- rollback / retirement ----

  /**
   * Roll the active version back to the most recent `verified` version before the current one
   * (or to no active version). Marks the current version `broken`. Reversible and versioned.
   */
  rollback(name: string, reason: string): boolean {
    const rec = this.skills.get(name);
    if (!rec) return false;
    const current = rec.activeVersion;
    const prev = [...rec.versions]
      .filter((v) => v.method.status === 'verified' && (current === null || v.version < current))
      .sort((a, b) => b.version - a.version)[0];
    if (current !== null) {
      const cv = rec.versions.find((v) => v.version === current);
      if (cv) cv.method.status = 'broken';
    }
    rec.activeVersion = prev ? prev.version : null;
    rec.history.push({ at: now(), action: 'rollback', version: current ?? 0, reason });
    this.persist();
    return true;
  }

  retire(name: string, reason: string): boolean {
    const rec = this.skills.get(name);
    if (!rec) return false;
    if (rec.activeVersion !== null) {
      const v = rec.versions.find((x) => x.version === rec.activeVersion);
      if (v) v.method.status = 'deprecated';
    }
    const version = rec.activeVersion ?? 0;
    rec.activeVersion = null;
    rec.history.push({ at: now(), action: 'retire', version, reason });
    this.persist();
    return true;
  }

  history(name: string): SkillHistoryEntry[] {
    return this.skills.get(name)?.history ?? [];
  }

  // ---- persistence ----

  toJSON(): SkillLibraryJSON {
    return { thresholds: this.thresholds, skills: this.list() };
  }

  static fromJSON(data: SkillLibraryJSON): SkillLibrary {
    return new SkillLibrary({ thresholds: data.thresholds, skills: data.skills });
  }

  static load(path: string): SkillLibrary {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as SkillLibraryJSON;
      return new SkillLibrary({ thresholds: data.thresholds, skills: data.skills, path });
    } catch {
      return new SkillLibrary({ path });
    }
  }

  static open(path: string): SkillLibrary {
    return SkillLibrary.load(path);
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.toJSON(), null, 2));
  }

  private persist(): void {
    if (this.path) this.save(this.path);
  }

  // ---- helpers ----

  private seedOutcomes(v: SkillVersion, role: SeedRole): { seed: string; outcome: string }[] {
    const prefix = role + ':';
    const out: { seed: string; outcome: string }[] = [];
    for (const [k, outcome] of Object.entries(v.stats.seedOutcome)) {
      if (k.startsWith(prefix)) out.push({ seed: k.slice(prefix.length), outcome });
    }
    return out;
  }
}

/** All seed roles (for callers that need to validate isolation explicitly). */
export const seedRoles = SEED_ROLES;
